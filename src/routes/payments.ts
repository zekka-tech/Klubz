import { Hono } from 'hono';
import type { Context } from 'hono';
import { StripeService } from '../integrations/stripe';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv, AuthUser, D1Database } from '../types';
import { getDB } from '../lib/db';
import { logger } from '../lib/logger';
import { AppError, NotFoundError, ValidationError } from '../lib/errors';
import { eventBus } from '../lib/eventBus';
import { createNotification } from '../lib/notificationStore';
import { getUserNotificationPreferences } from '../lib/userPreferences';
import { withRequestContext } from '../lib/observability';

export const paymentRoutes = new Hono<AppEnv>();

interface CreateIntentBody {
  tripId: number | string;
  amount: number;
}

interface BookingRow {
  id: number;
  title: string;
  price_per_seat: number;
  payment_intent_id: string | null;
  payment_status: string | null;
}

interface BookingPaymentContextRow {
  user_id: number;
  trip_id: number;
  payment_intent_id: string | null;
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

interface D1RunResult {
  meta?: {
    changes?: number;
  };
}

interface ProcessedWebhookEventRow {
  event_id: string;
}

interface IdempotencyRecordRow {
  response_json: string | null;
}

interface PaymentIntentResponse {
  clientSecret: string | null;
  paymentIntentId: string;
  amount: number;
  currency: string;
  replay?: boolean;
}

function parseError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}

function getAffectedRows(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const meta = (result as D1RunResult).meta;
  if (!meta || typeof meta !== 'object' || typeof meta.changes !== 'number') return null;
  return meta.changes;
}

function getIdempotencyKey(c: Context<AppEnv>, userId: number, tripId: number | string): string | null {
  const requestKey = c.req.header('Idempotency-Key') || c.req.header('idempotency-key');
  if (!requestKey) return null;
  return `idempotency:payment-intent:${userId}:${tripId}:${requestKey}`;
}

async function getIdempotentPaymentIntentResponse(c: Context<AppEnv>, key: string): Promise<PaymentIntentResponse | null> {
  const cache = c.env?.CACHE;
  if (cache) {
    try {
      const cached = await cache.get(key, 'json');
      if (!cached || typeof cached !== 'object') return null;
      const response = cached as PaymentIntentResponse;
      if (!response.paymentIntentId || typeof response.paymentIntentId !== 'string') return null;
      return response;
    } catch (err: unknown) {
      logger.warn('Payment intent cache read failed', {
        ...withRequestContext(c, { key }),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const db = c.env?.DB;
  if (!db) return null;
  try {
    const row = await db.prepare('SELECT response_json FROM idempotency_records WHERE idempotency_key = ?')
      .bind(key)
      .first<IdempotencyRecordRow>();
    if (!row?.response_json) return null;
    const parsed = JSON.parse(row.response_json) as PaymentIntentResponse;
    if (!parsed.paymentIntentId || typeof parsed.paymentIntentId !== 'string') return null;
    return parsed;
  } catch (err: unknown) {
    logger.warn('Failed to read idempotent payment intent response', {
      ...withRequestContext(c),
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function setIdempotentPaymentIntentResponse(c: Context<AppEnv>, key: string, response: PaymentIntentResponse): Promise<void> {
  const cache = c.env?.CACHE;
  const responseJson = JSON.stringify(response);
  if (cache) {
    try {
      await cache.put(key, responseJson, { expirationTtl: 10 * 60 });
    } catch (err: unknown) {
      logger.warn('Payment intent cache write failed', {
        ...withRequestContext(c, { key }),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const db = c.env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO idempotency_records (idempotency_key, response_json, created_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(key, responseJson).run();
  } catch (err: unknown) {
    logger.warn('Failed to persist idempotent payment intent response', {
      ...withRequestContext(c),
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function isReplayEvent(c: Context<AppEnv>, eventId: string): Promise<boolean> {
  const cache = c.env?.CACHE;
  if (cache) {
    const key = `stripe:webhook:event:${eventId}`;
    try {
      const existing = await cache.get(key, 'text');
      if (existing) return true;
    } catch (err: unknown) {
      logger.warn('Webhook replay cache read failed', {
        ...withRequestContext(c, { eventId }),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const db = c.env?.DB;
  if (!db) return false;

  try {
    const existing = await db.prepare('SELECT event_id FROM processed_webhook_events WHERE event_id = ?')
      .bind(eventId)
      .first<ProcessedWebhookEventRow>();
    return Boolean(existing?.event_id);
  } catch (err: unknown) {
    logger.warn('Webhook replay lookup failed', {
      ...withRequestContext(c),
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function logReplayLookup(c: Context<AppEnv>, db: D1Database, event: StripeWebhookEvent): Promise<void> {
  const metadata = event.data.object.metadata ?? {};
  if (!metadata.bookingId) return;
  try {
    await db.prepare('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?')
      .bind(metadata.bookingId)
      .first<BookingPaymentContextRow>();
  } catch (err: unknown) {
    logger.warn('Failed to load booking context for replayed webhook', {
      ...withRequestContext(c, { eventId: event.id, bookingId: metadata.bookingId }),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function markEventProcessed(c: Context<AppEnv>, eventId: string, eventType: string): Promise<void> {
  const cache = c.env?.CACHE;
  if (cache) {
    const key = `stripe:webhook:event:${eventId}`;
    try {
      // Keep event IDs for 7 days to prevent replay processing.
      await cache.put(key, 'processed', { expirationTtl: 7 * 24 * 60 * 60 });
    } catch (err: unknown) {
      logger.warn('Webhook replay cache write failed', {
        ...withRequestContext(c, { eventId, eventType }),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const db = c.env?.DB;
  if (!db) return;

  try {
    await db.prepare(`
      INSERT OR IGNORE INTO processed_webhook_events (event_id, event_type, processed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(eventId, eventType).run();
  } catch (err: unknown) {
    logger.warn('Failed to persist webhook replay marker', {
      ...withRequestContext(c),
      eventId,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

async function writePaymentAudit(
  c: Context<AppEnv>,
  action: string,
  bookingId: string,
  userId?: string,
): Promise<void> {
  let db;
  try {
    db = getDB(c);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Stripe webhook denied because DB is unavailable', {
      ...withRequestContext(c),
      error: parsed.message,
    });
    throw new AppError('Stripe processing unavailable', 'CONFIGURATION_ERROR', 500);
  }
  if (!db) return;

  const parsedUserId = userId ? Number.parseInt(userId, 10) : Number.NaN;
  try {
    await db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, created_at)
      VALUES (?, ?, 'booking', ?, CURRENT_TIMESTAMP)
    `).bind(Number.isFinite(parsedUserId) ? parsedUserId : null, action, Number.parseInt(bookingId, 10)).run();
  } catch (err: unknown) {
    logger.warn('Audit log insert failed (non-critical)', {
      ...withRequestContext(c),
      error: err instanceof Error ? err.message : String(err),
      action,
      bookingId,
    });
  }
}

/**
 * Get Workers-compatible StripeService if configured.
 */
function getStripe(c: Context<AppEnv>): StripeService | null {
  if (!c.env?.STRIPE_SECRET_KEY) return null;
  return new StripeService(c.env.STRIPE_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// POST /intent - Create payment intent for booking
// ---------------------------------------------------------------------------

paymentRoutes.post('/intent', authMiddleware(), async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json<CreateIntentBody>();
  const { tripId, amount } = body;
  const idempotencyKey = getIdempotencyKey(c, user.id, tripId);

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

  if (idempotencyKey) {
    const cachedResponse = await getIdempotentPaymentIntentResponse(c, idempotencyKey);
    if (cachedResponse) {
      return c.json({ ...cachedResponse, replay: true });
    }
  }

  let db;
  try {
    db = getDB(c);
  } catch (err: unknown) {
    throw new AppError('Payment database unavailable', 'CONFIGURATION_ERROR', 500);
  }

  // Verify trip exists and user has an accepted booking
  const booking = await db.prepare(`
    SELECT tp.id, t.price_per_seat, t.title, t.driver_id, tp.payment_intent_id, tp.payment_status
    FROM trip_participants tp
    JOIN trips t ON tp.trip_id = t.id
    WHERE tp.trip_id = ? AND tp.user_id = ? AND tp.status = 'accepted'
  `).bind(tripId, user.id).first<BookingRow>();

  if (!booking) {
    throw new NotFoundError('Accepted booking for this trip');
  }

  const expectedAmount = Number(booking.price_per_seat);
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    throw new AppError('Trip fare is invalid or unavailable', 'CONFIGURATION_ERROR', 500);
  }
  const expectedAmountCents = Math.round(expectedAmount * 100);
  const requestedAmountCents = Math.round(amount * 100);
  if (requestedAmountCents !== expectedAmountCents) {
    throw new ValidationError('amount does not match trip fare');
  }

  if (booking.payment_intent_id && booking.payment_status === 'pending') {
    try {
      const existingIntent = await stripe.getPaymentIntent(booking.payment_intent_id);
      if (existingIntent?.id) {
        const existingResponse: PaymentIntentResponse = {
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
          amount: existingIntent.amount / 100,
          currency: existingIntent.currency,
        };
        if (idempotencyKey) {
          await setIdempotentPaymentIntentResponse(c, idempotencyKey, existingResponse);
        }
        return c.json({ ...existingResponse, replay: true });
      }
    } catch (err: unknown) {
      logger.warn('Failed to retrieve existing pending payment intent; creating a new one', {
        ...withRequestContext(c),
        bookingId: booking.id,
        paymentIntentId: booking.payment_intent_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    // Create Stripe payment intent (Workers-compatible via StripeService)
    const paymentIntent = await stripe.createPaymentIntent({
      amount: expectedAmountCents,
      currency: 'zar',
      tripId: Number(tripId),
      userId: user.id,
      bookingId: booking.id,
      description: `Payment for trip: ${booking.title}`,
    });

    // Store payment intent ID in booking
    const updateResult = await db.prepare(`
      UPDATE trip_participants
      SET payment_intent_id = ?, payment_status = 'pending'
      WHERE id = ?
        AND (payment_intent_id IS NULL OR payment_status != 'pending')
    `).bind(paymentIntent.id, booking.id).run();
    const updatedRows = getAffectedRows(updateResult);
    if (updatedRows === 0) {
      const existing = await db.prepare('SELECT payment_intent_id FROM trip_participants WHERE id = ?').bind(booking.id).first<{ payment_intent_id: string | null }>();
      if (existing?.payment_intent_id) {
        const existingIntent = await stripe.getPaymentIntent(existing.payment_intent_id);
        const existingResponse: PaymentIntentResponse = {
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
          amount: existingIntent.amount / 100,
          currency: existingIntent.currency,
          replay: true,
        };
        if (idempotencyKey) {
          await setIdempotentPaymentIntentResponse(c, idempotencyKey, existingResponse);
        }
        return c.json(existingResponse);
      }
    }

    logger.info('Payment intent created', {
      ...withRequestContext(c),
      paymentIntentId: paymentIntent.id,
      userId: user.id,
      tripId,
      amount: expectedAmount,
    });

    const response: PaymentIntentResponse = {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
    };
    if (idempotencyKey) {
      await setIdempotentPaymentIntentResponse(c, idempotencyKey, response);
    }
    return c.json(response);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Payment intent creation failed', {
      ...withRequestContext(c),
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
    logger.warn('Stripe webhook secret not configured, skipping signature verification', withRequestContext(c));
  }

  let event: StripeWebhookEvent;
  try {
    if (webhookSecret) {
      const isValid = await stripe.verifyWebhookSignature(body, signature, webhookSecret);
      if (!isValid) throw new Error('Signature mismatch');
    }
    event = JSON.parse(body) as StripeWebhookEvent;
  } catch (err: unknown) {
    logger.error('Webhook signature verification failed', {
      ...withRequestContext(c),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ValidationError('Invalid webhook signature');
  }

  let db;
  try {
    db = getDB(c);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Stripe webhook denied because DB is unavailable', {
      ...withRequestContext(c),
      error: parsed.message,
    });
    throw new AppError('Stripe processing unavailable', 'CONFIGURATION_ERROR', 500);
  }

  if (!event.id) {
    throw new ValidationError('Missing event id');
  }
  if (await isReplayEvent(c, event.id)) {
    await logReplayLookup(c, db, event);
    logger.info('Ignoring replayed Stripe webhook event', withRequestContext(c, { eventId: event.id, eventType: event.type }));
    return c.json({ received: true, replay: true });
  }

  let response: { received: true; replay?: boolean; ignored?: boolean; reason?: string } = { received: true };

  // Handle different event types
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['tripId', 'userId', 'bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe success event with missing metadata', {
          ...withRequestContext(c),
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        response = { received: true, ignored: true, reason: 'missing_metadata' };
        break;
      }
      const { tripId, userId, bookingId } = metadata;

      try {
        const booking = await db.prepare('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?')
          .bind(bookingId)
          .first<BookingPaymentContextRow>();
        if (!booking) {
          logger.warn('Ignoring payment succeeded event for unknown booking', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }
        if (!booking.payment_intent_id || booking.payment_intent_id !== paymentIntent.id) {
          logger.warn('Ignoring payment succeeded event with mismatched payment intent', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
            storedPaymentIntentId: booking.payment_intent_id,
          });
          break;
        }

        const metadataTripId = Number.parseInt(tripId, 10);
        const metadataUserId = Number.parseInt(userId, 10);
        if (
          !Number.isFinite(metadataTripId)
          || !Number.isFinite(metadataUserId)
          || metadataTripId !== booking.trip_id
          || metadataUserId !== booking.user_id
        ) {
          logger.warn('Ignoring payment succeeded event with metadata mismatch against booking context', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }

        const updateResult = await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'paid', payment_completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND payment_intent_id = ?
            AND COALESCE(payment_status, 'pending') IN ('pending', 'failed', 'canceled')
        `).bind(bookingId, paymentIntent.id).run();
        const affectedRows = getAffectedRows(updateResult);
        if (affectedRows === 0) {
          logger.warn('Ignoring payment succeeded transition for non-updatable booking state', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }

        logger.info('Payment succeeded', {
          ...withRequestContext(c),
          paymentIntentId: paymentIntent.id,
          userId: booking.user_id,
          tripId: booking.trip_id,
          amount: paymentIntent.amount / 100,
        });

        // Emit event for real-time notifications
        eventBus.emit('payment:succeeded', {
          tripId: String(booking.trip_id),
          userId: String(booking.user_id),
          bookingId,
          amount: paymentIntent.amount / 100,
        }, booking.user_id);

        await writePaymentAudit(c, 'PAYMENT_SUCCEEDED', bookingId, String(booking.user_id));

        try {
          const notificationPrefs = await getUserNotificationPreferences(db, booking.user_id);
          if (notificationPrefs.tripUpdates) {
            await createNotification(db, {
              userId: booking.user_id,
              tripId: booking.trip_id,
              notificationType: 'payment_succeeded',
              channel: 'in_app',
              status: 'sent',
              subject: 'Payment successful',
              message: 'Your trip payment was successful.',
              metadata: { bookingId, paymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 },
            });
          }
        } catch (err) {
          logger.warn('Failed to persist payment succeeded notification', {
            ...withRequestContext(c),
            error: err instanceof Error ? err.message : String(err),
            bookingId,
          });
        }
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          ...withRequestContext(c),
          error: parsed.message,
          bookingId,
          eventId: event.id,
        });
        throw new AppError('Failed to process webhook event', 'PAYMENT_WEBHOOK_ERROR', 500);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe payment_failed event with missing metadata', {
          ...withRequestContext(c),
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        response = { received: true, ignored: true, reason: 'missing_metadata' };
        break;
      }
      const { bookingId } = metadata;

      try {
        const booking = await db.prepare('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?')
          .bind(bookingId)
          .first<BookingPaymentContextRow>();
        if (!booking) {
          logger.warn('Ignoring payment failed event for unknown booking', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }
        if (!booking.payment_intent_id || booking.payment_intent_id !== paymentIntent.id) {
          logger.warn('Ignoring payment failed event with mismatched payment intent', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
            storedPaymentIntentId: booking.payment_intent_id,
          });
          break;
        }

        const updateResult = await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'failed'
          WHERE id = ?
            AND payment_intent_id = ?
            AND COALESCE(payment_status, 'pending') = 'pending'
        `).bind(bookingId, paymentIntent.id).run();
        const affectedRows = getAffectedRows(updateResult);
        if (affectedRows === 0) {
          logger.warn('Ignoring payment failed transition for non-pending booking state', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }

        logger.warn('Payment failed', {
          ...withRequestContext(c),
          paymentIntentId: paymentIntent.id,
          bookingId,
          reason: paymentIntent.last_payment_error?.message,
        });

        eventBus.emit('payment:failed', {
          bookingId,
          reason: paymentIntent.last_payment_error?.message,
        }, booking.user_id);

        await writePaymentAudit(c, 'PAYMENT_FAILED', bookingId, String(booking.user_id));
        try {
          const notificationPrefs = await getUserNotificationPreferences(db, booking.user_id);
          if (notificationPrefs.tripUpdates) {
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
          }
        } catch (err) {
          logger.warn('Failed to persist payment failed notification', {
            ...withRequestContext(c),
            error: err instanceof Error ? err.message : String(err),
            bookingId,
          });
        }
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          ...withRequestContext(c),
          error: parsed.message,
          bookingId,
          eventId: event.id,
        });
        throw new AppError('Failed to process webhook event', 'PAYMENT_WEBHOOK_ERROR', 500);
      }
      break;
    }

    case 'payment_intent.canceled': {
      const paymentIntent = event.data.object;
      const metadata = getRequiredMetadata(paymentIntent, ['bookingId']);
      if (!metadata) {
        logger.warn('Ignoring Stripe canceled event with missing metadata', {
          ...withRequestContext(c),
          eventId: event.id,
          paymentIntentId: paymentIntent.id,
        });
        response = { received: true, ignored: true, reason: 'missing_metadata' };
        break;
      }
      const { bookingId } = metadata;

      try {
        const booking = await db.prepare('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?')
          .bind(bookingId)
          .first<BookingPaymentContextRow>();
        if (!booking) {
          logger.warn('Ignoring payment canceled event for unknown booking', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }
        if (!booking.payment_intent_id || booking.payment_intent_id !== paymentIntent.id) {
          logger.warn('Ignoring payment canceled event with mismatched payment intent', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
            storedPaymentIntentId: booking.payment_intent_id,
          });
          break;
        }

        const updateResult = await db.prepare(`
          UPDATE trip_participants
          SET payment_status = 'canceled'
          WHERE id = ?
            AND payment_intent_id = ?
            AND COALESCE(payment_status, 'pending') = 'pending'
        `).bind(bookingId, paymentIntent.id).run();
        const affectedRows = getAffectedRows(updateResult);
        if (affectedRows === 0) {
          logger.warn('Ignoring payment canceled transition for non-pending booking state', {
            ...withRequestContext(c),
            bookingId,
            paymentIntentId: paymentIntent.id,
          });
          break;
        }

        logger.info('Payment canceled', {
          ...withRequestContext(c),
          paymentIntentId: paymentIntent.id,
          bookingId,
        });
        await writePaymentAudit(c, 'PAYMENT_CANCELED', bookingId);
      } catch (err: unknown) {
        const parsed = parseError(err);
        logger.error('Failed to update payment status', {
          ...withRequestContext(c),
          error: parsed.message,
          bookingId,
          eventId: event.id,
        });
        throw new AppError('Failed to process webhook event', 'PAYMENT_WEBHOOK_ERROR', 500);
      }
      break;
    }

    default:
      logger.debug('Unhandled webhook event type', withRequestContext(c, { eventType: event.type }));
  }

  await markEventProcessed(c, event.id, event.type);
  return c.json(response);
});

export default paymentRoutes;
