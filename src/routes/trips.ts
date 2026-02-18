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
import { getDB } from '../lib/db';
import { matchRiderToDrivers } from '../lib/matching/engine';
import type { RiderRequest, DriverTrip } from '../lib/matching/types';
import { ValidationError } from '../lib/errors';
import { NotificationService } from '../integrations/notifications';
import { decrypt } from '../lib/encryption';
import { getCacheService } from '../lib/cache';
import { createNotification } from '../lib/notificationStore';
import { getUserNotificationPreferences } from '../lib/userPreferences';

export const tripRoutes = new Hono<AppEnv>();

tripRoutes.use('*', authMiddleware());

interface LocationInput {
  address?: string;
  [key: string]: unknown;
}

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
}

interface TripSeatRow {
  available_seats: number;
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

interface BookRequestBody {
  pickupLocation?: LocationInput;
  dropoffLocation?: LocationInput;
  passengers?: number;
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
}

interface D1RunResult {
  meta?: {
    changes?: number;
  };
}

const offerTripSchema = z.object({
  pickupLocation: z.object({
    address: z.string().trim().min(1).optional(),
  }).passthrough(),
  dropoffLocation: z.object({
    address: z.string().trim().min(1).optional(),
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

async function isIdempotentReplay(c: Context<AppEnv>, key: string): Promise<boolean> {
  const cache = c.env?.CACHE;
  if (!cache) return false;

  const existing = await cache.get(key, 'text');
  if (existing) return true;

  await cache.put(key, 'seen', { expirationTtl: 10 * 60 }); // 10 minutes
  return false;
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
        routeDistanceKm: Number(t.price_per_seat) || undefined,
      };
    });

    // Use matching algorithm
    const { matches } = matchRiderToDrivers(riderRequest, drivers);
    const driverById = new Map(drivers.map((d) => [d.id, d]));

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
      pricePerSeat: 35,
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

  const { pickupLocation, dropoffLocation, passengers = 1 } = (body as BookRequestBody);
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-book:${tripId}`);
  if (idempotencyKey && await isIdempotentReplay(c, idempotencyKey)) {
    return c.json({
      error: {
        code: 'IDEMPOTENCY_REPLAY',
        message: 'Duplicate booking request detected. Original request already processed.',
      }
    }, 409);
  }
  if (!pickupLocation || !dropoffLocation) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Pickup and dropoff locations are required' } }, 400);
  }
  if (passengers < 1 || passengers > 4) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Passenger count must be between 1 and 4' } }, 400);
  }

  const db = getDB(c);
  if (db) {
    try {
      // Verify trip exists and has seats
      const trip = await db.prepare('SELECT id, available_seats, status FROM trips WHERE id = ?').bind(tripId).first<TripSeatRow>();
      if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
      if (trip.available_seats < passengers) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Not enough seats' } }, 400);
      }

      await db
        .prepare(
          `INSERT INTO trip_participants (trip_id, user_id, role, status, pickup_location_encrypted, dropoff_location_encrypted)
           VALUES (?, ?, 'rider', 'requested', ?, ?)`
        )
        .bind(
          tripId, user.id,
          pickupLocation.address || JSON.stringify(pickupLocation),
          dropoffLocation.address || JSON.stringify(dropoffLocation),
        )
        .run();

      // Emit real-time booking event
      eventBus.emit('booking:requested', {
        tripId,
        passengerId: user.id,
        passengers,
      }, user.id);

      // Send notification to driver
      const notifications = new NotificationService(c.env);
      if (notifications.emailAvailable) {
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

            const driverFirstName = tripDetails.first_name_encrypted
              ? await decrypt(JSON.parse(tripDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, tripDetails.driver_id.toString())
              : 'Driver';

            const riderDetails = await db.prepare('SELECT first_name_encrypted, last_name_encrypted FROM users WHERE id = ?').bind(user.id).first<RiderNameRow>();
            const riderFirstName = riderDetails?.first_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : 'A rider';
            const riderLastName = riderDetails?.last_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.last_name_encrypted).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : '';

            if (driverNotificationPrefs.tripUpdates) {
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
      }

      return c.json({ message: 'Booking request submitted successfully', booking: { tripId, passengerId: user.id, status: 'requested', createdAt: new Date().toISOString() } });
    } catch (err: unknown) {
      const parsedError = parseError(err);
      logger.error('Booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
      if (parsedError.message.includes('UNIQUE')) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Already booked on this trip' } }, 409);
      }
    }
  }

  return c.json({ message: 'Booking request submitted successfully', booking: { tripId, status: 'requested', createdAt: new Date().toISOString() } });
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
  const { pickupLocation, dropoffLocation, scheduledTime, availableSeats, price, vehicleInfo, notes } = parsed.data;
  const idempotencyKey = getIdempotencyKey(c, user.id, 'trip-offer');
  if (idempotencyKey && await isIdempotentReplay(c, idempotencyKey)) {
    return c.json({
      error: {
        code: 'IDEMPOTENCY_REPLAY',
        message: 'Duplicate trip offer request detected. Original request already processed.',
      }
    }, 409);
  }

  if (new Date(scheduledTime).getTime() <= Date.now()) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Scheduled time must be in the future' } }, 400);
  }

  const db = getDB(c);
  if (db) {
    try {
      const result = await db
        .prepare(
          `INSERT INTO trips (title, description, origin, destination, origin_hash, destination_hash, departure_time, available_seats, total_seats, price_per_seat, currency, status, vehicle_type, vehicle_model_encrypted, vehicle_plate_encrypted, driver_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ZAR', 'scheduled', ?, ?, ?, ?)`
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
          availableSeats + 1,
          price || 35.00,
          vehicleInfo.make + ' ' + vehicleInfo.model,
          vehicleInfo.licensePlate,
          user.id,
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
    }
  }

  return c.json({
    message: 'Trip offer created successfully',
    trip: { id: Date.now(), status: 'scheduled', availableSeats, createdAt: new Date().toISOString() },
  });
});

// ---------------------------------------------------------------------------
// POST /:tripId/bookings/:bookingId/accept
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/bookings/:bookingId/accept', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const bookingId = c.req.param('bookingId');
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-accept:${tripId}:${bookingId}`);
  if (idempotencyKey && await isIdempotentReplay(c, idempotencyKey)) {
    return c.json({ message: 'Duplicate request ignored', replay: true });
  }

  const db = getDB(c);
  if (db) {
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
        .prepare("UPDATE trip_participants SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ? AND status = 'requested'")
        .bind(bookingId, tripId)
        .run();
      const bookingRows = getAffectedRows(bookingUpdate);
      if (bookingRows === 0) {
        return c.json({ error: { code: 'CONFLICT', message: 'Booking is no longer pending' } }, 409);
      }

      // Decrement seats only if availability exists.
      const seatUpdate = await db
        .prepare('UPDATE trips SET available_seats = available_seats - 1 WHERE id = ? AND available_seats > 0')
        .bind(tripId)
        .run();
      const seatRows = getAffectedRows(seatUpdate);
      if (seatRows === 0) {
        // Compensate booking transition when seat decrement loses a race.
        await db
          .prepare("UPDATE trip_participants SET status = 'requested', accepted_at = NULL WHERE id = ? AND trip_id = ? AND status = 'accepted'")
          .bind(bookingId, tripId)
          .run();
        return c.json({ error: { code: 'CONFLICT', message: 'No seats available' } }, 409);
      }

      // Emit real-time event
      eventBus.emit('booking:accepted', { bookingId, tripId, acceptedBy: user.id }, user.id);

      // Send notification to rider
      const notifications = new NotificationService(c.env);
      if (notifications.emailAvailable || notifications.smsAvailable) {
        try {
          const bookingDetails = await db.prepare(`
            SELECT tp.user_id, t.title, t.origin, t.destination, t.departure_time, t.price_per_seat,
                   u.email, u.first_name_encrypted, u.last_name_encrypted, u.phone_encrypted,
                   d.first_name_encrypted as driver_first_name
            FROM trip_participants tp
            JOIN trips t ON tp.trip_id = t.id
            JOIN users u ON tp.user_id = u.id
            JOIN users d ON t.driver_id = d.id
            WHERE tp.id = ?
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

            const riderFirstName = bookingDetails.first_name_encrypted
              ? await decrypt(JSON.parse(bookingDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, bookingDetails.user_id.toString())
              : 'Rider';

            const driverFirstName = bookingDetails.driver_first_name
              ? await decrypt(JSON.parse(bookingDetails.driver_first_name).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : 'Your driver';

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
                const phone = await decrypt(JSON.parse(bookingDetails.phone_encrypted).data, c.env.ENCRYPTION_KEY, bookingDetails.user_id.toString());
                await notifications.sendSMS(
                  phone,
                  `Klubz: Your booking is confirmed! Trip with ${driverFirstName} on ${new Date(bookingDetails.departure_time).toLocaleDateString()} at ${new Date(bookingDetails.departure_time).toLocaleTimeString()}. Check your email for details.`
                );
              } catch (err) {
                logger.warn('Failed to send SMS confirmation', { error: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        } catch (err) {
          logger.warn('Failed to send booking confirmation', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      return c.json({ message: 'Booking accepted successfully', booking: { id: bookingId, tripId, status: 'accepted', acceptedAt: new Date().toISOString() } });
    } catch (err: unknown) {
      const parsedError = parseError(err);
      logger.error('Accept booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
    }
  }

  return c.json({ message: 'Booking accepted successfully', booking: { id: bookingId, tripId, status: 'accepted', acceptedAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /:tripId/bookings/:bookingId/reject
// ---------------------------------------------------------------------------

tripRoutes.post('/:tripId/bookings/:bookingId/reject', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = c.req.param('tripId');
  const bookingId = c.req.param('bookingId');
  const idempotencyKey = getIdempotencyKey(c, user.id, `trip-reject:${tripId}:${bookingId}`);
  if (idempotencyKey && await isIdempotentReplay(c, idempotencyKey)) {
    return c.json({ message: 'Duplicate request ignored', replay: true });
  }
  let body: unknown = {};
  try { body = await c.req.json(); } catch { /* empty body is OK */ }

  const db = getDB(c);
  if (db) {
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
        .prepare("UPDATE trip_participants SET status = 'rejected' WHERE id = ? AND trip_id = ? AND status = 'requested'")
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
      if (notifications.emailAvailable) {
        try {
          const riderDetails = await db.prepare(`
            SELECT u.email, u.first_name_encrypted, tp.user_id, t.title, t.departure_time
            FROM trip_participants tp
            JOIN users u ON tp.user_id = u.id
            JOIN trips t ON tp.trip_id = t.id
            WHERE tp.id = ?
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

            const riderFirstName = riderDetails.first_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, riderDetails.user_id.toString())
              : 'Rider';

            const reason = (body as { reason?: string }).reason || 'The driver is unable to accommodate this booking';

            if (riderNotificationPrefs.tripUpdates) {
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
      }
    } catch (err: unknown) {
      const parsedError = parseError(err);
      logger.error('Reject booking error', err instanceof Error ? err : undefined, { error: parsedError.message });
    }
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
  if (idempotencyKey && await isIdempotentReplay(c, idempotencyKey)) {
    return c.json({ message: 'Duplicate request ignored', replay: true });
  }
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }

  const db = getDB(c);
  if (db) {
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

      // Emit real-time event
      eventBus.emit('trip:cancelled', { tripId, cancelledBy: user.id }, user.id);

      // Notify all accepted participants about cancellation
      const notifications = new NotificationService(c.env);
      if (notifications.emailAvailable) {
        try {
          const participants = await db.prepare(`
            SELECT u.email, u.first_name_encrypted, tp.user_id, t.title, t.departure_time, t.origin, t.destination
            FROM trip_participants tp
            JOIN users u ON tp.user_id = u.id
            JOIN trips t ON tp.trip_id = t.id
            WHERE tp.trip_id = ? AND tp.status = 'accepted' AND tp.role = 'rider'
          `).bind(tripId).all();

          const reason = (body as { reason?: string }).reason || 'The driver had to cancel this trip';

          for (const participant of (participants.results ?? []) as CancelParticipantRow[]) {
            try {
              const participantNotificationPrefs = await getUserNotificationPreferences(db, participant.user_id);

              try {
                if (participantNotificationPrefs.tripUpdates) {
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
                }
              } catch (err) {
                logger.warn('Failed to persist trip cancellation notification', { error: err instanceof Error ? err.message : String(err) });
              }

              const firstName = participant.first_name_encrypted
                ? await decrypt(JSON.parse(participant.first_name_encrypted).data, c.env.ENCRYPTION_KEY, participant.user_id.toString())
                : 'Rider';

              if (participantNotificationPrefs.tripUpdates) {
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
      }
    } catch (err: unknown) {
      const parsedError = parseError(err);
      logger.error('Cancel trip error', err instanceof Error ? err : undefined, { error: parsedError.message });
    }
  }

  return c.json({ message: 'Trip cancelled successfully', trip: { id: tripId, status: 'cancelled', cancelledAt: new Date().toISOString() } });
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

  const db = getDB(c);
  if (db) {
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
    }
  }

  return c.json({ message: 'Rating submitted successfully', rating: { tripId, userId: user.id, rating, comment: comment || null, createdAt: new Date().toISOString() } });
});

export default tripRoutes;
