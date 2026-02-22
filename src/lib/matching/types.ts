/**
 * Klubz Smart Trip Pooling - Type Definitions
 *
 * Production-grade type system for the ride-matching engine.
 * Covers driver trips, rider requests, match results, scoring,
 * multi-rider optimization, and all supporting data structures.
 */

// ---------------------------------------------------------------------------
// Core Geo Types
// ---------------------------------------------------------------------------

/** A single WGS-84 coordinate pair. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Axis-aligned bounding box for cheap spatial pre-filtering. */
export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** A GeoPoint enriched with an optional human-readable address. */
export interface GeoLocation extends GeoPoint {
  address?: string;
}

// ---------------------------------------------------------------------------
// Driver Trip
// ---------------------------------------------------------------------------

/** Status lifecycle of a driver trip offer. */
export type DriverTripStatus =
  | 'offered'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'expired';

/**
 * Represents a single trip offer published by a driver.
 *
 * `routePolyline` is an ordered sequence of waypoints that describes the
 * driver's planned route.  When the polyline is not yet available (e.g. the
 * driver only provided origin / destination) the matching engine falls back
 * to straight-line distance checks.
 */
export interface DriverTrip {
  id: string;
  driverId: string;

  /** Where the driver starts. */
  departure: GeoPoint;
  /** Where the driver ends. */
  destination: GeoPoint;
  /** Office / workplace / shift destination (used for shift-alignment). */
  shiftLocation?: GeoPoint;

  /** Unix timestamp (ms) – planned departure. */
  departureTime: number;
  /** Unix timestamp (ms) – estimated arrival. */
  arrivalTime?: number;

  availableSeats: number;
  totalSeats: number;

  /** Decoded route polyline (Google / Mapbox etc.). */
  routePolyline: GeoPoint[];

  /** Pre-computed bounding box that encloses the polyline. */
  boundingBox?: BoundingBox;

  /** Total route distance in km. */
  routeDistanceKm?: number;

  status: DriverTripStatus;

  /** Driver rating (1-5 scale). */
  driverRating?: number;

  /** Vehicle info for display purposes. */
  vehicle?: VehicleInfo;

  /** Organisational unit the driver belongs to. */
  organizationId?: string;

  createdAt: string;
  updatedAt?: string;
}

export interface VehicleInfo {
  make: string;
  model: string;
  year?: number;
  color?: string;
  licensePlate: string;
  capacity: number;
}

// ---------------------------------------------------------------------------
// Rider Request
// ---------------------------------------------------------------------------

export type RiderRequestStatus =
  | 'pending'
  | 'matched'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'expired';

/**
 * A rider's request to be picked up and dropped off.
 *
 * The rider specifies a flexible departure window
 * (`earliestDeparture` .. `latestDeparture`) so the engine can find drivers
 * whose departure time falls inside that window.
 */
export interface RiderRequest {
  id: string;
  riderId: string;

  pickup: GeoPoint;
  dropoff: GeoPoint;

  /** Unix ts (ms) – earliest acceptable departure. */
  earliestDeparture: number;
  /** Unix ts (ms) – latest acceptable departure. */
  latestDeparture: number;

  /** Number of seats the rider needs (default 1). */
  seatsNeeded: number;

  status: RiderRequestStatus;

  /** Rider preferences – all optional. */
  preferences?: RiderPreferences;

  organizationId?: string;

  createdAt: string;
  updatedAt?: string;
}

export interface RiderPreferences {
  /** Maximum acceptable walking distance to pickup in km. */
  maxWalkDistanceKm?: number;
  /** Maximum acceptable detour added to the trip in minutes. */
  maxDetourMinutes?: number;
  /** Gender preference for the driver (inclusive, optional). */
  genderPreference?: 'any' | 'male' | 'female';
  /** Minimum acceptable driver rating (1-5). */
  minDriverRating?: number;
}

// ---------------------------------------------------------------------------
// Match Results
// ---------------------------------------------------------------------------

/** Detailed breakdown of how a match score was computed. */
export interface ScoreBreakdown {
  /** Distance from rider pickup to nearest point on driver route (km). */
  pickupDistanceKm: number;
  /** Normalised pickup score (0-1, lower is better). */
  pickupScore: number;

  /** Distance from rider dropoff to nearest point on driver route (km). */
  dropoffDistanceKm: number;
  /** Normalised dropoff score (0-1, lower is better). */
  dropoffScore: number;

  /** Absolute time difference in minutes. */
  timeDiffMinutes: number;
  /** Normalised time score (0-1, lower is better). */
  timeScore: number;

  /** Normalised seat-availability score (0-1, lower is better). */
  seatScore: number;

  /** Normalised shift-alignment score (0-1, lower is better). */
  shiftScore: number;

  /** Estimated additional detour distance in km (if computed). */
  detourDistanceKm?: number;
  /** Normalised detour score (0-1, lower is better). */
  detourScore?: number;

  /** Driver rating component (0-1, lower is better). */
  ratingScore?: number;
}

/**
 * A single driver <-> rider match produced by the engine.
 *
 * `score` is a composite value where **lower = better**.
 */
export interface MatchResult {
  driverTripId: string;
  driverId: string;
  riderRequestId: string;
  riderId: string;

  /** Composite score – lower is better. */
  score: number;

  /** Human-readable explanation string. */
  explanation: string;

  /** Granular breakdown of scoring components. */
  breakdown: ScoreBreakdown;

  /** Estimated pickup time (unix ms). */
  estimatedPickupTime?: number;

  /** Estimated additional detour for the driver (minutes). */
  estimatedDetourMinutes?: number;

  /** Carbon savings estimate in kg CO2. */
  carbonSavedKg?: number;
}

// ---------------------------------------------------------------------------
// Multi-Rider Optimization
// ---------------------------------------------------------------------------

/**
 * Describes the optimal combination of riders assigned to a single driver.
 *
 * The optimizer tries to fill seats with the best-scoring set of riders
 * while respecting seat constraints and maximum detour budgets.
 */
export interface PoolAssignment {
  driverTripId: string;
  driverId: string;

  /** Ordered list of rider matches included in this pool. */
  riders: MatchResult[];

  /** Sum of individual rider scores. */
  totalScore: number;
  /** Average rider score. */
  averageScore: number;

  /** Total seats used. */
  seatsUsed: number;
  /** Seats remaining after assignment. */
  seatsRemaining: number;

  /** Estimated total detour for all pickups/dropoffs (minutes). */
  totalDetourMinutes: number;

  /** Total carbon saved across all riders (kg CO2). */
  totalCarbonSavedKg: number;

  /** Suggested ordered stop list for the driver. */
  orderedStops: PoolStop[];
}

export interface PoolStop {
  type: 'pickup' | 'dropoff';
  riderId: string;
  location: GeoPoint;
  /** Estimated time of arrival at this stop (unix ms). */
  eta?: number;
  /** Distance from previous stop (km). */
  distanceFromPrevKm?: number;
}

// ---------------------------------------------------------------------------
// Matching Configuration
// ---------------------------------------------------------------------------

/** Tunable weights used by the scoring function. */
export interface MatchWeights {
  pickupDistance: number;
  dropoffDistance: number;
  timeMatch: number;
  seatAvailability: number;
  shiftAlignment: number;
  detourCost: number;
  driverRating: number;
}

/** Hard-limit thresholds that reject candidates before scoring. */
export interface MatchThresholds {
  /** Max pickup-to-route distance (km). */
  maxPickupDistanceKm: number;
  /** Max dropoff-to-route distance (km). */
  maxDropoffDistanceKm: number;
  /** Max time difference (minutes). */
  maxTimeDiffMinutes: number;
  /** Max acceptable detour as a fraction of original route (0-1). Kept for backward compat. */
  maxDetourFraction: number;
  /** Bounding-box padding in degrees for SQL pre-filter. */
  boundingBoxPaddingDeg: number;
  /**
   * Absolute maximum detour a single rider may add to the driver's route (km).
   * Hard filter applied in Phase 2 regardless of route length.
   * Default: 10 km.
   */
  maxAbsoluteDetourKm: number;
}

/** Full matching configuration. */
export interface MatchConfig {
  weights: MatchWeights;
  thresholds: MatchThresholds;
  /** Maximum results to return per request. */
  maxResults: number;
  /** Whether to enable multi-rider optimization. */
  enableMultiRider: boolean;
  /** Max riders to consider in multi-rider optimization. */
  maxRidersPerPool: number;
  /** Max cumulative pool detour (minutes). Kept for display / backward compat. */
  maxPoolDetourMinutes: number;
  /**
   * Absolute maximum cumulative detour for the entire pool (km).
   * The optimizer rejects any rider whose marginal detour would push the
   * running total above this limit. Default: 10 km.
   */
  maxPoolDetourKm: number;
}

/** Default production configuration. */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  weights: {
    pickupDistance:   0.30,  // "closest rider" — unchanged
    dropoffDistance:  0.30,  // unchanged
    timeMatch:        0.15,  // ↓ from 0.18
    seatAvailability: 0.05,  // ↓ from 0.07
    shiftAlignment:   0.02,  // ↓ from 0.05 (minor factor)
    detourCost:       0.13,  // ↑ from 0.05 — route efficiency priority
    driverRating:     0.05,  // unchanged
    // total: 1.00
  },
  thresholds: {
    maxPickupDistanceKm:   2.0,
    maxDropoffDistanceKm:  2.0,
    maxTimeDiffMinutes:    20,
    maxDetourFraction:     0.30,  // kept for backward compat; not used for scoring
    boundingBoxPaddingDeg: 0.03,  // ~3.3 km at equator
    maxAbsoluteDetourKm:   10,    // hard cap: no rider adds > 10 km to driver route
  },
  maxResults: 20,
  enableMultiRider: true,
  maxRidersPerPool: 4,
  maxPoolDetourMinutes: 20,   // kept for display / backward compat
  maxPoolDetourKm: 10,         // cumulative pool budget: sum of marginal detours ≤ 10 km
};

// ---------------------------------------------------------------------------
// API Request / Response Envelopes
// ---------------------------------------------------------------------------

export interface FindMatchesRequest {
  riderRequest: Omit<RiderRequest, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
  config?: Partial<MatchConfig>;
}

export interface FindMatchesResponse {
  matches: MatchResult[];
  pool?: PoolAssignment | null;
  meta: {
    candidatesEvaluated: number;
    matchesFound: number;
    executionTimeMs: number;
    configUsed: MatchConfig;
  };
}

export interface CreateDriverTripRequest {
  departure: GeoLocation;
  destination: GeoLocation;
  shiftLocation?: GeoLocation;
  departureTime: number;
  arrivalTime?: number;
  availableSeats: number;
  totalSeats: number;
  routePolyline?: GeoPoint[];
  vehicle?: VehicleInfo;
}

export interface CreateRiderRequestPayload {
  pickup: GeoLocation;
  dropoff: GeoLocation;
  earliestDeparture: number;
  latestDeparture: number;
  seatsNeeded?: number;
  preferences?: RiderPreferences;
}

export interface ConfirmMatchRequest {
  matchId: string;
  driverTripId: string;
  riderRequestId: string;
}

export interface MatchStatusResponse {
  matchId: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelled';
  driverTrip: DriverTrip;
  riderRequest: RiderRequest;
  score: number;
  explanation: string;
  confirmedAt?: string;
}
