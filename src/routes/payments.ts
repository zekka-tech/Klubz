import { Hono } from 'hono';
import Stripe from 'stripe';
import type { Context } from 'hono';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv, AuthUser } from '../types';
import { getDB } from '../lib/db';
import { logger } from '../lib/logger';
import { AppError, NotFoundError, ValidationError } from '../lib/errors';
import { eventBus } from '../lib/eventBus';
import { createNotification } from '../lib/notificationStore';

export const paymentRoutes = new Hono<AppEnv>();

// All payment routes require authentication
paymentRoutes.use('*', authMiddleware());

interface CreateIntentBody {
  tripId: number | string;
  amount: number;
}

interface BookingRow {
  id: number;
  title: string;
}

interface StripeWebhookEvent {
  id: string;
  type: string;
  created?: number;
  data: {
    object: {
      id: string;
      amount: number;
      metadata: {
        tripId?: string;
        userId?: string;
        bookingId?: string;
      };
      last_payment_error?: { message?: string };
    };
  };
}

function parseError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}

async function isReplayEvent(c: Context<AppEnv>, eventId: string): Promise<boolean> {
  const cache = c.env?.CACHE;
  if (!cache) return false;

  const key = `stripe:webhook:event:${eventId}`;
  const existing = await cache.get(key, 'text');
  if (existing) return true;

  // Keep event IDs for 7 days to prevent replay processing.
  await cache.put(key, 'processed', { expirationTtl: 7 * 24 * 60 * 60 });
  return false;
}

function getRequiredMetadata(
  paymentIntent: StripeWebhookEvent['data']['object'],
  requiredKeys: Array<'tripId' | 'userId' | 'bookingId'>,
): Record<'tripId' | 'userId' | 'bookingId', string> | null {
  const metadata = paymentIntent.metadata ?? {};
  const out = {
    tripId: metadata.tripId || '',
    userId: metadata.userId || '',
    bookingId: metadata.bookingId || '',
  };

  for (const key of requiredKeys) {
    if (!out[key]) return null;
  }
  return out;
}

/**
 * Get Stripe instance if configured
 */
function getStripe(c: Context<AppEnv>) {
  if (!c.env?.STRIPE_SECRET_KEY) {
    return null;
  }
  return new Stripe(c.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
  });
}

// ---------------------------------------------------------------------------
// POST /intent - Create payment intent for booking
// ---------------------------------------------------------------------------

paymentRoutes.post('/intent', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json<CreateIntentBody>();
  const { tripId, amount } = body;

  if (!tripId || typeof amount !== 'number') {
    throw new ValidationError('tripId and amount are required');
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new ValidationError('amount must be a valid number between 0 and 100000');
  }

  const stripe = getStripe(c);
  if (!stripe) {
    throw new AppError('Payment processing not configured', 'PAYMENT_UNAVAILABLE', 503);
  }

  const db = getDB(c);

  // Verify trip exists and user has an accepted booking
  const booking = await db.prepare(`
    SELECT tp.id, t.price_per_seat, t.title, t.driver_id
    FROM trip_participants tp
    JOIN trips t ON tp.trip_id = t.id
    WHERE tp.trip_id = ? AND tp.user_id = ? AND tp.status = 'accepted'
  `).bind(tripId, user.id).first<BookingRow>();

  if (!booking) {
    throw new NotFoundError('Accepted booking for this trip');
  }

  try {
    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'zar',
      metadata: {
        tripId: tripId.toString(),
        userId: user.id.toString(),
        bookingId: booking.id.toString(),
      },
      description: `Payment for trip: ${booking.title}`,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Store payment intent ID in booking
    await db.prepare(`
      UPDATE trip_participants
      SET payment_intent_id = ?, payment_status = 'pending'
      WHERE id = ?
    `).bind(paymentIntent.id, booking.id).run();

    logger.info('Payment intent created', {
      paymentIntentId: paymentIntent.id,
      userId: user.id,
      tripId,
      amount,
    });

    return c.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Payment intent creation failed', {
      error: parsed.message,
      userId: user.id,
      tripId,
    });
    throw new AppError('Failed to create payment intent', 'PAYMENT_ERROR', 500);
  }
});

// ---------------------------------------------------------------------------
// POST /webhook - Stripe webhook handler
// ---------------------------------------------------------------------------

paymentRoutes.post('/webhook', async (c) => {
  const stripe = getStripe(c);
  if (!stripe) {
    throw new AppError('Stripe not configured', 'PAYMENT_UNAVAILABLE', 503);
  }

  const signature = c.req.header('stripe-signature');
  if (!signature) {
    throw new ValidationError('Missing stripe-signature header');
  }

  const body = await c.req.text();
  const webhookSecret = c.env?.STRIPE_WEBHOOK_SECRET;
  const isProduction = c.env?.ENVIRONMENT === 'production';

  if (!webhookSecret && isProduction) {
    throw new AppError(
      'Stripe webhook secret is required in production',
      'CONFIGURATION_ERROR',
      500,
    );
  }

  if (!webhookSecret) {
    logger.warn('Stripe webhook secret not configured, skipping signature verification');
  }

  let event: StripeWebhookEvent;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret) as unknown as StripeWebhookEvent;
    } else {
      event = JSON.parse(body) as StripeWebhookEvent;
    }
  } catch (err: unknown) {
    logger.error('Webhook signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ValidationError('Invalid webhook signature');
  }

  const db = getDB(c);

  if (!event.id) {
    throw new ValidationError('Missing event id');
  }
  if (await isReplayEvent(c, event.id)) {
    logger.info('Ignoring replayed Stripe webhook event', { eventId: event.id, eventType: event.type });
    return c.json({ received: true, replay: true });
  }

  // Handle different event types
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['tripId', 'userId', 'bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe success event with missing metadata', {
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        return c.json({ received: true, ignored: true, reason: 'missing_metadata' });
      }
      const { tripId, userId, bookingId } = metadata;

      try {
        await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'paid', payment_completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(bookingId).run();

        logger.info('Payment succeeded', {
          paymentIntentId: paymentIntent.id,
          userId,
          tripId,
          amount: paymentIntent.amount / 100,
        });

        // Emit event for real-time notifications
        eventBus.emit('payment:succeeded', {
          tripId,
          userId,
          bookingId,
          amount: paymentIntent.amount / 100,
        });

        const recipientId = Number.parseInt(userId, 10);
        const tripIdNum = Number.parseInt(tripId, 10);
        if (Number.isFinite(recipientId)) {
          try {
            await createNotification(db, {
              userId: recipientId,
              tripId: Number.isFinite(tripIdNum) ? tripIdNum : null,
              notificationType: 'payment_succeeded',
              channel: 'in_app',
              status: 'sent',
              subject: 'Payment successful',
              message: 'Your trip payment was successful.',
              metadata: { bookingId, paymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 },
            });
          } catch (err) {
            logger.warn('Failed to persist payment succeeded notification', {
              error: err instanceof Error ? err.message : String(err),
              bookingId,
            });
          }
        }
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          error: parsed.message,
          bookingId,
        });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe payment_failed event with missing metadata', {
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        return c.json({ received: true, ignored: true, reason: 'missing_metadata' });
      }
      const { bookingId } = metadata;

      try {
        await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'failed'
          WHERE id = ?
        `).bind(bookingId).run();

        logger.warn('Payment failed', {
          paymentIntentId: paymentIntent.id,
          bookingId,
          reason: paymentIntent.last_payment_error?.message,
        });

        eventBus.emit('payment:failed', {
          bookingId,
          reason: paymentIntent.last_payment_error?.message,
        });

        const booking = await db.prepare('SELECT user_id, trip_id FROM trip_participants WHERE id = ?').bind(bookingId).first<{ user_id: number; trip_id: number }>();
        if (booking) {
          try {
            await createNotification(db, {
              userId: booking.user_id,
              tripId: booking.trip_id,
              notificationType: 'payment_failed',
              channel: 'in_app',
              status: 'sent',
              subject: 'Payment failed',
              message: paymentIntent.last_payment_error?.message || 'Your trip payment failed. Please try again.',
              metadata: { bookingId, paymentIntentId: paymentIntent.id },
            });
          } catch (err) {
            logger.warn('Failed to persist payment failed notification', {
              error: err instanceof Error ? err.message : String(err),
              bookingId,
            });
          }
        }
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          error: parsed.message,
          bookingId,
        });
      }
      break;
    }

    case 'payment_intent.canceled': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe canceled event with missing metadata', {
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        return c.json({ received: true, ignored: true, reason: 'missing_metadata' });
      }
      const { bookingId } = metadata;

      try {
        await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'canceled'
          WHERE id = ?
        `).bind(bookingId).run();

        logger.info('Payment canceled', {
          paymentIntentId: paymentIntent.id,
          bookingId,
        });
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          error: parsed.message,
          bookingId,
        });
      }
      break;
    }

    default:
      logger.debug('Unhandled webhook event type', { eventType: event.type });
  }

  return c.json({ received: true });
});

export default paymentRoutes;
