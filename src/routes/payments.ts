import { Hono } from 'hono';
import Stripe from 'stripe';
import type { Context } from 'hono';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv, AuthUser } from '../types';
import { getDB } from '../lib/db';
import { logger } from '../lib/logger';
import { AppError, NotFoundError, ValidationError } from '../lib/errors';
import { eventBus } from '../lib/eventBus';

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
  type: string;
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

  if (!tripId || !amount) {
    throw new ValidationError('tripId and amount are required');
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

  // Handle different event types
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const { tripId, userId, bookingId } = paymentIntent.metadata;

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
      const { bookingId } = paymentIntent.metadata;

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
      const { bookingId } = paymentIntent.metadata;

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
