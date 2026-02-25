/**
 * Klubz - Trip Routes (Production D1)
 *
 * Real D1 queries for trip search, booking, offering, rating.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';
import { eventBus } from '../lib/eventBus';
import { withRequestContext } from '../lib/observability';
import { getDB, getDBOptional } from '../lib/db';
import { matchRiderToDrivers } from '../lib/matching/engine';
import type { RiderRequest, DriverTrip } from '../lib/matching/types';
import { ValidationError } from '../lib/errors';
import { NotificationService } from '../integrations/notifications';
import { StripeService } from '../integrations/stripe';
import { safeDecryptPII } from '../lib/encryption';
import { getCacheService } from '../lib/cache';
import { createNotification } from '../lib/notificationStore';
import { getUserNotificationPreferences } from '../lib/userPreferences';
import { calculateFareCents, estimateETAMinutes, haversineKm, estimatedRoadKm, TRIP_RATES } from '../lib/pricing';
import { awardPoints } from '../lib/points';

export const tripRoutes = new Hono<AppEnv>();

tripRoutes.use('*', authMiddleware());

interface TripSearchResult {
  trips: unknown[];
  searchCriteria: {
    pickupLocation: { lat: number; lng: number };
    dropoffLocation: { lat: number; lng: number };
    maxDetour: number;
    date?: string;
    time?: string;
  };
  totalResults: number;
}

interface DriverTripRow {
  id: number;
  origin: string;
  destination: string;
  departure_time: string;
  available_seats: number;
  vehicle_type: string | null;
  price_per_seat: number | null;
  driver_id: number;
  route_distance_km: number | null;
  trip_type: string | null;
}

interface TripSeatRow {
  available_seats: number;
  driver_id?: number;
  status?: string;
}

interface TripOwnerRow {
  id: number;
  driver_id: number;
  status?: string;
}

interface TripParticipantOwnerRow {
  id: number;
  user_id: number;
  status: string;
}

interface RateRequestBody {
  rating?: number;
  comment?: string;
}

interface BookingTripDetailsRow {
  title: string | null;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  driver_id: number;
}

interface RiderNameRow {
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface AcceptBookingDetailsRow {
  user_id: number;
  title: string | null;
  origin: string;
  destination: string;
  departure_time: string;
  price_per_seat: number;
  email: string;
  first_name_encrypted: string | null;
  phone_encrypted: string | null;
  driver_first_name: string | null;
}

interface RejectRiderDetailsRow {
  email: string;
  first_name_encrypted: string | null;
  user_id: number;
  title: string | null;
  departure_time: string;
}

interface CancelParticipantRow {
  email: string;
  first_name_encrypted: string | null;
  user_id: number;
  title: string | null;
  departure_time: string;
  origin: string;
  destination: string;
  payment_intent_id: string | null;
  payment_status: string | null;
  booking_id: number;
}

interface BatchPrefsRow {
  user_id: number;
  notifications_json: string | null;
}

interface D1RunResult {
  meta?: {
    changes?: number;
  };
}

interface IdempotencyInsertResult {
  changes?: number;
}

const offerTripSchema = z.object({
  pickupLocation: z.object({
    address: z.string().trim().min(1).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }).passthrough(),
  dropoffLocation: z.object({
    address: z.string().trim().min(1).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }).passthrough(),
  scheduledTime: z.string().min(1),
  availableSeats: z.number().int().min(1).max(6).optional().default(3),
  price: z.number().positive().max(10000).optional(),
  notes: z.string().max(1000).optional(),
  vehicleInfo: z.object({
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    licensePlate: z.string().trim().min(1),
  }).strict(),
  trip_type: z.enum(['daily', 'monthly']).default('daily'),
  pickup_lat: z.number().optional(),
  pickup_lng: z.number().optional(),
  dropoff_lat: z.number().optional(),
  dropoff_lng: z.number().optional(),
}).strict();

const bookTripSchema = z.object({
  pickupLocation: z.object({
    address: z.string().trim().min(1).optional(),
  }).passthrough(),
  dropoffLocation: z.object({
    address: z.string().trim().min(1).optional(),
  }).passthrough(),
  passengers: z.number().int().min(1).max(4).optional().default(1),
  promoCode: z.string().max(30).optional(),
}).strict();

const tripReasonSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

function parseError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}

function getAffectedRows(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const meta = (result as D1RunResult).meta;
  if (!meta || typeof meta !== 'object' || typeof meta.changes !== 'number') return null;
  return meta.changes;
}

function getIdempotencyKey(c: Context<AppEnv>, userId: number, scope: string): string | null {
  const requestKey = c.req.header('Idempotency-Key') || c.req.header('idempotency-key');
  if (!requestKey) return null;
  return `idempotency:${scope}:${userId}:${requestKey}`;
}

interface IdempotencyCheckResult {
  replay: boolean;
  viaDb: boolean;
}

async function isIdempotentReplay(c: Context<AppEnv>, key: string): Promise<IdempotencyCheckResult> {
  const cache = c.env?.CACHE;
  if (cache) {
    try {
      const existing = await cache.get(key, 'text');
      if (existing) return { replay: true, viaDb: false };
    } catch (err: unknown) {
      logger.warn('Idempotency cache read failed, falling back to DB', {
        ...withRequestContext(c, { key }),
        error: err instanceof Error ? err.message : String(err),
      });
      const replay = await persistIdempotencyRecord(c, key);
      return { replay, viaDb: true };
    }
    try {
      await cache.put(key, 'seen', { expirationTtl: 10 * 60 }); // 10 minutes
    } catch (err: unknown) {
      logger.warn('Idempotency cache write failed, invoking DB fallback', {
        ...withRequestContext(c, { key }),
        error: err instanceof Error ? err.message : String(err),
      });
      const replay = await persistIdempotencyRecord(c, key);
      return { replay, viaDb: true };
    }
    return { replay: false, viaDb: false };
  }

  const replay = await persistIdempotencyRecord(c, key);
  return { replay, viaDb: true };
}

async function persistIdempotencyRecord(c: Context<AppEnv>, key: string): Promise<boolean> {
  const db = c.env?.DB;
  if (!db) return false;

  try {
    const result = await db.prepare(`
      INSERT OR IGNORE INTO idempotency_records (idempotency_key, created_at)
      VALUES (?, CURRENT_TIMESTAMP)
    `).bind(key).run();
    const changes = ((result.meta ?? {}) as IdempotencyInsertResult).changes;
    logger.debug('Idempotency DB result', {
      ...withRequestContext(c, { key }),
      changes,
    });
    return changes === 0;
  } catch (err: unknown) {
    logger.warn('Idempotency replay check failed (DB fallback)', {
      ...withRequestContext(c, { key }),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function parseMaybeJsonLocation(value: string, fallback: { lat: number; lng: number }): { lat: number; lng: number } {
  if (!value.includes('{')) return fallback;
  try {
    const parsed = JSON.parse(value) as { lat?: number; lng?: number };
    return {
      lat: typeof parsed.lat === 'number' ? parsed.lat : fallback.lat,
      lng: typeof parsed.lng === 'number' ? parsed.lng : fallback.lng,
    };
  } catch {
    return fallback;
  }
}

async function awardPointsOnce(
  db: { prepare(query: string): { bind(...args: unknown[]): { first<T = unknown>(): Promise<T | null> } } },
  userId: number,
  delta: number,
  reason: string,
  referenceId: number,
): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM points_ledger WHERE user_id = ? AND reason = ? AND reference_id = ? LIMIT 1')
    .bind(userId, reason, referenceId)
    .first<{ id: number }>();
  if (existing) return;
  await awardPoints(db as Parameters<typeof awardPoints>[0], userId, delta, reason, referenceId);
}

function parseBoundedNumber(value: string, label: string, min: number, max: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoundedInteger(value: string, label: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== value.trim() || parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// GET /available - search for trips
// ---------------------------------------------------------------------------

tripRoutes.get('/available', async (c) => {
  const user = c.get('user') as AuthUser;
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, date, time, maxDetour = '15' } = c.req.query();

  // Validate required coordinates
  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    throw new ValidationError('Pickup and dropoff coordinates are required');
  }

  const pickupLatNum = parseBoundedNumber(pickupLat, 'pickupLat', -90, 90);
  const pickupLngNum = parseBoundedNumber(pickupLng, 'pickupLng', -180, 180);
  const dropoffLatNum = parseBoundedNumber(dropoffLat, 'dropoffLat', -90, 90);
  const dropoffLngNum = parseBoundedNumber(dropoffLng, 'dropoffLng', -180, 180);
  const maxDetourNum = parseBoundedInteger(maxDetour, 'maxDetour', 1, 120);

  const db = getDB(c);
  const cache = getCacheService(c);

  // Generate cache key from search parameters
  const cacheKey = `trips:search:${pickupLat}:${pickupLng}:${dropoffLat}:${dropoffLng}:${date || 'today'}:${time || 'now'}:${maxDetour}`;

  // Try cache first
  if (cache) {
    const cached = await cache.get<TripSearchResult>(cacheKey);
    if (cached) {
      logger.debug('Trip search cache hit', { cacheKey });
      return c.json(cached);
    }
  }

  try {
    // Fetch available driver trips from database
    const departureTime = date && time ? new Date(`${date}T${time}`) : new Date();
    const { results: driverTrips } = await db.prepare(`
      SELECT t.id, t.origin, t.destination, t.departure_time, t.available_seats,
             t.vehicle_type, t.price_per_seat, t.driver_id,
             t.route_distance_km, t.trip_type,
             u.first_name_encrypted, u.last_name_encrypted
      FROM trips t
      JOIN users u ON t.driver_id = u.id
      WHERE t.status = 'scheduled'
        AND t.available_seats > 0
        AND t.departure_time >= ?
      ORDER BY t.departure_time ASC
      LIMIT 50
    `).bind(departureTime.toISOString()).all<DriverTripRow>();

    // Create rider request
    const riderRequest: RiderRequest = {
      id: `search-${user.id}-${Date.now()}`,
      riderId: String(user.id),
      pickup: { lat: pickupLatNum, lng: pickupLngNum },
      dropoff: { lat: dropoffLatNum, lng: dropoffLngNum },
      earliestDeparture: departureTime.getTime(),
      latestDeparture: departureTime.getTime() + 2 * 60 * 60 * 1000,
      seatsNeeded: 1,
      status: 'pending',
      preferences: {
        maxDetourMinutes: maxDetourNum,
        maxWalkDistanceKm: 0.5,
      },
      createdAt: new Date().toISOString(),
    };

    // Convert DB results to DriverTrip format (simplified)
    const drivers: DriverTrip[] = (driverTrips ?? []).map((t) => {
      // Parse coordinates from origin/destination strings (simplified)
      const originCoords = parseMaybeJsonLocation(t.origin, { lat: pickupLatNum, lng: pickupLngNum });
      const destCoords = parseMaybeJsonLocation(t.destination, { lat: dropoffLatNum, lng: dropoffLngNum });

      return {
        id: String(t.id),
        driverId: String(t.driver_id),
        departure: { lat: originCoords.lat || pickupLatNum, lng: originCoords.lng || pickupLngNum },
        destination: { lat: destCoords.lat || dropoffLatNum, lng: destCoords.lng || dropoffLngNum },
        departureTime: new Date(t.departure_time).getTime(),
        availableSeats: t.available_seats,
        totalSeats: t.available_seats,
        routePolyline: [],
        status: 'active',
        vehicle: { make: t.vehicle_type || 'sedan', model: '', year: 2020, licensePlate: '', capacity: t.available_seats },
        createdAt: new Date().toISOString(),
        routeDistanceKm: t.route_distance_km != null ? Number(t.route_distance_km) : undefined,
      };
    });

    // Use matching algorithm
    const { matches } = matchRiderToDrivers(riderRequest, drivers);
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const dbTripById = new Map((driverTrips ?? []).map((t) => [String(t.id), t]));

    const trips = matches.map(match => ({
      id: match.driverTripId,
      title: `Trip to ${(driverById.get(match.driverTripId)?.destination.lat ?? 0).toFixed(4)}, ${(driverById.get(match.driverTripId)?.destination.lng ?? 0).toFixed(4)}`,
      driverName: `Driver ${match.driverId}`,
      driverRating: 4.5,
      pickupLocation: {
        lat: driverById.get(match.driverTripId)?.departure.lat ?? 0,
        lng: driverById.get(match.driverTripId)?.departure.lng ?? 0,
      },
      dropoffLocation: {
        lat: driverById.get(match.driverTripId)?.destination.lat ?? 0,
        lng: driverById.get(match.driverTripId)?.destination.lng ?? 0,
      },
      scheduledTime: new Date(driverById.get(match.driverTripId)?.departureTime ?? Date.now()).toISOString(),
      availableSeats: driverById.get(match.driverTripId)?.availableSeats ?? 0,
      vehicleType: driverById.get(match.driverTripId)?.vehicle?.make || 'sedan',
      pricePerSeat: (() => {
        const dbTrip = dbTripById.get(match.driverTripId);
        return dbTrip?.price_per_seat != null ? Number(dbTrip.price_per_seat) : 35;
      })(),
      ...((() => {
        const dbTrip = dbTripById.get(match.driverTripId);
        const km = dbTrip?.route_distance_km;
        if (km != null && km > 0) {
          return {
            fareDaily: calculateFareCents(km, 'daily') / 100,
            fareMonthly: calculateFareCents(km, 'monthly') / 100,
            etaMinutes: estimateETAMinutes(km),
            routeDistanceKm: km,
          };
        }
        return {};
      })()),
      // Matching scores
      matchScore: match.score,
      explanation: match.explanation,
      detourMinutes: match.estimatedDetourMinutes || 0,
      walkingDistanceKm: match.breakdown?.pickupDistanceKm || 0,
      carbonSavedKg: match.carbonSavedKg || 0,
    }));

    logger.info('Trip search completed with matching engine', {
      userId: user.id,
      resultsCount: trips.length,
      avgScore: trips.reduce((sum, t) => sum + t.matchScore, 0) / trips.length || 0,
    });

    const result = {
      trips,
      searchCriteria: {
        pickupLocation: { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) },
        dropoffLocation: { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) },
        maxDetour: maxDetourNum, date, time,
      },
      totalResults: trips.length,
    };

    // Cache results for 5 minutes
    if (cache) {
      await cache.set(cacheKey, result, 300);
    }

    return c.json(result);
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Available trips error', err instanceof Error ? err : undefined, {
      error: parsedError.message,
    });
    return c.json({
      trips: [],
      searchCriteria: {
        pickupLocation: { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) },
        dropoffLocation: { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) },
        maxDetour: maxDetourNum, date, time,
      },
      totalResults: 0,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /:tripId/book
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/book', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsedBody = bookTripSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedBody.error.issues.map((i) => i.message).join(', ') } }, 400);
  }

  const { pickupLocation, dropoffLocation, passengers, promoCode } = parsedBody.data;
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-book:${tripId}`);
  if (idempotencyKey) {
    const { replay } = await isIdempotentReplay(c, idempotencyKey);
    if (replay) {
      return c.json({
        error: {
          code: 'IDEMPOTENCY_REPLAY',
          message: 'Duplicate booking request detected. Original request already processed.',
        }
      }, 409);
    }
  }
  const db = getDBOptional(c);
  if (!db) {
    logger.error('Booking denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
    // Verify trip exists and has seats
    const trip = await db.prepare('SELECT id, available_seats, status, driver_id FROM trips WHERE id = ?').bind(tripId).first<TripSeatRow>();
    if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
    if (trip.driver_id === user.id) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Drivers cannot book their own trips' } }, 403);
    }
    if (trip.status && trip.status !== 'scheduled') {
      return c.json({ error: { code: 'CONFLICT', message: 'Trip is not open for booking' } }, 409);
    }
    if (trip.available_seats < passengers) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Not enough seats' } }, 400);
    }

    // Check if rider has an active paid monthly subscription
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const activeSub = await db
      .prepare(`SELECT id, payment_status FROM monthly_subscriptions WHERE user_id = ? AND subscription_month = ? AND status = 'active' LIMIT 1`)
      .bind(user.id, currentMonth)
      .first<{ id: number; payment_status: string }>();

    const hasPaidSub = activeSub?.payment_status === 'paid';
    const fareRatePerKm = hasPaidSub ? TRIP_RATES.MONTHLY_PER_KM : TRIP_RATES.DAILY_PER_KM;
    const subId = hasPaidSub ? activeSub!.id : null;

    // Validate promo code if provided
    let promoCodeId: number | null = null;
    let discountCents = 0;
    if (promoCode) {
      const promo = await db.prepare(`
        SELECT id, discount_type, discount_value, max_uses, uses_count, min_fare_cents, expires_at
        FROM promo_codes
        WHERE code = ? COLLATE NOCASE AND is_active = 1
      `).bind(promoCode).first<{
        id: number;
        discount_type: 'percent' | 'fixed_cents';
        discount_value: number;
        max_uses: number | null;
        uses_count: number;
        min_fare_cents: number;
        expires_at: string | null;
      }>();

      if (!promo) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid or inactive promo code' } }, 400);
      }
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Promo code has expired' } }, 400);
      }
      if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Promo code usage limit reached' } }, 400);
      }

      const alreadyUsed = await db.prepare(
        'SELECT id FROM promo_redemptions WHERE promo_code_id = ? AND user_id = ?'
      ).bind(promo.id, user.id).first<{ id: number }>();
      if (alreadyUsed) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Promo code already used' } }, 400);
      }

      promoCodeId = promo.id;
      if (promo.discount_type === 'percent') {
        // Estimate fare for discount calculation — use a rough value; actual charge is done at payment time
        const estimatedFareCents = Math.round(fareRatePerKm * 30 * 100); // 30 km placeholder
        discountCents = Math.min(Math.round(estimatedFareCents * promo.discount_value / 100), estimatedFareCents);
      } else {
        discountCents = promo.discount_value;
      }
    }

    await db
      .prepare(
        `INSERT INTO trip_participants (trip_id, user_id, role, status, pickup_location_encrypted, dropoff_location_encrypted, passenger_count, subscription_id, fare_rate_per_km)
         VALUES (?, ?, 'rider', 'requested', ?, ?, ?, ?, ?)`
      )
      .bind(
        tripId, user.id,
        pickupLocation.address || JSON.stringify(pickupLocation),
        dropoffLocation.address || JSON.stringify(dropoffLocation),
        passengers,
        subId,
        fareRatePerKm,
      )
      .run();

    // Record promo redemption
    if (promoCodeId !== null) {
      await db.prepare(
        `INSERT INTO promo_redemptions (promo_code_id, user_id, trip_id, discount_applied_cents)
         VALUES (?, ?, ?, ?)`
      ).bind(promoCodeId, user.id, Number(tripId), discountCents).run();
      await db.prepare(
        'UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ?'
      ).bind(promoCodeId).run();
    }

    // Emit real-time booking event
    eventBus.emit('booking:requested', {
      tripId,
      passengerId: user.id,
      passengers,
    }, user.id);

    // Send notification to driver
    const notifications = new NotificationService(c.env);
    try {
        const tripDetails = await db.prepare(`
            SELECT t.title, t.origin, t.destination, t.departure_time, t.driver_id,
                   u.email, u.first_name_encrypted, u.last_name_encrypted
            FROM trips t
            JOIN users u ON t.driver_id = u.id
            WHERE t.id = ?
          `).bind(tripId).first<BookingTripDetailsRow>();

        if (tripDetails) {
          const driverNotificationPrefs = await getUserNotificationPreferences(db, tripDetails.driver_id);

          try {
            if (driverNotificationPrefs.tripUpdates) {
              await createNotification(db, {
                userId: tripDetails.driver_id,
                tripId: Number.parseInt(tripId, 10),
                notificationType: 'booking_request',
                channel: 'in_app',
                status: 'pending',
                subject: 'New booking request',
                message: `You received a new booking request for ${tripDetails.title || 'your trip'}.`,
                metadata: { tripId, passengerId: user.id, passengers },
              });
            }
          } catch (err) {
            logger.warn('Failed to persist booking request notification', { error: err instanceof Error ? err.message : String(err) });
          }

          if (notifications.emailAvailable && driverNotificationPrefs.tripUpdates) {
            const encKey = c.env?.ENCRYPTION_KEY;
            const driverFirstName = await safeDecryptPII(
              tripDetails.first_name_encrypted, encKey, tripDetails.driver_id,
            ) ?? 'Driver';

            const riderDetails = await db.prepare('SELECT first_name_encrypted, last_name_encrypted FROM users WHERE id = ?').bind(user.id).first<RiderNameRow>();
            const riderFirstName = await safeDecryptPII(
              riderDetails?.first_name_encrypted, encKey, user.id,
            ) ?? 'A rider';
            const riderLastName = await safeDecryptPII(
              riderDetails?.last_name_encrypted, encKey, user.id,
            ) ?? '';

            await notifications.sendEmail(
              tripDetails.email,
              'New Booking Request - Klubz',
              `
              <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
                <h1 style="color:#3B82F6">New Booking Request</h1>
                <p>Hi ${driverFirstName}, you have a new booking request for your trip.</p>
                <div style="background:#F3F4F6;padding:16px;border-radius:8px;margin:16px 0">
                  <p><strong>Trip:</strong> ${tripDetails.title || 'Your trip'}</p>
                  <p><strong>Rider:</strong> ${riderFirstName} ${riderLastName}</p>
                  <p><strong>Passengers:</strong> ${passengers}</p>
                  <p><strong>Pickup:</strong> ${pickupLocation.address || 'Requested location'}</p>
                  <p><strong>Dropoff:</strong> ${dropoffLocation.address || 'Requested location'}</p>
                </div>
                <p>Log in to Klubz to accept or reject this booking.</p>
              </div>
            `,
              `New booking request from ${riderFirstName} ${riderLastName} for ${passengers} passenger(s).`
            );
          }
        }
      } catch (err) {
        logger.warn('Failed to send booking notification', { error: err instanceof Error ? err.message : String(err) });
      }

    return c.json({ message: 'Booking request submitted successfully', booking: { tripId, passengerId: user.id, status: 'requested', createdAt: new Date().toISOString(), discountApplied: discountCents > 0 ? discountCents : undefined } });
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
    if (parsedError.message.includes('UNIQUE')) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Already booked on this trip' } }, 409);
    }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Booking request failed' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /offer - driver creates trip
// ---------------------------------------------------------------------------

tripRoutes.post('/offer', async (c) => {
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const parsed = offerTripSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => i.message).join(', ') } }, 400);
  }
  const { pickupLocation, dropoffLocation, scheduledTime, availableSeats, price, vehicleInfo, notes, trip_type, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = parsed.data;
  const idempotencyKey = getIdempotencyKey(c, user.id, 'trip-offer');
  if (idempotencyKey) {
    const { replay, viaDb } = await isIdempotentReplay(c, idempotencyKey);
    if (replay) {
      if (viaDb) {
        return c.json({
          error: {
            code: 'IDEMPOTENCY_REPLAY',
            message: 'Duplicate trip offer request detected. Original request already processed.',
          },
          replay: true,
        }, 409);
      }
      return c.json({ message: 'Duplicate request ignored', replay: true });
    }
  }

  if (new Date(scheduledTime).getTime() <= Date.now()) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Scheduled time must be in the future' } }, 400);
  }

  // Compute fare from coordinates if provided
  let distanceKm: number | null = null;
  let ratePerKm: number | null = null;
  let computedPricePerSeat: number | null = null;

  const pickupLatVal = pickup_lat ?? (pickupLocation as { lat?: number }).lat;
  const pickupLngVal = pickup_lng ?? (pickupLocation as { lng?: number }).lng;
  const dropoffLatVal = dropoff_lat ?? (dropoffLocation as { lat?: number }).lat;
  const dropoffLngVal = dropoff_lng ?? (dropoffLocation as { lng?: number }).lng;

  if (pickupLatVal != null && dropoffLatVal != null &&
      pickupLngVal != null && dropoffLngVal != null) {
    const straightLine = haversineKm(
      { lat: pickupLatVal, lng: pickupLngVal },
      { lat: dropoffLatVal, lng: dropoffLngVal }
    );
    distanceKm = estimatedRoadKm(straightLine);
    ratePerKm = trip_type === 'monthly' ? TRIP_RATES.MONTHLY_PER_KM : TRIP_RATES.DAILY_PER_KM;
    computedPricePerSeat = calculateFareCents(distanceKm, trip_type) / 100;
  }

  const db = getDBOptional(c);
  if (!db) {
    logger.error('Trip offer denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
      const result = await db
        .prepare(
          `INSERT INTO trips (title, description, origin, destination, origin_hash, destination_hash, departure_time, available_seats, total_seats, price_per_seat, currency, status, vehicle_type, vehicle_model_encrypted, vehicle_plate_encrypted, driver_id, trip_type, route_distance_km, rate_per_km)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ZAR', 'scheduled', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          `Trip to ${dropoffLocation.address || 'destination'}`,
          notes || null,
          pickupLocation.address || JSON.stringify(pickupLocation),
          dropoffLocation.address || JSON.stringify(dropoffLocation),
          'hash_' + Date.now(),
          'hash_' + (Date.now() + 1),
          scheduledTime,
          availableSeats,
          availableSeats,
          computedPricePerSeat ?? price ?? 35.00,
          vehicleInfo.make + ' ' + vehicleInfo.model,
          vehicleInfo.licensePlate,
          user.id,
          trip_type,
          distanceKm,
          ratePerKm,
        )
        .run();

      const tripId = result?.meta?.last_row_id ?? 0;

      // Add driver as participant
      await db
        .prepare('INSERT INTO trip_participants (trip_id, user_id, role, status) VALUES (?, ?, \'driver\', \'accepted\')')
        .bind(tripId, user.id)
        .run();

      // Emit real-time event
      eventBus.emit('trip:created', {
        tripId,
        driverId: user.id,
        destination: dropoffLocation.address || 'unknown',
        availableSeats,
        scheduledTime,
      }, user.id);

      // Invalidate trip search cache
      const cache = getCacheService(c);
      if (cache) {
        await cache.invalidatePattern('trips:search:');
      }

    return c.json({
      message: 'Trip offer created successfully',
      trip: { id: tripId, status: 'scheduled', driverId: user.id, availableSeats, createdAt: new Date().toISOString() },
    });
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Trip offer error', err instanceof Error ? err : undefined, { error: parsedError.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Trip offer creation failed' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /:tripId/bookings/:bookingId/accept
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/bookings/:bookingId/accept', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const bookingId = c.req.param('bookingId');
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-accept:${tripId}:${bookingId}`);
  if (idempotencyKey) {
    const { replay, viaDb } = await isIdempotentReplay(c, idempotencyKey);
    if (replay) {
      if (viaDb) {
        return c.json({
          error: {
            code: 'IDEMPOTENCY_REPLAY',
            message: 'Duplicate booking acceptance detected. Original request already processed.',
          },
          replay: true,
        }, 409);
      }
      return c.json({ message: 'Duplicate request ignored', replay: true });
    }
  }

  const db = getDBOptional(c);
  if (!db) {
    logger.error('Booking acceptance denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
      const trip = await db
        .prepare('SELECT id, driver_id FROM trips WHERE id = ?')
        .bind(tripId)
        .first<TripOwnerRow>();
      if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
      if (trip.driver_id !== user.id) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only the trip driver can accept bookings' } }, 403);
      }

      const bookingUpdate = await db
        .prepare("UPDATE trip_participants SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ? AND role = 'rider' AND status = 'requested'")
        .bind(bookingId, tripId)
        .run();
      const bookingRows = getAffectedRows(bookingUpdate);
      if (bookingRows === 0) {
        return c.json({ error: { code: 'CONFLICT', message: 'Booking is no longer pending' } }, 409);
      }

      // Decrement seats only if availability exists; WHERE clause prevents negative seats.
      const seatUpdate = await db
        .prepare(`
          UPDATE trips
          SET available_seats = available_seats - (
            SELECT COALESCE(passenger_count, 1)
            FROM trip_participants
            WHERE id = ? AND trip_id = ? AND role = 'rider'
          )
          WHERE id = ?
            AND available_seats >= (
              SELECT COALESCE(passenger_count, 1)
              FROM trip_participants
              WHERE id = ? AND trip_id = ? AND role = 'rider'
            )
        `)
        .bind(bookingId, tripId, tripId, bookingId, tripId)
        .run();
      const seatRows = getAffectedRows(seatUpdate);
      if (seatRows === 0) {
        // Compensate booking transition when seat decrement loses a race.
        await db
          .prepare("UPDATE trip_participants SET status = 'requested', accepted_at = NULL WHERE id = ? AND trip_id = ? AND role = 'rider' AND status = 'accepted'")
          .bind(bookingId, tripId)
          .run();
        return c.json({ error: { code: 'CONFLICT', message: 'No seats available' } }, 409);
      }

      // Emit real-time event
      eventBus.emit('booking:accepted', { bookingId, tripId, acceptedBy: user.id }, user.id);

      // Send notification to rider
      const notifications = new NotificationService(c.env);
      try {
        const bookingDetails = await db.prepare(`
            SELECT tp.user_id, t.title, t.origin, t.destination, t.departure_time, t.price_per_seat,
                   u.email, u.first_name_encrypted, u.last_name_encrypted, u.phone_encrypted,
                   d.first_name_encrypted as driver_first_name
            FROM trip_participants tp
            JOIN trips t ON tp.trip_id = t.id
            JOIN users u ON tp.user_id = u.id
            JOIN users d ON t.driver_id = d.id
            WHERE tp.id = ? AND tp.role = 'rider'
          `).bind(bookingId).first<AcceptBookingDetailsRow>();

        if (bookingDetails) {
          const riderNotificationPrefs = await getUserNotificationPreferences(db, bookingDetails.user_id);

            try {
              if (riderNotificationPrefs.tripUpdates) {
                await createNotification(db, {
                  userId: bookingDetails.user_id,
                  tripId: Number.parseInt(tripId, 10),
                  notificationType: 'booking_accepted',
                  channel: 'in_app',
                  status: 'sent',
                  subject: 'Booking accepted',
                  message: `Your booking for ${bookingDetails.title || 'the trip'} was accepted.`,
                  metadata: { tripId, bookingId, acceptedBy: user.id },
                });
              }
            } catch (err) {
              logger.warn('Failed to persist booking accepted notification', { error: err instanceof Error ? err.message : String(err) });
            }

          if (notifications.emailAvailable || notifications.smsAvailable) {
            const encKey = c.env?.ENCRYPTION_KEY;
            const riderFirstName = await safeDecryptPII(
              bookingDetails.first_name_encrypted, encKey, bookingDetails.user_id,
            ) ?? 'Rider';

            const driverFirstName = await safeDecryptPII(
              bookingDetails.driver_first_name, encKey, user.id,
            ) ?? 'Your driver';

            // Send email confirmation
            if (notifications.emailAvailable && riderNotificationPrefs.tripUpdates) {
              await notifications.sendEmail(
                bookingDetails.email,
                'Trip Booking Confirmed - Klubz',
                `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
                    <h1 style="color:#3B82F6">Booking Confirmed!</h1>
                    <p>Hi ${riderFirstName}, your trip has been confirmed:</p>
                    <div style="background:#F3F4F6;padding:16px;border-radius:8px;margin:16px 0">
                      <p><strong>Driver:</strong> ${driverFirstName}</p>
                      <p><strong>From:</strong> ${bookingDetails.origin}</p>
                      <p><strong>To:</strong> ${bookingDetails.destination}</p>
                      <p><strong>Departure:</strong> ${new Date(bookingDetails.departure_time).toLocaleString()}</p>
                      <p><strong>Price:</strong> R${bookingDetails.price_per_seat}</p>
                    </div>
                    <p style="color:#6B7280;font-size:0.875rem">You'll receive notifications as your trip approaches.</p>
                  </div>
                `,
                `Your Klubz booking is confirmed! Trip with ${driverFirstName} on ${new Date(bookingDetails.departure_time).toLocaleString()}.`
              );
            }

            // Send SMS confirmation if phone available
            if (notifications.smsAvailable && bookingDetails.phone_encrypted && riderNotificationPrefs.tripUpdates && riderNotificationPrefs.smsNotifications) {
              try {
                const phone = await safeDecryptPII(bookingDetails.phone_encrypted, c.env?.ENCRYPTION_KEY, bookingDetails.user_id) ?? bookingDetails.phone_encrypted;
                await notifications.sendSMS(
                  phone,
                  `Klubz: Your booking is confirmed! Trip with ${driverFirstName} on ${new Date(bookingDetails.departure_time).toLocaleDateString()} at ${new Date(bookingDetails.departure_time).toLocaleTimeString()}. Check your email for details.`
                );
              } catch (err) {
                logger.warn('Failed to send SMS confirmation', { error: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to send booking confirmation', { error: err instanceof Error ? err.message : String(err) });
      }

    return c.json({ message: 'Booking accepted successfully', booking: { id: bookingId, tripId, status: 'accepted', acceptedAt: new Date().toISOString() } });
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Accept booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Booking acceptance failed' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /:tripId/bookings/:bookingId/reject
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/bookings/:bookingId/reject', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const bookingId = c.req.param('bookingId');
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-reject:${tripId}:${bookingId}`);
  if (idempotencyKey) {
    const { replay, viaDb } = await isIdempotentReplay(c, idempotencyKey);
    if (replay) {
      if (viaDb) {
        return c.json({
          error: {
            code: 'IDEMPOTENCY_REPLAY',
            message: 'Duplicate booking rejection detected. Original request already processed.',
          },
          replay: true,
        }, 409);
      }
      return c.json({ message: 'Duplicate request ignored', replay: true });
    }
  }
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; /* empty body is OK */ }
  const parsedBody = tripReasonSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedBody.error.issues.map((i) => i.message).join(', ') } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    logger.error('Booking rejection denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
      const trip = await db
        .prepare('SELECT id, driver_id FROM trips WHERE id = ?')
        .bind(tripId)
        .first<TripOwnerRow>();
      if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
      if (trip.driver_id !== user.id) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only the trip driver can reject bookings' } }, 403);
      }

      const rejectUpdate = await db
        .prepare("UPDATE trip_participants SET status = 'rejected' WHERE id = ? AND trip_id = ? AND role = 'rider' AND status = 'requested'")
        .bind(bookingId, tripId)
        .run();
      const rejectRows = getAffectedRows(rejectUpdate);
      if (rejectRows === 0) {
        return c.json({ error: { code: 'CONFLICT', message: 'Booking is no longer pending' } }, 409);
      }

      // Emit real-time event
      eventBus.emit('booking:rejected', { bookingId, tripId, rejectedBy: user.id }, user.id);

      // Send notification to rider about rejection
      const notifications = new NotificationService(c.env);
      try {
        const riderDetails = await db.prepare(`
            SELECT u.email, u.first_name_encrypted, tp.user_id, t.title, t.departure_time
            FROM trip_participants tp
            JOIN users u ON tp.user_id = u.id
            JOIN trips t ON tp.trip_id = t.id
            WHERE tp.id = ? AND tp.role = 'rider'
          `).bind(bookingId).first<RejectRiderDetailsRow>();

        if (riderDetails) {
          const riderNotificationPrefs = await getUserNotificationPreferences(db, riderDetails.user_id);

            try {
              if (riderNotificationPrefs.tripUpdates) {
                await createNotification(db, {
                  userId: riderDetails.user_id,
                  tripId: Number.parseInt(tripId, 10),
                  notificationType: 'booking_rejected',
                  channel: 'in_app',
                  status: 'sent',
                  subject: 'Booking request rejected',
                  message: `Your booking request for ${riderDetails.title || 'the trip'} was not accepted.`,
                  metadata: { tripId, bookingId, rejectedBy: user.id },
                });
              }
            } catch (err) {
              logger.warn('Failed to persist booking rejected notification', { error: err instanceof Error ? err.message : String(err) });
            }

          if (notifications.emailAvailable && riderNotificationPrefs.tripUpdates) {
            const riderFirstName = await safeDecryptPII(
              riderDetails.first_name_encrypted, c.env?.ENCRYPTION_KEY, riderDetails.user_id,
            ) ?? 'Rider';

            const reason = parsedBody.data.reason || 'The driver is unable to accommodate this booking';

              await notifications.sendEmail(
                riderDetails.email,
                'Booking Request Update - Klubz',
                `
                <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
                  <h1 style="color:#6B7280">Booking Not Accepted</h1>
                  <p>Hi ${riderFirstName}, unfortunately your booking request was not accepted.</p>
                  <div style="background:#FEF2F2;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #EF4444">
                    <p><strong>Trip:</strong> ${riderDetails.title || 'Trip'}</p>
                    <p><strong>Departure:</strong> ${new Date(riderDetails.departure_time).toLocaleString()}</p>
                    <p><strong>Reason:</strong> ${reason}</p>
                  </div>
                  <p>Don't worry! You can search for other available trips on Klubz.</p>
                </div>
              `,
                `Your Klubz booking request was not accepted. Search for other trips at klubz.com`
              );
          }
        }
      } catch (err) {
        logger.warn('Failed to send rejection notification', { error: err instanceof Error ? err.message : String(err) });
      }
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Reject booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Booking rejection failed' } }, 500);
  }
  return c.json({ message: 'Booking rejected', booking: { id: bookingId, tripId, status: 'rejected', rejectedAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /:tripId/cancel
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/cancel', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-cancel:${tripId}`);
  if (idempotencyKey) {
    const { replay, viaDb } = await isIdempotentReplay(c, idempotencyKey);
    if (replay) {
      if (viaDb) {
        return c.json({
          error: {
            code: 'IDEMPOTENCY_REPLAY',
            message: 'Duplicate trip cancel request detected. Original request already processed.',
          },
          replay: true,
        }, 409);
      }
      return c.json({ message: 'Duplicate request ignored', replay: true });
    }
  }
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsedBody = tripReasonSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedBody.error.issues.map((i) => i.message).join(', ') } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    logger.error('Trip cancellation denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
      const trip = await db
        .prepare('SELECT id, driver_id, status FROM trips WHERE id = ?')
        .bind(tripId)
        .first<TripOwnerRow>();
      if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
      if (trip.driver_id !== user.id) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only the trip driver can cancel this trip' } }, 403);
      }
      if (trip.status === 'cancelled') {
        return c.json({ error: { code: 'CONFLICT', message: 'Trip is already cancelled' } }, 409);
      }
      if (trip.status === 'completed') {
        return c.json({ error: { code: 'CONFLICT', message: 'Completed trips cannot be cancelled' } }, 409);
      }

      const cancelUpdate = await db
        .prepare("UPDATE trips SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('scheduled', 'active')")
        .bind(tripId)
        .run();
      const cancelRows = getAffectedRows(cancelUpdate);
      if (cancelRows === 0) {
        return c.json({ error: { code: 'CONFLICT', message: 'Trip cannot be cancelled from current status' } }, 409);
      }

      const notifications = new NotificationService(c.env);
      let acceptedParticipants: CancelParticipantRow[] = [];
      try {
        const participants = await db.prepare(`
          SELECT u.email, u.first_name_encrypted, tp.user_id, tp.id AS booking_id,
                 tp.payment_intent_id, tp.payment_status,
                 t.title, t.departure_time, t.origin, t.destination
          FROM trip_participants tp
          JOIN users u ON tp.user_id = u.id
          JOIN trips t ON tp.trip_id = t.id
          WHERE tp.trip_id = ? AND tp.status = 'accepted' AND tp.role = 'rider'
        `).bind(tripId).all<CancelParticipantRow>();
        acceptedParticipants = participants.results ?? [];
      } catch (err) {
        logger.warn('Failed to load accepted participants for trip cancellation notifications', {
          error: err instanceof Error ? err.message : String(err),
          tripId,
        });
      }

      const participantCancelUpdate = await db
        .prepare(`
          UPDATE trip_participants
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
          WHERE trip_id = ?
            AND role = 'rider'
            AND status IN ('requested', 'accepted')
        `)
        .bind(tripId)
        .run();
      const participantCancelRows = getAffectedRows(participantCancelUpdate);

      // Emit real-time event
      eventBus.emit('trip:cancelled', {
        tripId,
        cancelledBy: user.id,
        cancelledParticipants: participantCancelRows ?? undefined,
      }, user.id);

      // Notify all accepted participants and issue refunds for paid bookings
      try {
        const reason = parsedBody.data.reason || 'The driver had to cancel this trip';

        // ── Batch-load all notification preferences in one query (no N+1) ──
        const prefsByUserId = new Map<number, boolean>(); // userId → tripUpdates
        if (acceptedParticipants.length > 0) {
          const placeholders = acceptedParticipants.map(() => '?').join(',');
          const userIds = acceptedParticipants.map(p => p.user_id);
          try {
            const prefsRows = await db
              .prepare(`SELECT user_id, notifications_json FROM user_preferences WHERE user_id IN (${placeholders})`)
              .bind(...userIds)
              .all<BatchPrefsRow>();
            for (const row of prefsRows.results ?? []) {
              try {
                const parsed = JSON.parse(row.notifications_json ?? '{}') as Record<string, unknown>;
                prefsByUserId.set(row.user_id, parsed.tripUpdates !== false);
              } catch {
                prefsByUserId.set(row.user_id, true); // default
              }
            }
          } catch {
            // Fallback: default all to true (notify)
          }
        }

        // ── Stripe refunds for paid bookings ──
        const stripe = c.env?.STRIPE_SECRET_KEY ? new StripeService(c.env.STRIPE_SECRET_KEY) : null;
        for (const participant of acceptedParticipants) {
          if (stripe && participant.payment_status === 'paid' && participant.payment_intent_id) {
            try {
              await stripe.createRefund(participant.payment_intent_id);
              await db
                .prepare(`UPDATE trip_participants SET payment_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .bind(participant.booking_id)
                .run();
              logger.info('Stripe refund issued for cancelled trip booking', {
                bookingId: participant.booking_id,
                paymentIntentId: participant.payment_intent_id,
              });
            } catch (err) {
              logger.error('Failed to issue Stripe refund for booking', err instanceof Error ? err : undefined, {
                bookingId: participant.booking_id,
                paymentIntentId: participant.payment_intent_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // ── Per-participant notification (preferences already loaded) ──
        for (const participant of acceptedParticipants) {
          try {
            // Default to notifying if prefs not found
            const wantsUpdates = prefsByUserId.get(participant.user_id) ?? true;

            if (wantsUpdates) {
              try {
                await createNotification(db, {
                  userId: participant.user_id,
                  tripId: Number.parseInt(tripId, 10),
                  notificationType: 'trip_cancelled',
                  channel: 'in_app',
                  status: 'sent',
                  subject: 'Trip cancelled',
                  message: `Your upcoming trip ${participant.title || ''} was cancelled by the driver.`,
                  metadata: { tripId, cancelledBy: user.id },
                });
              } catch (err) {
                logger.warn('Failed to persist trip cancellation notification', { error: err instanceof Error ? err.message : String(err) });
              }
            }

            if (notifications.emailAvailable && wantsUpdates) {
              const firstName = await safeDecryptPII(
                participant.first_name_encrypted, c.env?.ENCRYPTION_KEY, participant.user_id,
              ) ?? 'Rider';

              await notifications.sendEmail(
                participant.email,
                'Trip Cancelled - Klubz',
                `
                  <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
                    <h1 style="color:#EF4444">Trip Cancelled</h1>
                    <p>Hi ${firstName}, unfortunately your upcoming trip has been cancelled.</p>
                    <div style="background:#FEF2F2;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #EF4444">
                      <p><strong>Trip:</strong> ${participant.title || 'Trip'}</p>
                      <p><strong>From:</strong> ${participant.origin}</p>
                      <p><strong>To:</strong> ${participant.destination}</p>
                      <p><strong>Scheduled:</strong> ${new Date(participant.departure_time).toLocaleString()}</p>
                      <p><strong>Reason:</strong> ${reason}</p>
                    </div>
                    <p>We're sorry for the inconvenience. Search for alternative trips on Klubz.</p>
                  </div>
                `,
                `Your Klubz trip on ${new Date(participant.departure_time).toLocaleDateString()} has been cancelled. ${reason}`
              );
            }
          } catch (err) {
            logger.warn('Failed to send cancellation notification to participant', {
              error: err instanceof Error ? err.message : String(err),
              participantId: participant.user_id
            });
          }
        }
      } catch (err) {
        logger.warn('Failed to send cancellation notifications', { error: err instanceof Error ? err.message : String(err) });
      }
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Cancel trip error', err instanceof Error ? err : undefined, { error: parsedError.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Trip cancellation failed' } }, 500);
  }
  return c.json({ message: 'Trip cancelled successfully', trip: { id: tripId, status: 'cancelled', cancelledAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /:tripId/complete
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/complete', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const db = getDBOptional(c);

  if (!db) {
    logger.error('Trip completion denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }

  const trip = await db
    .prepare('SELECT id, driver_id, status FROM trips WHERE id = ?')
    .bind(tripId)
    .first<TripOwnerRow>();

  if (!trip) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
  }
  if (trip.driver_id !== user.id) {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only the trip driver can complete this trip' } }, 403);
  }
  if (trip.status === 'completed') {
    return c.json({ error: { code: 'CONFLICT', message: 'Trip is already completed' } }, 409);
  }
  if (trip.status === 'cancelled') {
    return c.json({ error: { code: 'CONFLICT', message: 'Cancelled trips cannot be completed' } }, 409);
  }

  const completeTripResult = await db
    .prepare("UPDATE trips SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('scheduled', 'active')")
    .bind(tripId)
    .run();
  const completedRows = getAffectedRows(completeTripResult);
  if (completedRows === 0) {
    return c.json({ error: { code: 'CONFLICT', message: 'Trip cannot be completed from current status' } }, 409);
  }

  await db
    .prepare(
      `UPDATE trip_participants
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE trip_id = ? AND (
         (role = 'driver' AND status = 'accepted')
         OR (role = 'rider' AND status = 'accepted')
       )`,
    )
    .bind(tripId)
    .run();

  const acceptedRiders = await db
    .prepare(`SELECT user_id FROM trip_participants WHERE trip_id = ? AND role = 'rider' AND status = 'completed'`)
    .bind(tripId)
    .all<{ user_id: number }>();

  try {
    await awardPointsOnce(db, user.id, 50, 'trip_completed_driver', Number.parseInt(tripId, 10));
    for (const rider of acceptedRiders.results ?? []) {
      await awardPointsOnce(db, rider.user_id, 20, 'trip_completed_rider', Number.parseInt(tripId, 10));
    }
  } catch (err) {
    logger.warn('Trip completion points award failed (non-critical)', {
      tripId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  eventBus.emit('trip:completed', { tripId, completedBy: user.id }, user.id);

  return c.json({ message: 'Trip completed successfully', trip: { id: tripId, status: 'completed', completedAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /:tripId/rate
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/rate', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { rating, comment } = (body as RateRequestBody);
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Rating must be between 1 and 5' } }, 400);
  }
  if (comment && comment.length > 500) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Comment must be < 500 chars' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    logger.error('Trip rating denied because DB is unavailable', undefined, {
      environment: c.env?.ENVIRONMENT || 'unknown',
    });
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Trip service unavailable' } }, 500);
  }
  try {
      const participant = await db
        .prepare('SELECT id, user_id, status FROM trip_participants WHERE trip_id = ? AND user_id = ?')
        .bind(tripId, user.id)
        .first<TripParticipantOwnerRow>();
      if (!participant) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Trip participation not found' } }, 404);
      }
      if (participant.status !== 'completed') {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'You can only rate completed trips' } }, 400);
      }

      await db
        .prepare('UPDATE trip_participants SET rating = ?, review_encrypted = ? WHERE trip_id = ? AND user_id = ?')
        .bind(rating, comment || null, tripId, user.id)
        .run();
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Rate trip error', err instanceof Error ? err : undefined, { error: parsedError.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Trip rating failed' } }, 500);
  }
  return c.json({ message: 'Rating submitted successfully', rating: { tripId, userId: user.id, rating, comment: comment || null, createdAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /:tripId/location  — Driver updates GPS position (CACHE KV only)
// GET  /:tripId/location  — Rider/driver polls last known position
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/location', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = parseInt(c.req.param('tripId'));
  if (isNaN(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { lat, lng, heading, speed, accuracy } = (body as { lat?: number; lng?: number; heading?: number; speed?: number; accuracy?: number }) || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'lat and lng required' } }, 400);
  }

  const db = getDBOptional(c);
  if (db) {
    // Verify caller is the driver of this trip
    const trip = await db
      .prepare('SELECT driver_id FROM trips WHERE id = ?')
      .bind(tripId)
      .first<{ driver_id: number }>();
    if (!trip || trip.driver_id !== user.id) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only the trip driver can update location' } }, 403);
    }
  }

  const payload = JSON.stringify({ lat, lng, heading: heading ?? null, speed: speed ?? null, accuracy: accuracy ?? null, updatedAt: new Date().toISOString() });
  await c.env?.CACHE?.put(`location:trip:${tripId}`, payload, { expirationTtl: 120 });

  // Broadcast via SSE so connected riders see real-time updates
  eventBus.emit('location:update', { tripId, coords: { lat, lng, heading, speed } }, user.id);

  return c.json({ success: true });
});

tripRoutes.get('/:tripId/location', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = parseInt(c.req.param('tripId'));
  if (isNaN(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  // Verify caller is driver or accepted rider
  const db = getDBOptional(c);
  if (db) {
    const trip = await db
      .prepare('SELECT driver_id FROM trips WHERE id = ?')
      .bind(tripId)
      .first<{ driver_id: number }>();
    if (!trip) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
    }
    if (trip.driver_id !== user.id) {
      const participant = await db
        .prepare('SELECT id FROM trip_participants WHERE trip_id = ? AND user_id = ? AND status = ?')
        .bind(tripId, user.id, 'accepted')
        .first<{ id: number }>();
      if (!participant) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Access denied' } }, 403);
      }
    }
  }

  const raw = await c.env?.CACHE?.get(`location:trip:${tripId}`, 'text');
  if (!raw) {
    return c.json({ location: null });
  }
  return c.json({ location: JSON.parse(raw) });
});

// ---------------------------------------------------------------------------
// GET /:tripId/route  — Return full route polyline + turn-by-turn steps
// ---------------------------------------------------------------------------

tripRoutes.get('/:tripId/route', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = parseInt(c.req.param('tripId'));
  if (isNaN(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  const trip = await db
    .prepare('SELECT id, driver_id, origin, destination FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ id: number; driver_id: number; origin: string; destination: string }>();

  if (!trip) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
  }

  const isDriver = trip.driver_id === user.id;
  if (!isDriver) {
    const participant = await db
      .prepare('SELECT id FROM trip_participants WHERE trip_id = ? AND user_id = ? AND status = ?')
      .bind(tripId, user.id, 'accepted')
      .first<{ id: number }>();
    if (!participant) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Access denied' } }, 403);
    }
  }

  // Return cached route if available
  const cacheKey = `route:trip:${tripId}`;
  const cached = await c.env?.CACHE?.get(cacheKey, 'text');
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  // Build route from origin/destination — decode stored lat/lng or fallback to text
  // Route is fetched via the GeoService (Mapbox Directions)
  try {
    const { getGeoService } = await import('../integrations/geocoding');
    const geoSvc = getGeoService(c.env);
    if (!geoSvc) {
      return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Route service not configured' } }, 503);
    }

    // Parse origin/destination — stored as JSON or plain text
    let origin: { lat: number; lng: number };
    let destination: { lat: number; lng: number };
    try {
      origin = JSON.parse(trip.origin);
      destination = JSON.parse(trip.destination);
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Trip location data not geocoded' } }, 422);
    }

    const route = await geoSvc.getRoute(origin, destination);
    const response = { tripId, ...route };
    await c.env?.CACHE?.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });
    return c.json(response);
  } catch (err) {
    logger.error('Route fetch failed', err instanceof Error ? err : undefined, { tripId });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch route' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /:tripId/dispute  — Rider/driver files a dispute
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/dispute', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = parseInt(c.req.param('tripId'));
  if (isNaN(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { reason, evidenceText } = (body as { reason?: string; evidenceText?: string }) || {};
  if (!reason || reason.trim().length < 10) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Reason must be at least 10 characters' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  const tripState = await db
    .prepare('SELECT id, status FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ id: number; status: string }>();

  if (!tripState) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
  }
  if (tripState.status !== 'completed') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Disputes can only be filed for completed trips' } }, 400);
  }

  // Verify the user was part of the trip
  const participation = await db
    .prepare('SELECT id FROM trip_participants WHERE trip_id = ? AND user_id = ?')
    .bind(tripId, user.id)
    .first<{ id: number }>();

  if (!participation) {
    // Check if driver
    const trip = await db
      .prepare('SELECT id FROM trips WHERE id = ? AND driver_id = ?')
      .bind(tripId, user.id)
      .first<{ id: number }>();
    if (!trip) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'You were not part of this trip' } }, 403);
      }
  }

  const existingOpen = await db
    .prepare("SELECT id FROM disputes WHERE trip_id = ? AND filed_by = ? AND status IN ('open', 'investigating')")
    .bind(tripId, user.id)
    .first<{ id: number }>();
  if (existingOpen) {
    return c.json({ error: { code: 'CONFLICT', message: 'An open dispute for this trip already exists' } }, 409);
  }

  try {
    const result = await db
      .prepare(
        `INSERT INTO disputes (trip_id, filed_by, reason, evidence_text) VALUES (?, ?, ?, ?)`,
      )
      .bind(tripId, user.id, reason.trim(), evidenceText?.trim() || null)
      .run();

    return c.json({ disputeId: result.meta?.last_row_id, status: 'open' }, 201);
  } catch (err) {
    logger.error('dispute create failed', err instanceof Error ? err : undefined, { tripId, userId: user.id });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to file dispute' } }, 500);
  }
});

export default tripRoutes;
