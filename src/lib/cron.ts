/**
 * Klubz - Scheduled / Cron Tasks
 *
 * Runs daily at 05:00 SAST (03:00 UTC) and hourly at :50.
 * Triggered via the Cloudflare Workers `scheduled` event.
 *
 * Tasks:
 *   1. Auto-match today's pending subscription days
 *   2. Send trip departure reminders (24h and 1h windows)
 *   3. Clean up expired KV session entries
 */

import type { Bindings } from '../types';
import { logger } from './logger';
import { MatchingRepository, matchRiderToDrivers, DEFAULT_MATCH_CONFIG } from './matching';
import { sendPushNotification } from './push';
import { NotificationService } from '../integrations/notifications';
import { StripeService } from '../integrations/stripe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledDayReminderRow {
  id: number;
  subscription_id: number;
  user_id: number;
  trip_date: string;
  trip_type: 'morning' | 'evening';
  departure_time: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  status: string;
}

interface TripReminderRow {
  id: number;
  rider_id: number;
  rider_email: string;
  departure_time: string;
}

interface FailedPayoutRow {
  id: number;
  trip_id: number;
  user_id: number;
  passenger_count: number | null;
  amount_paid: number | null;
  payment_status: string;
  price_per_seat: number | null;
  stripe_connect_account_id: string;
}

// ---------------------------------------------------------------------------
// 1. Batch-match today's pending subscription days
// ---------------------------------------------------------------------------

export async function batchMatchSubscriptionDays(env: Bindings): Promise<void> {
  const db = env.DB;
  if (!db) return;

  const repository = new MatchingRepository(db, env.CACHE);
  const today = new Date().toISOString().slice(0, 10);

  let days: ScheduledDayReminderRow[] = [];
  try {
    const result = await db
      .prepare(
        `SELECT id, subscription_id, user_id, trip_date, trip_type, departure_time,
                pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, status
         FROM monthly_scheduled_days
         WHERE trip_date = ? AND status = 'scheduled'
         LIMIT 100`,
      )
      .bind(today)
      .all<ScheduledDayReminderRow>();
    days = result.results ?? [];
  } catch (err) {
    logger.warn('batchMatchSubscriptionDays: query failed', { error: String(err) });
    return;
  }

  logger.info(`batchMatchSubscriptionDays: processing ${days.length} days for ${today}`);

  for (const day of days) {
    try {
      // Mark as requested so subsequent cron runs skip it
      await db
        .prepare(`UPDATE monthly_scheduled_days SET status = 'requested', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'scheduled'`)
        .bind(day.id)
        .run();

      if (
        day.pickup_lat === null ||
        day.pickup_lng === null ||
        day.dropoff_lat === null ||
        day.dropoff_lng === null
      ) {
        continue;
      }

      const timeLabel = day.departure_time.length === 5 ? `${day.departure_time}:00` : day.departure_time;
      const departureTs = Date.parse(`${day.trip_date}T${timeLabel}Z`);
      if (!Number.isFinite(departureTs)) {
        logger.warn('batchMatchSubscriptionDays: invalid departure time', {
          dayId: day.id,
          tripDate: day.trip_date,
          departureTime: day.departure_time,
        });
        continue;
      }

      const riderRequest = await repository.createRiderRequest(
        `subday:${day.id}`,
        day.user_id,
        {
          pickup: { lat: day.pickup_lat, lng: day.pickup_lng },
          dropoff: { lat: day.dropoff_lat, lng: day.dropoff_lng },
          earliestDeparture: departureTs - 30 * 60 * 1000,
          latestDeparture: departureTs + 30 * 60 * 1000,
          seatsNeeded: 1,
        },
      );

      const candidates = await repository.findCandidateDrivers(riderRequest, DEFAULT_MATCH_CONFIG);
      if (candidates.length === 0) {
        continue;
      }

      const matched = matchRiderToDrivers(riderRequest, candidates, DEFAULT_MATCH_CONFIG);
      const topMatch = matched.matches[0];
      if (!topMatch) {
        continue;
      }

      await repository.saveMatchResult(crypto.randomUUID(), topMatch);
      await repository.updateRiderRequestStatus(riderRequest.id, 'matched', topMatch.driverTripId);

      let matchedTripId: number | null = null;
      try {
        const tripRow = await db
          .prepare(
            `SELECT t.id
             FROM driver_trips dt
             JOIN trips t ON t.driver_id = dt.driver_id
             WHERE dt.id = ?
               AND ABS(strftime('%s', t.scheduled_time) - (dt.departure_time / 1000)) < 300
               AND t.status NOT IN ('cancelled', 'completed')
             LIMIT 1`,
          )
          .bind(topMatch.driverTripId)
          .first<{ id: number }>();
        matchedTripId = tripRow?.id ?? null;
        if (matchedTripId === null) {
          logger.warn('batchMatchSubscriptionDays: matched trip correlation not found', {
            dayId: day.id,
            driverTripId: topMatch.driverTripId,
          });
        }
      } catch (err) {
        logger.warn('batchMatchSubscriptionDays: matched trip correlation failed', {
          dayId: day.id,
          driverTripId: topMatch.driverTripId,
          error: String(err),
        });
      }

      await db
        .prepare(`UPDATE monthly_scheduled_days SET status = 'matched', trip_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(matchedTripId, day.id)
        .run();
    } catch (err) {
      logger.warn('batchMatchSubscriptionDays: update failed', { dayId: day.id, error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Trip departure reminders
// ---------------------------------------------------------------------------

export async function sendTripReminders(env: Bindings, window: '24h' | '1h'): Promise<void> {
  const db = env.DB;
  if (!db) return;

  const windowMs = window === '24h' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const toleranceMs = 10 * 60 * 1000;
  const targetTs = Date.now() + windowMs;
  const from = new Date(targetTs - toleranceMs).toISOString();
  const to = new Date(targetTs + toleranceMs).toISOString();

  let trips: TripReminderRow[] = [];
  try {
      const result = await db
      .prepare(
        `SELECT t.id, tp.user_id AS rider_id, u.email AS rider_email, t.departure_time
         FROM trips t
         JOIN trip_participants tp ON tp.trip_id = t.id AND tp.status = 'accepted' AND tp.role = 'rider'
         JOIN users u ON u.id = tp.user_id
         WHERE t.status IN ('scheduled', 'active')
           AND t.departure_time BETWEEN ? AND ?
         LIMIT 200`,
      )
      .bind(from, to)
      .all<TripReminderRow>();
    trips = result.results ?? [];
  } catch (err) {
    logger.warn('sendTripReminders: query failed', { window, error: String(err) });
    return;
  }

  if (trips.length === 0) return;

  const cache = env.CACHE;
  if (!cache) {
    logger.warn('sendTripReminders: CACHE KV not available — skipping to prevent duplicate notifications');
    return;
  }

  const notifications = new NotificationService(env);
  logger.info(`sendTripReminders: ${trips.length} trips in ${window} window`);

  for (const trip of trips) {
    try {
      const cacheKey = `reminder:${trip.id}:${trip.rider_id}:${window}`;
      // Skip if already sent (deduplication)
      const alreadySent = await cache?.get(cacheKey, 'text');
      if (alreadySent) continue;

      // Mark as sent in cache (TTL = window + 1h buffer)
      const ttl = Math.floor(windowMs / 1000) + 3600;
      await cache?.put(cacheKey, '1', { expirationTtl: ttl });

      const reminderLabel = window === '24h' ? '24 hours' : '1 hour';

      await sendPushNotification(env, db as Parameters<typeof sendPushNotification>[1], trip.rider_id, {
        title: 'Trip Reminder',
        body: `Your trip departs in about ${reminderLabel}.`,
        url: '/#my-trips',
        tag: cacheKey,
      });

      await notifications.sendEmail(
        trip.rider_email,
        `Trip reminder: departing in ${reminderLabel}`,
        `<p>Your Klubz trip departs in about <strong>${reminderLabel}</strong>.</p><p>Open the app to view your trip details.</p>`,
      );
    } catch (err) {
      logger.warn('sendTripReminders: reminder failed', { tripId: trip.id, error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Clean up expired sessions
// ---------------------------------------------------------------------------

export async function cleanupExpiredSessions(env: Bindings): Promise<void> {
  const db = env.DB;
  if (!db) return;

  try {
    const result = await db
      .prepare(
        `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP OR is_active = 0`,
      )
      .run();
    const deleted = Number(result.meta?.changes ?? 0);
    if (deleted > 0) {
      logger.info(`cleanupExpiredSessions: removed ${deleted} expired sessions`);
    }
  } catch (err) {
    logger.warn('cleanupExpiredSessions: failed', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// 4. Retry failed Stripe Connect payouts
// ---------------------------------------------------------------------------

export async function retryFailedPayouts(env: Bindings): Promise<void> {
  const db = env.DB;
  if (!db || !env.STRIPE_SECRET_KEY) return;

  let failedRows: FailedPayoutRow[] = [];
  try {
    const result = await db
      .prepare(`
        SELECT tp.id, tp.trip_id, tp.user_id, tp.passenger_count,
               tp.amount_paid, tp.payment_status, t.price_per_seat,
               u.stripe_connect_account_id
        FROM trip_participants tp
        JOIN trips t ON t.id = tp.trip_id
        JOIN users u ON u.id = t.driver_id
        WHERE tp.payout_status = 'failed'
          AND tp.payment_status = 'paid'
          AND tp.role = 'rider'
          AND tp.status = 'completed'
          AND u.stripe_connect_enabled = 1
          AND u.stripe_connect_account_id IS NOT NULL
        LIMIT 50
      `)
      .all<FailedPayoutRow>();
    failedRows = result.results ?? [];
  } catch (err) {
    logger.warn('retryFailedPayouts: query failed', { error: String(err) });
    return;
  }

  if (failedRows.length === 0) return;

  const stripe = new StripeService(env.STRIPE_SECRET_KEY);
  for (const payout of failedRows) {
    const passengers = Math.max(1, Number(payout.passenger_count ?? 1));
    const amount = Number(payout.amount_paid ?? ((payout.price_per_seat ?? 0) * passengers));
    const cents = Math.max(0, Math.round(amount * 0.85 * 100));
    if (cents <= 0) continue;

    try {
      const transfer = await stripe.createTransfer(
        cents,
        'zar',
        payout.stripe_connect_account_id,
        {
          tripId: String(payout.trip_id),
          participantId: String(payout.id),
          retry: 'true',
        },
      );

      await db
        .prepare(`
          UPDATE trip_participants
          SET payout_status = 'transferred',
              payout_transfer_id = ?,
              payout_transferred_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(transfer.id, payout.id)
        .run();

      logger.info('Payout retry succeeded', {
        participantId: payout.id,
        transferId: transfer.id,
      });
    } catch (err) {
      logger.warn('Payout retry failed again', {
        participantId: payout.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level daily task runner (called from scheduled() in index.tsx)
// ---------------------------------------------------------------------------

export async function runDailyTasks(env: Bindings): Promise<void> {
  logger.info('Cron: runDailyTasks started');
  await Promise.allSettled([
    batchMatchSubscriptionDays(env),
    sendTripReminders(env, '24h'),
    cleanupExpiredSessions(env),
    retryFailedPayouts(env),
  ]);
  logger.info('Cron: runDailyTasks completed');
}

export async function runHourlyTasks(env: Bindings): Promise<void> {
  logger.info('Cron: runHourlyTasks started');
  await sendTripReminders(env, '1h');
  logger.info('Cron: runHourlyTasks completed');
}
