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

      await db
        .prepare(`UPDATE monthly_scheduled_days SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(day.id)
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
// Top-level daily task runner (called from scheduled() in index.tsx)
// ---------------------------------------------------------------------------

export async function runDailyTasks(env: Bindings): Promise<void> {
  logger.info('Cron: runDailyTasks started');
  await Promise.allSettled([
    batchMatchSubscriptionDays(env),
    sendTripReminders(env, '24h'),
    cleanupExpiredSessions(env),
  ]);
  logger.info('Cron: runDailyTasks completed');
}

export async function runHourlyTasks(env: Bindings): Promise<void> {
  logger.info('Cron: runHourlyTasks started');
  await sendTripReminders(env, '1h');
  logger.info('Cron: runHourlyTasks completed');
}
