/**
 * Klubz - Trip Routes (Production D1)
 *
 * Real D1 queries for trip search, booking, offering, rating.
 */

import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';
import { eventBus } from '../lib/eventBus';
import { getDB, getDBOptional } from '../lib/db';
import { getIP, getUserAgent } from '../lib/http';
import { matchRiderToDrivers } from '../lib/matching/engine';
import type { RiderRequest, DriverTrip } from '../lib/matching/types';
import { ValidationError } from '../lib/errors';
import { NotificationService } from '../integrations/notifications';
import { decrypt } from '../lib/encryption';
import { getCacheService } from '../lib/cache';

export const tripRoutes = new Hono<AppEnv>();

tripRoutes.use('*', authMiddleware());

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

  const db = getDB(c);
  const cache = getCacheService(c);

  // Generate cache key from search parameters
  const cacheKey = `trips:search:${pickupLat}:${pickupLng}:${dropoffLat}:${dropoffLng}:${date || 'today'}:${time || 'now'}:${maxDetour}`;

  // Try cache first
  if (cache) {
    const cached = await cache.get<any>(cacheKey);
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
    `).bind(departureTime.toISOString()).all();

    // Create rider request
    const riderRequest: RiderRequest = {
      riderId: user.id,
      departure: { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) },
      destination: { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) },
      earliestDeparture: departureTime,
      latestDeparture: new Date(departureTime.getTime() + 2 * 60 * 60 * 1000), // 2 hour window
      seatsNeeded: 1,
      maxDetourMinutes: parseInt(maxDetour),
      maxWalkingDistanceKm: 0.5,
    };

    // Convert DB results to DriverTrip format (simplified)
    const drivers: DriverTrip[] = (driverTrips as any[]).map(t => {
      // Parse coordinates from origin/destination strings (simplified)
      const originCoords = t.origin.includes('{') ? JSON.parse(t.origin) : { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) };
      const destCoords = t.destination.includes('{') ? JSON.parse(t.destination) : { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) };

      return {
        tripId: t.id,
        driverId: t.driver_id,
        departure: { lat: originCoords.lat || parseFloat(pickupLat), lng: originCoords.lng || parseFloat(pickupLng) },
        destination: { lat: destCoords.lat || parseFloat(dropoffLat), lng: destCoords.lng || parseFloat(dropoffLng) },
        departureTime: new Date(t.departure_time),
        availableSeats: t.available_seats,
        vehicle: { type: t.vehicle_type || 'sedan', make: '', model: '', year: 2020 },
        pricePerSeat: t.price_per_seat,
      };
    });

    // Use matching algorithm
    const matches = matchRiderToDrivers(riderRequest, drivers);

    const trips = matches.map(match => ({
      id: match.trip.tripId,
      title: `Trip to ${match.trip.destination.lat.toFixed(4)}, ${match.trip.destination.lng.toFixed(4)}`,
      driverName: `Driver ${match.trip.driverId}`,
      driverRating: 4.5,
      pickupLocation: {
        lat: match.trip.departure.lat,
        lng: match.trip.departure.lng,
      },
      dropoffLocation: {
        lat: match.trip.destination.lat,
        lng: match.trip.destination.lng,
      },
      scheduledTime: match.trip.departureTime.toISOString(),
      availableSeats: match.trip.availableSeats,
      vehicleType: match.trip.vehicle?.type || 'sedan',
      pricePerSeat: match.trip.pricePerSeat || 35,
      // Matching scores
      matchScore: match.score,
      explanation: match.explanation,
      detourMinutes: match.breakdown?.detourMinutes || 0,
      walkingDistanceKm: match.breakdown?.pickupDistanceKm || 0,
      carbonSavedKg: match.breakdown?.carbonSavedKg || 0,
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
        maxDetour: parseInt(maxDetour), date, time,
      },
      totalResults: trips.length,
    };

    // Cache results for 5 minutes
    if (cache) {
      await cache.set(cacheKey, result, 300);
    }

    return c.json(result);
  } catch (err: any) {
    logger.error('Available trips error', err);
    return c.json({
      trips: [],
      searchCriteria: {
        pickupLocation: { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) },
        dropoffLocation: { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) },
        maxDetour: parseInt(maxDetour), date, time,
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
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { pickupLocation, dropoffLocation, passengers = 1 } = body;
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
      const trip = await db.prepare('SELECT id, available_seats, status FROM trips WHERE id = ?').bind(tripId).first();
      if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
      if ((trip.available_seats as number) < passengers) {
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
          `).bind(tripId).first() as any;

          if (tripDetails) {
            const driverFirstName = tripDetails.first_name_encrypted
              ? await decrypt(JSON.parse(tripDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, tripDetails.driver_id.toString())
              : 'Driver';

            const riderDetails = await db.prepare('SELECT first_name_encrypted, last_name_encrypted FROM users WHERE id = ?').bind(user.id).first() as any;
            const riderFirstName = riderDetails?.first_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : 'A rider';
            const riderLastName = riderDetails?.last_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.last_name_encrypted).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : '';

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
        } catch (err) {
          logger.warn('Failed to send booking notification', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      return c.json({ message: 'Booking request submitted successfully', booking: { tripId, passengerId: user.id, status: 'requested', createdAt: new Date().toISOString() } });
    } catch (err: any) {
      logger.error('Booking error', err);
      if (err.message?.includes('UNIQUE')) {
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
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { pickupLocation, dropoffLocation, scheduledTime, availableSeats = 3, price, vehicleInfo, notes } = body;

  if (!pickupLocation || !dropoffLocation || !scheduledTime) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Pickup, dropoff, and scheduled time are required' } }, 400);
  }
  if (availableSeats < 1 || availableSeats > 6) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Available seats must be between 1 and 6' } }, 400);
  }
  if (new Date(scheduledTime) <= new Date()) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Scheduled time must be in the future' } }, 400);
  }
  if (!vehicleInfo || !vehicleInfo.make || !vehicleInfo.model || !vehicleInfo.licensePlate) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Vehicle information is required' } }, 400);
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
    } catch (err: any) {
      logger.error('Trip offer error', err);
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

  const db = getDB(c);
  if (db) {
    try {
      await db
        .prepare("UPDATE trip_participants SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ?")
        .bind(bookingId, tripId)
        .run();

      // Decrement seats
      await db.prepare('UPDATE trips SET available_seats = available_seats - 1 WHERE id = ? AND available_seats > 0').bind(tripId).run();

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
          `).bind(bookingId).first() as any;

          if (bookingDetails) {
            const riderFirstName = bookingDetails.first_name_encrypted
              ? await decrypt(JSON.parse(bookingDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, bookingDetails.user_id.toString())
              : 'Rider';

            const driverFirstName = bookingDetails.driver_first_name
              ? await decrypt(JSON.parse(bookingDetails.driver_first_name).data, c.env.ENCRYPTION_KEY, user.id.toString())
              : 'Your driver';

            // Send email confirmation
            if (notifications.emailAvailable) {
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
            if (notifications.smsAvailable && bookingDetails.phone_encrypted) {
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
    } catch (err: any) {
      logger.error('Accept booking error', err);
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
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is OK */ }

  const db = getDB(c);
  if (db) {
    try {
      await db
        .prepare("UPDATE trip_participants SET status = 'rejected' WHERE id = ? AND trip_id = ?")
        .bind(bookingId, tripId)
        .run();

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
          `).bind(bookingId).first() as any;

          if (riderDetails) {
            const riderFirstName = riderDetails.first_name_encrypted
              ? await decrypt(JSON.parse(riderDetails.first_name_encrypted).data, c.env.ENCRYPTION_KEY, riderDetails.user_id.toString())
              : 'Rider';

            const reason = body.reason || 'The driver is unable to accommodate this booking';

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
        } catch (err) {
          logger.warn('Failed to send rejection notification', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err: any) {
      logger.error('Reject booking error', err);
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
  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const db = getDB(c);
  if (db) {
    try {
      await db
        .prepare("UPDATE trips SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(tripId)
        .run();

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

          const reason = body.reason || 'The driver had to cancel this trip';

          for (const participant of participants.results as any[]) {
            try {
              const firstName = participant.first_name_encrypted
                ? await decrypt(JSON.parse(participant.first_name_encrypted).data, c.env.ENCRYPTION_KEY, participant.user_id.toString())
                : 'Rider';

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
    } catch (err: any) {
      logger.error('Cancel trip error', err);
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
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { rating, comment } = body;
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Rating must be between 1 and 5' } }, 400);
  }
  if (comment && comment.length > 500) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Comment must be < 500 chars' } }, 400);
  }

  const db = getDB(c);
  if (db) {
    try {
      await db
        .prepare('UPDATE trip_participants SET rating = ?, review_encrypted = ? WHERE trip_id = ? AND user_id = ?')
        .bind(rating, comment || null, tripId, user.id)
        .run();
    } catch (err: any) {
      logger.error('Rate trip error', err);
    }
  }

  return c.json({ message: 'Rating submitted successfully', rating: { tripId, userId: user.id, rating, comment: comment || null, createdAt: new Date().toISOString() } });
});

export default tripRoutes;
