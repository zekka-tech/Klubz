/**
 * Klubz Smart Trip Pooling - Hono API Routes
 *
 * Production-grade REST API for the matching engine.
 * Mounts at /api/matching/* and provides endpoints for:
 *
 *   POST   /api/matching/driver-trips          Create a driver trip offer
 *   GET    /api/matching/driver-trips           List driver's trips
 *   GET    /api/matching/driver-trips/:id       Get single driver trip
 *   PUT    /api/matching/driver-trips/:id       Update driver trip
 *   DELETE /api/matching/driver-trips/:id       Cancel driver trip
 *
 *   POST   /api/matching/rider-requests         Create a rider request
 *   GET    /api/matching/rider-requests          List rider's requests
 *   GET    /api/matching/rider-requests/:id      Get single rider request
 *   DELETE /api/matching/rider-requests/:id      Cancel rider request
 *
 *   POST   /api/matching/find                   Find matches for a rider
 *   POST   /api/matching/find-pool              Find optimized pool for a rider
 *   GET    /api/matching/results/:riderRequestId Get match results
 *
 *   POST   /api/matching/confirm                Confirm a match
 *   POST   /api/matching/reject                 Reject a match
 *
 *   POST   /api/matching/batch                  Batch-match all pending riders
 *
 *   GET    /api/matching/config                 Get matching config
 *   PUT    /api/matching/config                 Update matching config (admin)
 *
 *   GET    /api/matching/stats                  Get matching statistics
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  matchRiderToDrivers,
  optimizePool,
  MatchingRepository,
  DEFAULT_MATCH_CONFIG,
} from '../lib/matching';
import type {
  RiderRequest,
  GeoPoint,
  FindMatchesResponse,
  DriverTripStatus,
  RiderRequestStatus,
} from '../lib/matching';

// ---------------------------------------------------------------------------
// Zod Schemas for input validation
// ---------------------------------------------------------------------------

const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

const vehicleSchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().optional(),
  color: z.string().optional(),
  licensePlate: z.string().min(1),
  capacity: z.number().int().min(1),
});

const createDriverTripSchema = z.object({
  departure: geoPointSchema,
  destination: geoPointSchema,
  shiftLocation: geoPointSchema.optional(),
  departureTime: z.number().int().positive(),
  arrivalTime: z.number().int().positive().optional(),
  availableSeats: z.number().int().min(1).max(8),
  totalSeats: z.number().int().min(1).max(8),
  routePolyline: z.array(geoPointSchema).optional(),
  routePolylineEncoded: z.string().optional(),
  vehicle: vehicleSchema.optional(),
});

const riderPreferencesSchema = z.object({
  maxWalkDistanceKm: z.number().positive().optional(),
  maxDetourMinutes: z.number().positive().optional(),
  genderPreference: z.enum(['any', 'male', 'female']).optional(),
  minDriverRating: z.number().min(1).max(5).optional(),
}).optional();

const createRiderRequestSchema = z.object({
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  earliestDeparture: z.number().int().positive(),
  latestDeparture: z.number().int().positive(),
  seatsNeeded: z.number().int().min(1).max(6).optional(),
  preferences: riderPreferencesSchema,
});

const findMatchesSchema = z.object({
  riderRequestId: z.string().optional(),
  pickup: geoPointSchema.optional(),
  dropoff: geoPointSchema.optional(),
  earliestDeparture: z.number().int().positive().optional(),
  latestDeparture: z.number().int().positive().optional(),
  seatsNeeded: z.number().int().min(1).optional(),
  preferences: riderPreferencesSchema,
  maxResults: z.number().int().min(1).max(50).optional(),
});

const confirmMatchSchema = z.object({
  matchId: z.string().min(1),
  driverTripId: z.string().min(1),
  riderRequestId: z.string().min(1),
});

const rejectMatchSchema = z.object({
  matchId: z.string().min(1),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Bindings type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createMatchingRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', authMiddleware());

  function isAdminRole(user: AuthUser): boolean {
    return user.role === 'admin' || user.role === 'super_admin';
  }

  function parseDriverTripStatus(status?: string): DriverTripStatus | undefined {
    if (!status) return undefined;
    const allowed: DriverTripStatus[] = ['offered', 'active', 'completed', 'cancelled', 'expired'];
    return allowed.includes(status as DriverTripStatus) ? (status as DriverTripStatus) : undefined;
  }

  function parseRiderRequestStatus(status?: string): RiderRequestStatus | undefined {
    if (!status) return undefined;
    const allowed: RiderRequestStatus[] = ['pending', 'matched', 'confirmed', 'in_progress', 'completed', 'cancelled', 'expired'];
    return allowed.includes(status as RiderRequestStatus) ? (status as RiderRequestStatus) : undefined;
  }

  function parseQueryInteger(
    value: string | undefined,
    defaultValue: number,
    options: { min: number; max: number },
  ): number | null {
    if (value === undefined) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || `${parsed}` !== value.trim()) {
      return null;
    }
    if (parsed < options.min || parsed > options.max) {
      return null;
    }
    return parsed;
  }

  // Helper to get repository
  function getRepo(c: Context<AppEnv>): MatchingRepository {
    return new MatchingRepository(c.env.DB, c.env.CACHE);
  }

  // Helper to generate UUIDs (edge-safe)
  function uuid(): string {
    return crypto.randomUUID();
  }

  // =========================================================================
  // Driver Trip Routes
  // =========================================================================

  /**
   * POST /driver-trips - Create a driver trip offer
   */
  app.post('/driver-trips', async (c) => {
    const body = await c.req.json();
    const parsed = createDriverTripSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const data = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const id = uuid();

    // Decode polyline if provided as string
    let routePolyline = data.routePolyline;
    if (!routePolyline && data.routePolylineEncoded) {
      const { decodePolyline } = await import('../lib/matching/geo');
      routePolyline = decodePolyline(data.routePolylineEncoded);
    }

    const trip = await repo.createDriverTrip(id, Number(user?.id) || 0, {
      departure: data.departure,
      destination: data.destination,
      shiftLocation: data.shiftLocation,
      departureTime: data.departureTime,
      arrivalTime: data.arrivalTime,
      availableSeats: data.availableSeats,
      totalSeats: data.totalSeats,
      routePolyline,
      vehicle: data.vehicle,
      organizationId: user?.organizationId,
    });

    return c.json(
      { message: 'Driver trip created successfully', trip },
      201,
    );
  });

  /**
   * GET /driver-trips - List driver's trips
   */
  app.get('/driver-trips', async (c) => {
    const user = c.get('user') as AuthUser;
    const statusRaw = c.req.query('status');
    const status = parseDriverTripStatus(statusRaw);
    if (statusRaw && !status) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status query parameter' } }, 400);
    }

    const limit = parseQueryInteger(c.req.query('limit'), 50, { min: 1, max: 100 });
    if (limit === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
    }

    const offset = parseQueryInteger(c.req.query('offset'), 0, { min: 0, max: 100000 });
    if (offset === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid offset query parameter' } }, 400);
    }

    const repo = getRepo(c);
    const trips = await repo.listDriverTrips(
      Number(user?.id) || 0,
      status,
      limit,
      offset,
    );

    return c.json({ trips, count: trips.length });
  });

  /**
   * GET /driver-trips/:id - Get single driver trip
   */
  app.get('/driver-trips/:id', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const trip = await repo.getDriverTrip(id);

    if (!trip) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Driver trip not found' } }, 404);
    }
    if (!isAdminRole(user) && trip.driverId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to access this driver trip' } }, 403);
    }

    return c.json({ trip });
  });

  /**
   * PUT /driver-trips/:id - Update driver trip (seats, status)
   */
  app.put('/driver-trips/:id', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user') as AuthUser;
    const body = await c.req.json();
    const repo = getRepo(c);

    const trip = await repo.getDriverTrip(id);
    if (!trip) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Driver trip not found' } }, 404);
    }
    if (!isAdminRole(user) && trip.driverId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to update this driver trip' } }, 403);
    }

    if (body.availableSeats !== undefined) {
      await repo.updateDriverTripSeats(id, body.availableSeats);
    }
    if (body.status) {
      await repo.updateDriverTripStatus(id, body.status);
    }

    const updated = await repo.getDriverTrip(id);
    return c.json({ message: 'Trip updated', trip: updated });
  });

  /**
   * DELETE /driver-trips/:id - Cancel driver trip
   */
  app.delete('/driver-trips/:id', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);

    const trip = await repo.getDriverTrip(id);
    if (!trip) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Driver trip not found' } }, 404);
    }
    if (!isAdminRole(user) && trip.driverId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to cancel this driver trip' } }, 403);
    }

    await repo.updateDriverTripStatus(id, 'cancelled');
    return c.json({ message: 'Driver trip cancelled' });
  });

  // =========================================================================
  // Rider Request Routes
  // =========================================================================

  /**
   * POST /rider-requests - Create a rider request
   */
  app.post('/rider-requests', async (c) => {
    const body = await c.req.json();
    const parsed = createRiderRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const data = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const id = uuid();

    // Validate time window
    if (data.latestDeparture <= data.earliestDeparture) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'latestDeparture must be after earliestDeparture' } },
        400,
      );
    }

    const request = await repo.createRiderRequest(id, Number(user?.id) || 0, {
      pickup: data.pickup,
      dropoff: data.dropoff,
      earliestDeparture: data.earliestDeparture,
      latestDeparture: data.latestDeparture,
      seatsNeeded: data.seatsNeeded,
      preferences: data.preferences,
      organizationId: user?.organizationId,
    });

    return c.json(
      { message: 'Rider request created successfully', request },
      201,
    );
  });

  /**
   * GET /rider-requests - List rider's requests
   */
  app.get('/rider-requests', async (c) => {
    const user = c.get('user') as AuthUser;
    const statusRaw = c.req.query('status');
    const status = parseRiderRequestStatus(statusRaw);
    if (statusRaw && !status) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status query parameter' } }, 400);
    }

    const limit = parseQueryInteger(c.req.query('limit'), 50, { min: 1, max: 100 });
    if (limit === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
    }

    const offset = parseQueryInteger(c.req.query('offset'), 0, { min: 0, max: 100000 });
    if (offset === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid offset query parameter' } }, 400);
    }

    const repo = getRepo(c);
    const requests = await repo.listRiderRequests(
      Number(user?.id) || 0,
      status,
      limit,
      offset,
    );

    return c.json({ requests, count: requests.length });
  });

  /**
   * GET /rider-requests/:id - Get single rider request
   */
  app.get('/rider-requests/:id', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const request = await repo.getRiderRequest(id);

    if (!request) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
    }
    if (!isAdminRole(user) && request.riderId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to access this rider request' } }, 403);
    }

    return c.json({ request });
  });

  /**
   * DELETE /rider-requests/:id - Cancel rider request
   */
  app.delete('/rider-requests/:id', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);

    const request = await repo.getRiderRequest(id);
    if (!request) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
    }
    if (!isAdminRole(user) && request.riderId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to cancel this rider request' } }, 403);
    }

    await repo.updateRiderRequestStatus(id, 'cancelled');
    return c.json({ message: 'Rider request cancelled' });
  });

  // =========================================================================
  // Matching Engine Routes
  // =========================================================================

  /**
   * POST /find - Find matches for a rider request
   *
   * Accepts either a `riderRequestId` (looks up from DB) or inline rider data.
   * Runs the full 3-phase matching engine against SQL-filtered candidates.
   */
  app.post('/find', async (c) => {
    const body = await c.req.json();
    const parsed = findMatchesSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const data = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);

    // Resolve rider request
    let riderRequest: RiderRequest;

    if (data.riderRequestId) {
      const existing = await repo.getRiderRequest(data.riderRequestId);
      if (!existing) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
      }
      if (!isAdminRole(user) && existing.riderId !== String(user.id)) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to match this rider request' } }, 403);
      }
      riderRequest = existing;
    } else if (data.pickup && data.dropoff && data.earliestDeparture && data.latestDeparture) {
      // Create an ephemeral rider request (not saved)
      riderRequest = {
        id: uuid(),
        riderId: String(user?.id || '0'),
        pickup: data.pickup,
        dropoff: data.dropoff,
        earliestDeparture: data.earliestDeparture,
        latestDeparture: data.latestDeparture,
        seatsNeeded: data.seatsNeeded ?? 1,
        status: 'pending',
        preferences: data.preferences,
        organizationId: user?.organizationId,
        createdAt: new Date().toISOString(),
      };
    } else {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide riderRequestId or inline pickup/dropoff/times' } },
        400,
      );
    }

    // Load matching config (org-level overrides or defaults)
    let config = DEFAULT_MATCH_CONFIG;
    if (user?.organizationId) {
      const orgConfig = await repo.getMatchConfig(user.organizationId);
      if (orgConfig) config = orgConfig;
    }
    if (data.maxResults) {
      config = { ...config, maxResults: data.maxResults };
    }

    // SQL pre-filter: get candidate drivers
    const t0 = Date.now();
    const candidates = await repo.findCandidateDrivers(riderRequest, config);

    // Run matching engine
    const { matches, stats } = matchRiderToDrivers(riderRequest, candidates, config);

    // Persist match results
    for (const match of matches) {
      await repo.saveMatchResult(uuid(), match);
    }

    const response: FindMatchesResponse = {
      matches,
      pool: null,
      meta: {
        candidatesEvaluated: stats.candidatesTotal,
        matchesFound: stats.matchesReturned,
        executionTimeMs: Date.now() - t0,
        configUsed: config,
      },
    };

    return c.json(response);
  });

  /**
   * POST /find-pool - Find matches with multi-rider pool optimization
   */
  app.post('/find-pool', async (c) => {
    const body = await c.req.json();
    const parsed = findMatchesSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const data = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);

    // Resolve rider request
    let riderRequest: RiderRequest;
    if (data.riderRequestId) {
      const existing = await repo.getRiderRequest(data.riderRequestId);
      if (!existing) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
      }
      if (!isAdminRole(user) && existing.riderId !== String(user.id)) {
        return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to match this rider request' } }, 403);
      }
      riderRequest = existing;
    } else if (data.pickup && data.dropoff && data.earliestDeparture && data.latestDeparture) {
      riderRequest = {
        id: uuid(),
        riderId: String(user?.id || '0'),
        pickup: data.pickup,
        dropoff: data.dropoff,
        earliestDeparture: data.earliestDeparture,
        latestDeparture: data.latestDeparture,
        seatsNeeded: data.seatsNeeded ?? 1,
        status: 'pending',
        preferences: data.preferences,
        organizationId: user?.organizationId,
        createdAt: new Date().toISOString(),
      };
    } else {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Provide riderRequestId or inline data' } },
        400,
      );
    }

    let config = DEFAULT_MATCH_CONFIG;
    if (user?.organizationId) {
      const orgConfig = await repo.getMatchConfig(user.organizationId);
      if (orgConfig) config = orgConfig;
    }
    config = { ...config, enableMultiRider: true };

    const t0 = Date.now();
    const candidates = await repo.findCandidateDrivers(riderRequest, config);
    const { matches, stats } = matchRiderToDrivers(riderRequest, candidates, config);

    // Run pool optimization on the best match's driver
    let pool = null;
    if (matches.length > 0) {
      const bestDriverId = matches[0].driverTripId;
      const bestDriver = candidates.find((d) => d.id === bestDriverId);

      if (bestDriver) {
        const riderMap = new Map<string, { pickup: GeoPoint; dropoff: GeoPoint }>();
        riderMap.set(riderRequest.riderId, {
          pickup: riderRequest.pickup,
          dropoff: riderRequest.dropoff,
        });

        pool = optimizePool(
          bestDriver,
          matches.filter((m) => m.driverTripId === bestDriverId),
          riderMap,
          config,
        );

        if (pool) {
          const matchIds = pool.riders.map(() => uuid());
          await repo.savePoolAssignment(uuid(), pool, matchIds);
        }
      }
    }

    // Persist matches
    for (const match of matches) {
      await repo.saveMatchResult(uuid(), match);
    }

    return c.json({
      matches,
      pool,
      meta: {
        candidatesEvaluated: stats.candidatesTotal,
        matchesFound: stats.matchesReturned,
        executionTimeMs: Date.now() - t0,
        configUsed: config,
      },
    } as FindMatchesResponse);
  });

  /**
   * GET /results/:riderRequestId - Get match results for a rider request
   */
  app.get('/results/:riderRequestId', async (c) => {
    const riderRequestId = c.req.param('riderRequestId');
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const request = await repo.getRiderRequest(riderRequestId);
    if (!request) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
    }
    if (!isAdminRole(user) && request.riderId !== String(user.id)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to view match results for this rider request' } }, 403);
    }

    const matches = await repo.getMatchesForRider(riderRequestId);
    return c.json({ matches, count: matches.length });
  });

  /**
   * POST /confirm - Confirm a match (rider or driver accepts)
   */
  app.post('/confirm', async (c) => {
    const body = await c.req.json();
    const parsed = confirmMatchSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const { matchId, driverTripId, riderRequestId } = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const match = await repo.getMatchResult(matchId);
    if (!match) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Match not found' } }, 404);
    }
    if (match.status !== 'pending') {
      return c.json({ error: { code: 'CONFLICT', message: 'Match is no longer pending' } }, 409);
    }
    if (match.driverTripId !== driverTripId || match.riderRequestId !== riderRequestId) {
      return c.json({ error: { code: 'CONFLICT', message: 'Match context does not match request payload' } }, 409);
    }
    const ownsMatch = match.riderId === String(user.id) || match.driverId === String(user.id);
    if (!isAdminRole(user) && !ownsMatch) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to confirm this match' } }, 403);
    }

    const riderRequest = await repo.getRiderRequest(match.riderRequestId);
    if (!riderRequest) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Rider request not found' } }, 404);
    }
    const driverTrip = await repo.getDriverTrip(match.driverTripId);
    if (!driverTrip) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Driver trip not found' } }, 404);
    }

    // Confirm the match
    await repo.confirmMatch(matchId);

    // Update rider request status
    await repo.updateRiderRequestStatus(match.riderRequestId, 'confirmed', match.driverTripId);

    // Decrement driver's available seats
    if (driverTrip.availableSeats > 0) {
      await repo.updateDriverTripSeats(match.driverTripId, driverTrip.availableSeats - 1);
    }

    return c.json({ message: 'Match confirmed successfully', matchId });
  });

  /**
   * POST /reject - Reject a match
   */
  app.post('/reject', async (c) => {
    const body = await c.req.json();
    const parsed = rejectMatchSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') } },
        400,
      );
    }

    const { matchId, reason } = parsed.data;
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);
    const match = await repo.getMatchResult(matchId);
    if (!match) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Match not found' } }, 404);
    }
    if (match.status !== 'pending') {
      return c.json({ error: { code: 'CONFLICT', message: 'Match is no longer pending' } }, 409);
    }
    const ownsMatch = match.riderId === String(user.id) || match.driverId === String(user.id);
    if (!isAdminRole(user) && !ownsMatch) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Not allowed to reject this match' } }, 403);
    }

    await repo.rejectMatch(matchId, reason);
    return c.json({ message: 'Match rejected', matchId });
  });

  /**
   * POST /batch - Batch-match all pending rider requests
   * (Admin or cron endpoint)
   */
  app.post('/batch', async (c) => {
    const user = c.get('user') as AuthUser;
    if (!isAdminRole(user)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Admin access required for batch matching' } }, 403);
    }
    const repo = getRepo(c);
    const t0 = Date.now();

    // Get all pending rider requests
    const pendingRiders = await repo.getPendingRiderRequests(100);
    if (pendingRiders.length === 0) {
      return c.json({ message: 'No pending rider requests', matched: 0 });
    }

    let totalMatched = 0;
    const results: Array<{ riderId: string; matchCount: number }> = [];

    for (const rider of pendingRiders) {
      const config = DEFAULT_MATCH_CONFIG;
      const candidates = await repo.findCandidateDrivers(rider, config);
      const { matches } = matchRiderToDrivers(rider, candidates, config);

      for (const match of matches) {
        await repo.saveMatchResult(uuid(), match);
      }

      if (matches.length > 0) {
        await repo.updateRiderRequestStatus(rider.id, 'matched');
        totalMatched++;
      }

      results.push({ riderId: rider.riderId, matchCount: matches.length });
    }

    return c.json({
      message: 'Batch matching completed',
      totalRiders: pendingRiders.length,
      totalMatched,
      executionTimeMs: Date.now() - t0,
      results,
    });
  });

  // =========================================================================
  // Config Routes
  // =========================================================================

  /**
   * GET /config - Get matching config for the user's organization
   */
  app.get('/config', async (c) => {
    const user = c.get('user') as AuthUser;
    const repo = getRepo(c);

    let config = DEFAULT_MATCH_CONFIG;
    if (user?.organizationId) {
      const orgConfig = await repo.getMatchConfig(user.organizationId);
      if (orgConfig) config = orgConfig;
    }

    return c.json({ config });
  });

  /**
   * PUT /config - Update matching config (admin)
   */
  app.put('/config', async (c) => {
    const user = c.get('user') as AuthUser;
    if (!isAdminRole(user)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Admin access required to update matching config' } }, 403);
    }

    if (!user?.organizationId) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Organization ID required' } },
        400,
      );
    }

    const body = await c.req.json();
    const repo = getRepo(c);

    await repo.saveMatchConfig(user.organizationId, body);
    return c.json({ message: 'Matching config updated' });
  });

  // =========================================================================
  // Stats Route
  // =========================================================================

  /**
   * GET /stats - Matching statistics
   */
  app.get('/stats', async (c) => {
    const user = c.get('user') as AuthUser;
    if (!isAdminRole(user)) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Admin access required for matching stats' } }, 403);
    }
    // These would be real aggregation queries in production
    const stats = {
      totalDriverTrips: 0,
      activeDriverTrips: 0,
      totalRiderRequests: 0,
      pendingRiderRequests: 0,
      totalMatches: 0,
      confirmedMatches: 0,
      averageScore: 0,
      averageDetourMinutes: 0,
      totalCarbonSavedKg: 0,
      timestamp: new Date().toISOString(),
    };

    try {
      const driverCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM driver_trips")
        .first<{ count: number }>();
      stats.totalDriverTrips = driverCount?.count ?? 0;

      const activeDriverCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM driver_trips WHERE status IN ('offered', 'active')")
        .first<{ count: number }>();
      stats.activeDriverTrips = activeDriverCount?.count ?? 0;

      const riderCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM rider_requests")
        .first<{ count: number }>();
      stats.totalRiderRequests = riderCount?.count ?? 0;

      const pendingCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM rider_requests WHERE status = 'pending'")
        .first<{ count: number }>();
      stats.pendingRiderRequests = pendingCount?.count ?? 0;

      const matchCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM match_results")
        .first<{ count: number }>();
      stats.totalMatches = matchCount?.count ?? 0;

      const confirmedCount = await c.env.DB
        .prepare("SELECT COUNT(*) as count FROM match_results WHERE status = 'confirmed'")
        .first<{ count: number }>();
      stats.confirmedMatches = confirmedCount?.count ?? 0;

      const avgScore = await c.env.DB
        .prepare("SELECT AVG(score) as avg_score FROM match_results")
        .first<{ avg_score: number | null }>();
      stats.averageScore = avgScore?.avg_score ?? 0;

      const carbonSum = await c.env.DB
        .prepare("SELECT SUM(carbon_saved_kg) as total FROM match_results WHERE status = 'confirmed'")
        .first<{ total: number | null }>();
      stats.totalCarbonSavedKg = carbonSum?.total ?? 0;
    } catch {
      // Tables may not exist yet; return zeros
    }

    return c.json({ stats });
  });

  return app;
}

export default createMatchingRoutes;
