/**
 * Klubz Smart Trip Pooling - D1 Database Repository
 *
 * SQL-assisted matching with bounding-box pre-filtering.
 * This module bridges the in-memory matching engine with the D1 database,
 * handling CRUD operations and the critical SQL pre-filter that narrows
 * down candidate drivers before the JS-level matching runs.
 *
 * Key design choices:
 *   - Bounding box filtering in SQL (cheap, indexed)
 *   - Decoded polylines cached in KV (fast reads)
 *   - All heavy matching logic stays in TypeScript (engine.ts)
 *   - Prepared statements for injection safety
 */

import type {
  DriverTrip,
  RiderRequest,
  MatchResult,
  PoolAssignment,
  MatchConfig,
  GeoPoint,
  BoundingBox,
  VehicleInfo,
  RiderPreferences,
  DriverTripStatus,
  RiderRequestStatus,
} from './types';
import { DEFAULT_MATCH_CONFIG } from './types';
import {
  buildBoundingBox,
  padBoundingBox,
  decodePolyline,
  encodePolyline,
  polylineLength,
  simplifyPolyline,
} from './geo';

// ---------------------------------------------------------------------------
// Type helpers for D1 row shapes
// ---------------------------------------------------------------------------

interface DriverTripRow {
  id: string;
  driver_id: number;
  organization_id: string | null;
  departure_lat: number;
  departure_lng: number;
  destination_lat: number;
  destination_lng: number;
  shift_lat: number | null;
  shift_lng: number | null;
  departure_time: number;
  arrival_time: number | null;
  available_seats: number;
  total_seats: number;
  bbox_min_lat: number | null;
  bbox_max_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lng: number | null;
  route_polyline_encoded: string | null;
  route_distance_km: number | null;
  status: string;
  driver_rating: number | null;
  vehicle_json: string | null;
  created_at: string;
  updated_at: string;
}

interface RiderRequestRow {
  id: string;
  rider_id: number;
  organization_id: string | null;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  earliest_departure: number;
  latest_departure: number;
  seats_needed: number;
  preferences_json: string | null;
  status: string;
  matched_driver_trip_id: string | null;
  matched_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MatchResultAuthRow {
  id: string;
  driver_trip_id: string;
  rider_request_id: string;
  driver_id: number;
  rider_id: number;
  status: string;
}

// ---------------------------------------------------------------------------
// Row ↔ Domain Object Mappers
// ---------------------------------------------------------------------------

function rowToDriverTrip(row: DriverTripRow, polyline?: GeoPoint[]): DriverTrip {
  const route = polyline ??
    (row.route_polyline_encoded
      ? decodePolyline(row.route_polyline_encoded)
      : [
          { lat: row.departure_lat, lng: row.departure_lng },
          { lat: row.destination_lat, lng: row.destination_lng },
        ]);

  const bbox: BoundingBox | undefined =
    row.bbox_min_lat !== null
      ? {
          minLat: row.bbox_min_lat!,
          maxLat: row.bbox_max_lat!,
          minLng: row.bbox_min_lng!,
          maxLng: row.bbox_max_lng!,
        }
      : undefined;

  return {
    id: row.id,
    driverId: String(row.driver_id),
    departure: { lat: row.departure_lat, lng: row.departure_lng },
    destination: { lat: row.destination_lat, lng: row.destination_lng },
    shiftLocation:
      row.shift_lat !== null
        ? { lat: row.shift_lat!, lng: row.shift_lng! }
        : undefined,
    departureTime: row.departure_time,
    arrivalTime: row.arrival_time ?? undefined,
    availableSeats: row.available_seats,
    totalSeats: row.total_seats,
    routePolyline: route,
    boundingBox: bbox,
    routeDistanceKm: row.route_distance_km ?? undefined,
    status: row.status as DriverTripStatus,
    driverRating: row.driver_rating ?? undefined,
    vehicle: row.vehicle_json ? JSON.parse(row.vehicle_json) : undefined,
    organizationId: row.organization_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRiderRequest(row: RiderRequestRow): RiderRequest {
  return {
    id: row.id,
    riderId: String(row.rider_id),
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    earliestDeparture: row.earliest_departure,
    latestDeparture: row.latest_departure,
    seatsNeeded: row.seats_needed,
    status: row.status as RiderRequestStatus,
    preferences: row.preferences_json
      ? JSON.parse(row.preferences_json)
      : undefined,
    organizationId: row.organization_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// D1 interface (subset of Cloudflare D1Database)
// ---------------------------------------------------------------------------

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

function getAffectedRows(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const meta = (result as D1Result).meta;
  if (!meta || typeof meta !== 'object') return null;
  const changes = (meta as Record<string, unknown>).changes;
  return typeof changes === 'number' ? changes : null;
}

// ---------------------------------------------------------------------------
// KV interface (subset of Cloudflare KVNamespace)
// ---------------------------------------------------------------------------

interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository Class
// ---------------------------------------------------------------------------

export class MatchingRepository {
  constructor(
    private db: D1Database,
    private kv?: KVNamespace,
  ) {}

  // =========================================================================
  // Driver Trips
  // =========================================================================

  /**
   * Insert a new driver trip with pre-computed bounding box.
   */
  async createDriverTrip(
    id: string,
    driverId: number,
    trip: {
      departure: GeoPoint;
      destination: GeoPoint;
      shiftLocation?: GeoPoint;
      departureTime: number;
      arrivalTime?: number;
      availableSeats: number;
      totalSeats: number;
      routePolyline?: GeoPoint[];
      routeDistanceKm?: number;
      driverRating?: number;
      vehicle?: VehicleInfo;
      organizationId?: string;
    },
  ): Promise<DriverTrip> {
    // Build polyline and bbox
    const route = trip.routePolyline ?? [trip.departure, trip.destination];
    const bbox = buildBoundingBox(route);
    const encoded = trip.routePolyline ? encodePolyline(trip.routePolyline) : null;
    const distance = trip.routeDistanceKm ?? polylineLength(route);

    await this.db
      .prepare(
        `INSERT INTO driver_trips (
          id, driver_id, organization_id,
          departure_lat, departure_lng, destination_lat, destination_lng,
          shift_lat, shift_lng,
          departure_time, arrival_time,
          available_seats, total_seats,
          bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng,
          route_polyline_encoded, route_distance_km,
          status, driver_rating, vehicle_json,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3,
          ?4, ?5, ?6, ?7,
          ?8, ?9,
          ?10, ?11,
          ?12, ?13,
          ?14, ?15, ?16, ?17,
          ?18, ?19,
          'offered', ?20, ?21,
          datetime('now'), datetime('now')
        )`,
      )
      .bind(
        id,
        driverId,
        trip.organizationId ?? null,
        trip.departure.lat,
        trip.departure.lng,
        trip.destination.lat,
        trip.destination.lng,
        trip.shiftLocation?.lat ?? null,
        trip.shiftLocation?.lng ?? null,
        trip.departureTime,
        trip.arrivalTime ?? null,
        trip.availableSeats,
        trip.totalSeats,
        bbox.minLat,
        bbox.maxLat,
        bbox.minLng,
        bbox.maxLng,
        encoded,
        distance,
        trip.driverRating ?? null,
        trip.vehicle ? JSON.stringify(trip.vehicle) : null,
      )
      .run();

    // Cache polyline in KV
    if (this.kv && encoded) {
      await this.kv.put(
        `polyline:${id}`,
        JSON.stringify(route),
        { expirationTtl: 86400 }, // 24h
      );
    }

    // Also store simplified polyline in D1 for quick fallback
    if (encoded) {
      const simplified = simplifyPolyline(route, 0.1); // 100m tolerance
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO route_polylines
           (id, driver_trip_id, encoded_polyline, point_count, total_distance_km, simplified_polyline, created_at)
           VALUES (?1, ?1, ?2, ?3, ?4, ?5, datetime('now'))`,
        )
        .bind(
          id,
          encoded,
          route.length,
          distance,
          encodePolyline(simplified),
        )
        .run();
    }

    return rowToDriverTrip({
      id,
      driver_id: driverId,
      organization_id: trip.organizationId ?? null,
      departure_lat: trip.departure.lat,
      departure_lng: trip.departure.lng,
      destination_lat: trip.destination.lat,
      destination_lng: trip.destination.lng,
      shift_lat: trip.shiftLocation?.lat ?? null,
      shift_lng: trip.shiftLocation?.lng ?? null,
      departure_time: trip.departureTime,
      arrival_time: trip.arrivalTime ?? null,
      available_seats: trip.availableSeats,
      total_seats: trip.totalSeats,
      bbox_min_lat: bbox.minLat,
      bbox_max_lat: bbox.maxLat,
      bbox_min_lng: bbox.minLng,
      bbox_max_lng: bbox.maxLng,
      route_polyline_encoded: encoded,
      route_distance_km: distance,
      status: 'offered',
      driver_rating: trip.driverRating ?? null,
      vehicle_json: trip.vehicle ? JSON.stringify(trip.vehicle) : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, route);
  }

  /**
   * SQL bounding-box pre-filter for matching candidates.
   *
   * This is the most performance-critical query. It uses indexed columns
   * to quickly narrow down driver trips whose bounding box overlaps
   * with the rider's pickup AND dropoff (with padding).
   */
  async findCandidateDrivers(
    rider: RiderRequest,
    config: MatchConfig = DEFAULT_MATCH_CONFIG,
  ): Promise<DriverTrip[]> {
    const padding = config.thresholds.boundingBoxPaddingDeg;

    // Build a bounding box around rider's pickup + dropoff, then pad
    const riderBbox = padBoundingBox(
      buildBoundingBox([rider.pickup, rider.dropoff]),
      padding,
    );

    const result = await this.db
      .prepare(
        `SELECT * FROM driver_trips
         WHERE status IN ('offered', 'active')
           AND available_seats >= ?1
           AND departure_time >= ?2
           AND departure_time <= ?3
           AND (
             -- Driver bbox overlaps rider bbox (spatial pre-filter)
             bbox_max_lat >= ?4 AND bbox_min_lat <= ?5
             AND bbox_max_lng >= ?6 AND bbox_min_lng <= ?7
           )
         ORDER BY departure_time ASC
         LIMIT 200`,
      )
      .bind(
        rider.seatsNeeded,
        rider.earliestDeparture,
        rider.latestDeparture,
        riderBbox.minLat,
        riderBbox.maxLat,
        riderBbox.minLng,
        riderBbox.maxLng,
      )
      .all<DriverTripRow>();

    if (!result.results) return [];

    // Hydrate polylines from KV (or decode from DB)
    const trips: DriverTrip[] = [];
    for (const row of result.results) {
      let polyline: GeoPoint[] | undefined;

      // Try KV cache first
      if (this.kv) {
        const cached = await this.kv.get(`polyline:${row.id}`);
        if (cached) {
          polyline = JSON.parse(cached);
        }
      }

      trips.push(rowToDriverTrip(row, polyline));
    }

    return trips;
  }

  /**
   * Get a single driver trip by ID.
   */
  async getDriverTrip(id: string): Promise<DriverTrip | null> {
    const row = await this.db
      .prepare('SELECT * FROM driver_trips WHERE id = ?1')
      .bind(id)
      .first<DriverTripRow>();

    return row ? rowToDriverTrip(row) : null;
  }

  /**
   * Update available seats (after a rider joins/leaves).
   */
  async updateDriverTripSeats(id: string, availableSeats: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE driver_trips
         SET available_seats = ?1, updated_at = datetime('now')
         WHERE id = ?2`,
      )
      .bind(availableSeats, id)
      .run();
  }

  /**
   * Update driver trip status.
   */
  async updateDriverTripStatus(id: string, status: DriverTripStatus): Promise<void> {
    await this.db
      .prepare(
        `UPDATE driver_trips
         SET status = ?1, updated_at = datetime('now')
         WHERE id = ?2`,
      )
      .bind(status, id)
      .run();
  }

  /**
   * Atomically reserve one seat on a driver trip.
   * Returns false when the trip has no remaining seats.
   */
  async reserveDriverTripSeat(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE driver_trips
         SET available_seats = available_seats - 1, updated_at = datetime('now')
         WHERE id = ?1 AND available_seats > 0`,
      )
      .bind(id)
      .run();
    return (getAffectedRows(result) ?? 0) > 0;
  }

  /**
   * Compensating seat release when downstream operations fail after reservation.
   */
  async releaseDriverTripSeat(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE driver_trips
         SET available_seats = MIN(available_seats + 1, total_seats), updated_at = datetime('now')
         WHERE id = ?1`,
      )
      .bind(id)
      .run();
  }

  /**
   * List driver trips for a driver.
   */
  async listDriverTrips(
    driverId: number,
    status?: DriverTripStatus,
    limit = 50,
    offset = 0,
  ): Promise<DriverTrip[]> {
    let query = 'SELECT * FROM driver_trips WHERE driver_id = ?1';
    const params: unknown[] = [driverId];

    if (status) {
      query += ' AND status = ?2';
      params.push(status);
    }

    query += ' ORDER BY departure_time DESC LIMIT ?3 OFFSET ?4';
    params.push(limit, offset);

    // Workaround: bind parameters dynamically
    let stmt = this.db.prepare(query.replace(/\?\d+/g, '?'));
    stmt = stmt.bind(...params);

    const result = await stmt.all<DriverTripRow>();
    return (result.results ?? []).map((row) => rowToDriverTrip(row));
  }

  // =========================================================================
  // Rider Requests
  // =========================================================================

  async createRiderRequest(
    id: string,
    riderId: number,
    request: {
      pickup: GeoPoint;
      dropoff: GeoPoint;
      earliestDeparture: number;
      latestDeparture: number;
      seatsNeeded?: number;
      preferences?: RiderPreferences;
      organizationId?: string;
    },
  ): Promise<RiderRequest> {
    await this.db
      .prepare(
        `INSERT INTO rider_requests (
          id, rider_id, organization_id,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          earliest_departure, latest_departure,
          seats_needed, preferences_json, status,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3,
          ?4, ?5, ?6, ?7,
          ?8, ?9,
          ?10, ?11, 'pending',
          datetime('now'), datetime('now')
        )`,
      )
      .bind(
        id,
        riderId,
        request.organizationId ?? null,
        request.pickup.lat,
        request.pickup.lng,
        request.dropoff.lat,
        request.dropoff.lng,
        request.earliestDeparture,
        request.latestDeparture,
        request.seatsNeeded ?? 1,
        request.preferences ? JSON.stringify(request.preferences) : null,
      )
      .run();

    return {
      id,
      riderId: String(riderId),
      pickup: request.pickup,
      dropoff: request.dropoff,
      earliestDeparture: request.earliestDeparture,
      latestDeparture: request.latestDeparture,
      seatsNeeded: request.seatsNeeded ?? 1,
      status: 'pending',
      preferences: request.preferences,
      organizationId: request.organizationId,
      createdAt: new Date().toISOString(),
    };
  }

  async getRiderRequest(id: string): Promise<RiderRequest | null> {
    const row = await this.db
      .prepare('SELECT * FROM rider_requests WHERE id = ?1')
      .bind(id)
      .first<RiderRequestRow>();

    return row ? rowToRiderRequest(row) : null;
  }

  async updateRiderRequestStatus(
    id: string,
    status: RiderRequestStatus,
    matchedDriverTripId?: string,
  ): Promise<void> {
    if (matchedDriverTripId) {
      await this.db
        .prepare(
          `UPDATE rider_requests
           SET status = ?1, matched_driver_trip_id = ?2, matched_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?3`,
        )
        .bind(status, matchedDriverTripId, id)
        .run();
    } else {
      await this.db
        .prepare(
          `UPDATE rider_requests
           SET status = ?1, updated_at = datetime('now')
           WHERE id = ?2`,
        )
        .bind(status, id)
        .run();
    }
  }

  async listRiderRequests(
    riderId: number,
    status?: RiderRequestStatus,
    limit = 50,
    offset = 0,
  ): Promise<RiderRequest[]> {
    let query = 'SELECT * FROM rider_requests WHERE rider_id = ?1';
    const params: unknown[] = [riderId];

    if (status) {
      query += ' AND status = ?2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?3 OFFSET ?4';
    params.push(limit, offset);

    let stmt = this.db.prepare(query.replace(/\?\d+/g, '?'));
    stmt = stmt.bind(...params);

    const result = await stmt.all<RiderRequestRow>();
    return (result.results ?? []).map((row) => rowToRiderRequest(row));
  }

  /**
   * Fetch all pending rider requests (for batch matching).
   */
  async getPendingRiderRequests(limit = 100): Promise<RiderRequest[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM rider_requests
         WHERE status = 'pending'
           AND latest_departure > ?1
         ORDER BY created_at ASC
         LIMIT ?2`,
      )
      .bind(Date.now(), limit)
      .all<RiderRequestRow>();

    return (result.results ?? []).map((row) => rowToRiderRequest(row));
  }

  // =========================================================================
  // Match Results
  // =========================================================================

  async saveMatchResult(
    id: string,
    match: MatchResult,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO match_results (
          id, driver_trip_id, rider_request_id, driver_id, rider_id,
          score, breakdown_json, explanation,
          estimated_pickup_time, estimated_detour_minutes, carbon_saved_kg,
          status, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8,
          ?9, ?10, ?11,
          'pending', datetime('now'), datetime('now')
        )`,
      )
      .bind(
        id,
        match.driverTripId,
        match.riderRequestId,
        parseInt(match.driverId) || 0,
        parseInt(match.riderId) || 0,
        match.score,
        JSON.stringify(match.breakdown),
        match.explanation,
        match.estimatedPickupTime ?? null,
        match.estimatedDetourMinutes ?? null,
        match.carbonSavedKg ?? null,
      )
      .run();
  }

  async confirmMatch(matchId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE match_results
         SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?1`,
      )
      .bind(matchId)
      .run();
  }

  async rejectMatch(matchId: string, reason?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE match_results
         SET status = 'rejected', rejected_at = datetime('now'),
             rejection_reason = ?1, updated_at = datetime('now')
         WHERE id = ?2`,
      )
      .bind(reason ?? null, matchId)
      .run();
  }

  async getMatchResult(
    matchId: string,
  ): Promise<{ id: string; driverTripId: string; riderRequestId: string; driverId: string; riderId: string; status: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, driver_trip_id, rider_request_id, driver_id, rider_id, status
         FROM match_results
         WHERE id = ?1`,
      )
      .bind(matchId)
      .first<MatchResultAuthRow>();

    if (!row) return null;
    return {
      id: row.id,
      driverTripId: row.driver_trip_id,
      riderRequestId: row.rider_request_id,
      driverId: String(row.driver_id),
      riderId: String(row.rider_id),
      status: row.status,
    };
  }

  async getMatchesForRider(riderRequestId: string): Promise<MatchResult[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM match_results
         WHERE rider_request_id = ?1
         ORDER BY score ASC`,
      )
      .bind(riderRequestId)
      .all<Record<string, unknown>>();

    return (result.results ?? []).map((row: Record<string, unknown>) => ({
      driverTripId: row.driver_trip_id as string,
      driverId: String(row.driver_id),
      riderRequestId: row.rider_request_id as string,
      riderId: String(row.rider_id),
      score: row.score as number,
      explanation: (row.explanation as string) ?? '',
      breakdown: JSON.parse((row.breakdown_json as string) ?? '{}'),
      estimatedPickupTime: row.estimated_pickup_time as number | undefined,
      estimatedDetourMinutes: row.estimated_detour_minutes as number | undefined,
      carbonSavedKg: row.carbon_saved_kg as number | undefined,
    }));
  }

  // =========================================================================
  // Pool Assignments
  // =========================================================================

  async savePoolAssignment(
    id: string,
    pool: PoolAssignment,
    matchIds: string[],
  ): Promise<void> {
    // Save pool
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO pool_assignments (
          id, driver_trip_id, driver_id,
          total_score, average_score, seats_used, seats_remaining,
          total_detour_minutes, total_carbon_saved_kg,
          ordered_stops_json, status,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3,
          ?4, ?5, ?6, ?7,
          ?8, ?9,
          ?10, 'pending',
          datetime('now'), datetime('now')
        )`,
      )
      .bind(
        id,
        pool.driverTripId,
        parseInt(pool.driverId) || 0,
        pool.totalScore,
        pool.averageScore,
        pool.seatsUsed,
        pool.seatsRemaining,
        pool.totalDetourMinutes,
        pool.totalCarbonSavedKg,
        JSON.stringify(pool.orderedStops),
      )
      .run();

    // Save pool members
    for (let i = 0; i < pool.riders.length; i++) {
      const rider = pool.riders[i];
      const matchId = matchIds[i];
      if (!matchId) continue;

      const pickupOrder = pool.orderedStops.findIndex(
        (s) => s.type === 'pickup' && s.riderId === rider.riderId,
      );
      const dropoffOrder = pool.orderedStops.findIndex(
        (s) => s.type === 'dropoff' && s.riderId === rider.riderId,
      );

      await this.db
        .prepare(
          `INSERT OR REPLACE INTO pool_members (
            id, pool_assignment_id, match_result_id, rider_id,
            pickup_order, dropoff_order, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`,
        )
        .bind(
          `${id}-${rider.riderId}`,
          id,
          matchId,
          parseInt(rider.riderId) || 0,
          pickupOrder,
          dropoffOrder,
        )
        .run();
    }
  }

  // =========================================================================
  // Matching Config (per-organization overrides)
  // =========================================================================

  async getMatchConfig(organizationId: string): Promise<MatchConfig | null> {
    const row = await this.db
      .prepare(
        'SELECT config_json FROM matching_config WHERE organization_id = ?1',
      )
      .bind(organizationId)
      .first<{ config_json: string }>();

    if (!row) return null;

    try {
      const overrides = JSON.parse(row.config_json);
      return {
        ...DEFAULT_MATCH_CONFIG,
        ...overrides,
        weights: { ...DEFAULT_MATCH_CONFIG.weights, ...overrides.weights },
        thresholds: {
          ...DEFAULT_MATCH_CONFIG.thresholds,
          ...overrides.thresholds,
        },
      };
    } catch {
      return null;
    }
  }

  async saveMatchConfig(
    organizationId: string,
    config: {
      weights?: Partial<MatchConfig['weights']>;
      thresholds?: Partial<MatchConfig['thresholds']>;
      maxResults?: MatchConfig['maxResults'];
      enableMultiRider?: MatchConfig['enableMultiRider'];
      maxRidersPerPool?: MatchConfig['maxRidersPerPool'];
      maxPoolDetourMinutes?: MatchConfig['maxPoolDetourMinutes'];
    },
  ): Promise<void> {
    const id = `mc-${organizationId}`;
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO matching_config (id, organization_id, config_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))`,
      )
      .bind(id, organizationId, JSON.stringify(config))
      .run();
  }
}
