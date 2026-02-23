/**
 * Klubz - Monthly Subscription Routes
 *
 * Manages monthly carpooling subscriptions with upfront Stripe payment.
 * Riders subscribe per calendar month, pre-booking their weekday schedule.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, MonthlySubscriptionRow } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDB } from '../lib/db';
import { AppError, ValidationError, ConflictError, NotFoundError } from '../lib/errors';
import { encryptPII } from '../lib/encryption';
import { logAuditEvent } from '../middleware/auditLogger';
import {
  haversineKm,
  estimatedRoadKm,
  generateScheduledDates,
  estimateMonthlyTotal,
} from '../lib/pricing';
import { StripeService } from '../integrations/stripe';

export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.use('*', authMiddleware());

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
const dateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const locationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
});

const createSubscriptionSchema = z.object({
  month: z.string().regex(monthRegex, 'month must be YYYY-MM'),
  recurringWeekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, 'at least one weekday required'),
  defaultMorningDeparture: z.string().regex(timeRegex, 'time must be HH:MM'),
  defaultEveningDeparture: z.string().regex(timeRegex, 'time must be HH:MM').optional(),
  defaultPickup: locationSchema,
  defaultDropoff: locationSchema,
}).strict();

const upsertDaySchema = z.object({
  departureTime: z.string().regex(timeRegex, 'time must be HH:MM').optional(),
  pickup: locationSchema.optional(),
  dropoff: locationSchema.optional(),
  isDestinationChange: z.boolean().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentYYYYMM(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatZAR(cents: number): string {
  return `R${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// POST / — Create monthly subscription
// ---------------------------------------------------------------------------

subscriptionRoutes.post('/', async (c) => {
  const user = c.get('user');
  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = createSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const {
    month,
    recurringWeekdays,
    defaultMorningDeparture,
    defaultEveningDeparture,
    defaultPickup,
    defaultDropoff,
  } = parsed.data;

  // Validate month range: not in the past, not more than 2 months ahead
  const current = currentYYYYMM();
  if (month < current) {
    throw new ValidationError('month cannot be in the past');
  }
  const maxMonth = (() => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 3; // +2 months ahead means +3 for max exclusive
    const maxDate = new Date(Date.UTC(y, m - 1, 1));
    return `${maxDate.getUTCFullYear()}-${String(maxDate.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  if (month >= maxMonth) {
    throw new ValidationError('month cannot be more than 2 months ahead');
  }

  // Check for existing subscription (UNIQUE constraint check)
  const existing = await db
    .prepare('SELECT id FROM monthly_subscriptions WHERE user_id = ? AND subscription_month = ?')
    .bind(user.id, month)
    .first<{ id: number }>();
  if (existing) {
    throw new ConflictError(`Subscription for ${month} already exists`);
  }

  // Compute estimates
  const straightLineKm = haversineKm(defaultPickup, defaultDropoff);
  const avgKmPerTrip = estimatedRoadKm(straightLineKm);
  const scheduledDates = generateScheduledDates(month, recurringWeekdays);
  const { totalCents, totalKm, totalDays } = estimateMonthlyTotal(
    avgKmPerTrip,
    scheduledDates,
    !!defaultEveningDeparture,
  );

  // Encrypt addresses
  const encKey = c.env.ENCRYPTION_KEY;
  const userId = user.id;

  let pickupEncrypted: string | null = null;
  let dropoffEncrypted: string | null = null;
  if (defaultPickup.address && encKey) {
    pickupEncrypted = await encryptPII(defaultPickup.address, encKey, userId);
  }
  if (defaultDropoff.address && encKey) {
    dropoffEncrypted = await encryptPII(defaultDropoff.address, encKey, userId);
  }

  // INSERT subscription
  const insertResult = await db
    .prepare(
      `INSERT INTO monthly_subscriptions (
        user_id, subscription_month,
        recurring_weekdays,
        default_morning_departure, default_evening_departure,
        default_pickup_lat, default_pickup_lng,
        default_dropoff_lat, default_dropoff_lng,
        default_pickup_encrypted, default_dropoff_encrypted,
        estimated_km_per_month, estimated_amount_cents, estimated_days
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      userId,
      month,
      JSON.stringify(recurringWeekdays),
      defaultMorningDeparture,
      defaultEveningDeparture ?? null,
      defaultPickup.lat,
      defaultPickup.lng,
      defaultDropoff.lat,
      defaultDropoff.lng,
      pickupEncrypted,
      dropoffEncrypted,
      totalKm,
      totalCents,
      totalDays,
    )
    .run();

  const subscriptionId = (insertResult.meta as { last_row_id?: number })?.last_row_id;
  if (!subscriptionId) {
    throw new AppError('Failed to create subscription', 'INTERNAL_ERROR', 500);
  }

  // Batch insert scheduled day slots
  const dayInserts: Promise<unknown>[] = [];
  for (const date of scheduledDates) {
    // Morning slot
    dayInserts.push(
      db
        .prepare(
          `INSERT INTO monthly_scheduled_days
            (subscription_id, user_id, trip_date, trip_type, departure_time,
             pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
             pickup_encrypted, dropoff_encrypted, estimated_km)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          subscriptionId,
          userId,
          date,
          'morning',
          defaultMorningDeparture,
          defaultPickup.lat,
          defaultPickup.lng,
          defaultDropoff.lat,
          defaultDropoff.lng,
          pickupEncrypted,
          dropoffEncrypted,
          avgKmPerTrip,
        )
        .run()
    );

    // Evening slot (optional)
    if (defaultEveningDeparture) {
      dayInserts.push(
        db
          .prepare(
            `INSERT INTO monthly_scheduled_days
              (subscription_id, user_id, trip_date, trip_type, departure_time,
               pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
               pickup_encrypted, dropoff_encrypted, estimated_km)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            subscriptionId,
            userId,
            date,
            'evening',
            defaultEveningDeparture,
            defaultDropoff.lat,
            defaultDropoff.lng,
            defaultPickup.lat,
            defaultPickup.lng,
            dropoffEncrypted,
            pickupEncrypted,
            avgKmPerTrip,
          )
          .run()
      );
    }
  }
  await Promise.all(dayInserts);

  await logAuditEvent(c, {
    userId,
    action: 'SUBSCRIPTION_CREATED',
    resourceType: 'monthly_subscription',
    resourceId: subscriptionId,
    success: true,
    metadata: { month, totalDays, totalCents },
  });

  return c.json({
    subscriptionId,
    month,
    estimatedDays: totalDays,
    estimatedKm: Math.round(totalKm * 100) / 100,
    estimatedAmount: totalCents,
    estimatedAmountDisplay: formatZAR(totalCents),
  });
});

// ---------------------------------------------------------------------------
// GET /current — User's active/upcoming subscription
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/current', async (c) => {
  const user = c.get('user');
  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  const current = currentYYYYMM();
  const sub = await db
    .prepare(
      `SELECT * FROM monthly_subscriptions
       WHERE user_id = ? AND subscription_month >= ?
       ORDER BY subscription_month ASC LIMIT 1`
    )
    .bind(user.id, current)
    .first<MonthlySubscriptionRow>();

  return c.json({ subscription: sub ?? null });
});

// ---------------------------------------------------------------------------
// GET /:id — Full subscription detail
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  const sub = await db
    .prepare('SELECT * FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<MonthlySubscriptionRow>();

  if (!sub) throw new NotFoundError('Subscription');

  const dayCountResult = await db
    .prepare('SELECT COUNT(*) as count FROM monthly_scheduled_days WHERE subscription_id = ?')
    .bind(id)
    .first<{ count: number }>();

  return c.json({ subscription: sub, dayCount: dayCountResult?.count ?? 0 });
});

// ---------------------------------------------------------------------------
// GET /:id/calendar — Calendar grid
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/:id/calendar', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  // Ownership check
  const sub = await db
    .prepare('SELECT id FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number }>();
  if (!sub) throw new NotFoundError('Subscription');

  const { results: days } = await db
    .prepare(
      `SELECT trip_date, trip_type, departure_time, status, is_destination_change
       FROM monthly_scheduled_days
       WHERE subscription_id = ?
       ORDER BY trip_date, trip_type`
    )
    .bind(id)
    .all<{
      trip_date: string;
      trip_type: 'morning' | 'evening';
      departure_time: string;
      status: string;
      is_destination_change: number;
    }>();

  // Group by date
  const grouped = new Map<
    string,
    { morning?: { time: string; status: string; isDestChange: boolean };
      evening?: { time: string; status: string; isDestChange: boolean } }
  >();

  for (const day of (days ?? [])) {
    if (!grouped.has(day.trip_date)) grouped.set(day.trip_date, {});
    const entry = grouped.get(day.trip_date)!;
    entry[day.trip_type] = {
      time: day.departure_time,
      status: day.status,
      isDestChange: day.is_destination_change === 1,
    };
  }

  const calendar = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, slots]) => ({ date, ...slots }));

  return c.json({ calendar });
});

// ---------------------------------------------------------------------------
// POST /:id/days/:date/:type — Add or update a day slot
// ---------------------------------------------------------------------------

subscriptionRoutes.post('/:id/days/:date/:type', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const date = c.req.param('date');
  const type = c.req.param('type');

  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');
  if (!dateRegex.test(date)) throw new ValidationError('date must be YYYY-MM-DD');
  if (type !== 'morning' && type !== 'evening') {
    throw new ValidationError('type must be morning or evening');
  }

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  // Ownership and month validation
  const sub = await db
    .prepare('SELECT id, subscription_month FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number; subscription_month: string }>();
  if (!sub) throw new NotFoundError('Subscription');

  if (!date.startsWith(sub.subscription_month)) {
    throw new ValidationError('date must be within the subscription month');
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }

  const parsed = upsertDaySchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const { departureTime, pickup, dropoff, isDestinationChange } = parsed.data;

  const encKey = c.env.ENCRYPTION_KEY;
  const userId = user.id;

  let pickupEncrypted: string | null = null;
  let dropoffEncrypted: string | null = null;
  if (pickup?.address && encKey) {
    pickupEncrypted = await encryptPII(pickup.address, encKey, userId);
  }
  if (dropoff?.address && encKey) {
    dropoffEncrypted = await encryptPII(dropoff.address, encKey, userId);
  }

  await db
    .prepare(
      `INSERT INTO monthly_scheduled_days
        (subscription_id, user_id, trip_date, trip_type, departure_time,
         pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
         pickup_encrypted, dropoff_encrypted, is_destination_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(subscription_id, trip_date, trip_type) DO UPDATE SET
         departure_time = COALESCE(excluded.departure_time, departure_time),
         pickup_lat = COALESCE(excluded.pickup_lat, pickup_lat),
         pickup_lng = COALESCE(excluded.pickup_lng, pickup_lng),
         dropoff_lat = COALESCE(excluded.dropoff_lat, dropoff_lat),
         dropoff_lng = COALESCE(excluded.dropoff_lng, dropoff_lng),
         pickup_encrypted = COALESCE(excluded.pickup_encrypted, pickup_encrypted),
         dropoff_encrypted = COALESCE(excluded.dropoff_encrypted, dropoff_encrypted),
         is_destination_change = excluded.is_destination_change,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      id,
      userId,
      date,
      type,
      departureTime ?? '07:30',
      pickup?.lat ?? null,
      pickup?.lng ?? null,
      dropoff?.lat ?? null,
      dropoff?.lng ?? null,
      pickupEncrypted,
      dropoffEncrypted,
      isDestinationChange ? 1 : 0,
    )
    .run();

  return c.json({ success: true, date, type });
});

// ---------------------------------------------------------------------------
// DELETE /:id/days/:date/:type — Cancel/skip a day
// ---------------------------------------------------------------------------

subscriptionRoutes.delete('/:id/days/:date/:type', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const date = c.req.param('date');
  const type = c.req.param('type');

  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');
  if (!dateRegex.test(date)) throw new ValidationError('date must be YYYY-MM-DD');
  if (type !== 'morning' && type !== 'evening') {
    throw new ValidationError('type must be morning or evening');
  }

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  // Ownership check via subscription
  const sub = await db
    .prepare('SELECT id FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number }>();
  if (!sub) throw new NotFoundError('Subscription');

  // Check current day slot status
  const daySlot = await db
    .prepare(
      `SELECT id, status FROM monthly_scheduled_days
       WHERE subscription_id = ? AND trip_date = ? AND trip_type = ? AND user_id = ?`
    )
    .bind(id, date, type, user.id)
    .first<{ id: number; status: string }>();

  if (!daySlot) throw new NotFoundError('Day slot');

  if (daySlot.status !== 'scheduled') {
    throw new ConflictError(
      `Cannot cancel day slot with status '${daySlot.status}' — only 'scheduled' slots can be cancelled`
    );
  }

  await db
    .prepare(
      `UPDATE monthly_scheduled_days SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(daySlot.id)
    .run();

  return c.json({ success: true, date, type, status: 'cancelled' });
});

// ---------------------------------------------------------------------------
// DELETE /:id — Cancel subscription
// ---------------------------------------------------------------------------

subscriptionRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  const sub = await db
    .prepare('SELECT id, status FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number; status: string }>();

  if (!sub) throw new NotFoundError('Subscription');

  if (sub.status !== 'pending_payment' && sub.status !== 'active') {
    throw new ConflictError(
      `Cannot cancel subscription with status '${sub.status}'`
    );
  }

  // Cancel subscription and all scheduled day slots
  await db
    .prepare(
      `UPDATE monthly_subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(id)
    .run();

  await db
    .prepare(
      `UPDATE monthly_scheduled_days SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE subscription_id = ? AND status = 'scheduled'`
    )
    .bind(id)
    .run();

  await logAuditEvent(c, {
    userId: user.id,
    action: 'SUBSCRIPTION_CANCELLED',
    resourceType: 'monthly_subscription',
    resourceId: id,
    success: true,
  });

  return c.json({ success: true, message: 'Subscription cancelled' });
});

// ---------------------------------------------------------------------------
// POST /:id/payment — Create Stripe payment intent
// ---------------------------------------------------------------------------

subscriptionRoutes.post('/:id/payment', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid subscription id');

  const db = (() => {
    try { return getDB(c); } catch {
      throw new AppError('Database not configured', 'CONFIGURATION_ERROR', 500);
    }
  })();

  const sub = await db
    .prepare('SELECT * FROM monthly_subscriptions WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<MonthlySubscriptionRow>();

  if (!sub) throw new NotFoundError('Subscription');

  if (sub.payment_status === 'paid') {
    throw new ConflictError('Subscription is already paid');
  }
  if (sub.payment_status !== 'unpaid') {
    throw new ConflictError(`Cannot create payment intent when payment_status is '${sub.payment_status}'`);
  }

  const stripeKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new AppError('Stripe not configured', 'CONFIGURATION_ERROR', 500);
  }

  const stripe = new StripeService(stripeKey);
  const intent = await stripe.createPaymentIntent({
    amount: sub.estimated_amount_cents,
    currency: 'zar',
    tripId: id,        // reuse tripId field for subscriptionId
    userId: user.id,
    description: `Klubz monthly subscription ${sub.subscription_month} for user ${user.id}`,
  });

  await db
    .prepare(
      `UPDATE monthly_subscriptions
       SET stripe_payment_intent_id = ?, payment_status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(intent.id, id)
    .run();

  return c.json({
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    amount: sub.estimated_amount_cents,
    currency: 'zar',
  });
});
