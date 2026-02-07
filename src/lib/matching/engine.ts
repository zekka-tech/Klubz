/**
 * Klubz Smart Trip Pooling - Core Matching Engine
 *
 * Production-grade, deterministic matching algorithm that runs efficiently
 * on Cloudflare Workers (< 50 ms for typical workloads).
 *
 * Architecture:
 *   Phase 1 - Hard Filters   (cheap boolean checks)
 *   Phase 2 - Route Compat   (geometric proximity + order validation)
 *   Phase 3 - Scoring        (weighted multi-factor composite score)
 *
 * Design goals:
 *   - Deterministic & explainable (every score can be broken down)
 *   - Allocation-light (no external dependencies, edge-safe)
 *   - Tunable via MatchConfig weights and thresholds
 *   - Extensible (preferences, rating bias, gender filter, etc.)
 */

import type {
  DriverTrip,
  RiderRequest,
  MatchResult,
  MatchConfig,
  ScoreBreakdown,
  BoundingBox,
  GeoPoint,
} from './types';
import { DEFAULT_MATCH_CONFIG } from './types';
import {
  haversine,
  minDistanceToRoute,
  isInsideBoundingBox,
  padBoundingBox,
  buildBoundingBox,
  isPickupBeforeDropoff,
  estimateDetourKm,
  estimateDetourMinutes,
  estimateCarbonSavedKg,
} from './geo';

// ---------------------------------------------------------------------------
// Explanation builder
// ---------------------------------------------------------------------------

function buildExplanation(b: ScoreBreakdown, score: number): string {
  const parts: string[] = [];

  if (b.pickupDistanceKm < 0.5) {
    parts.push('pickup is very close to route');
  } else if (b.pickupDistanceKm < 1.0) {
    parts.push(`pickup is ${b.pickupDistanceKm.toFixed(1)} km from route`);
  } else {
    parts.push(`pickup is ${b.pickupDistanceKm.toFixed(1)} km from route (moderate)`);
  }

  if (b.dropoffDistanceKm < 0.5) {
    parts.push('dropoff is very close');
  } else {
    parts.push(`dropoff is ${b.dropoffDistanceKm.toFixed(1)} km from route`);
  }

  if (b.timeDiffMinutes <= 5) {
    parts.push('departure times align well');
  } else {
    parts.push(`${Math.round(b.timeDiffMinutes)} min departure difference`);
  }

  if (b.detourDistanceKm !== undefined && b.detourDistanceKm > 0) {
    parts.push(`~${b.detourDistanceKm.toFixed(1)} km detour`);
  }

  return parts.join('; ') + ` (score: ${score.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Phase 1 - Hard Filters
// ---------------------------------------------------------------------------

interface Phase1Result {
  passed: boolean;
  reason?: string;
}

function applyHardFilters(
  rider: RiderRequest,
  driver: DriverTrip,
  config: MatchConfig,
): Phase1Result {
  // 1. Seats
  if (driver.availableSeats <= 0) {
    return { passed: false, reason: 'no_seats' };
  }
  if (driver.availableSeats < rider.seatsNeeded) {
    return { passed: false, reason: 'insufficient_seats' };
  }

  // 2. Status
  if (driver.status !== 'offered' && driver.status !== 'active') {
    return { passed: false, reason: 'trip_not_available' };
  }

  // 3. Time window
  if (
    driver.departureTime < rider.earliestDeparture ||
    driver.departureTime > rider.latestDeparture
  ) {
    return { passed: false, reason: 'outside_time_window' };
  }

  // 4. Organization alignment (if both specify one)
  if (
    rider.organizationId &&
    driver.organizationId &&
    rider.organizationId !== driver.organizationId
  ) {
    return { passed: false, reason: 'organization_mismatch' };
  }

  // 5. Driver rating preference
  if (
    rider.preferences?.minDriverRating &&
    driver.driverRating !== undefined &&
    driver.driverRating < rider.preferences.minDriverRating
  ) {
    return { passed: false, reason: 'driver_rating_too_low' };
  }

  // 6. Bounding-box quick-reject (if driver has a pre-computed bbox)
  if (driver.boundingBox) {
    const padded = padBoundingBox(
      driver.boundingBox,
      config.thresholds.boundingBoxPaddingDeg,
    );
    const pickupInside = isInsideBoundingBox(rider.pickup, padded);
    const dropoffInside = isInsideBoundingBox(rider.dropoff, padded);
    if (!pickupInside && !dropoffInside) {
      return { passed: false, reason: 'outside_bounding_box' };
    }
  }

  return { passed: true };
}

// ---------------------------------------------------------------------------
// Phase 2 - Route Compatibility
// ---------------------------------------------------------------------------

interface Phase2Result {
  passed: boolean;
  reason?: string;
  pickupDistanceKm: number;
  dropoffDistanceKm: number;
  pickupSegmentIndex: number;
  dropoffSegmentIndex: number;
}

function checkRouteCompatibility(
  rider: RiderRequest,
  driver: DriverTrip,
  config: MatchConfig,
): Phase2Result {
  const result: Phase2Result = {
    passed: false,
    pickupDistanceKm: Infinity,
    dropoffDistanceKm: Infinity,
    pickupSegmentIndex: -1,
    dropoffSegmentIndex: -1,
  };

  // If driver has no polyline, fall back to endpoint distance checks
  if (!driver.routePolyline || driver.routePolyline.length < 2) {
    result.pickupDistanceKm = Math.min(
      haversine(rider.pickup, driver.departure),
      haversine(rider.pickup, driver.destination),
    );
    result.dropoffDistanceKm = Math.min(
      haversine(rider.dropoff, driver.departure),
      haversine(rider.dropoff, driver.destination),
    );
    result.pickupSegmentIndex = 0;
    result.dropoffSegmentIndex = 0;
  } else {
    const pickupResult = minDistanceToRoute(rider.pickup, driver.routePolyline);
    const dropoffResult = minDistanceToRoute(rider.dropoff, driver.routePolyline);

    result.pickupDistanceKm = pickupResult.distance;
    result.dropoffDistanceKm = dropoffResult.distance;
    result.pickupSegmentIndex = pickupResult.segmentIndex;
    result.dropoffSegmentIndex = dropoffResult.segmentIndex;
  }

  // Apply rider-specific max walk distance if set
  const maxPickup = rider.preferences?.maxWalkDistanceKm ??
    config.thresholds.maxPickupDistanceKm;
  const maxDropoff = rider.preferences?.maxWalkDistanceKm ??
    config.thresholds.maxDropoffDistanceKm;

  if (result.pickupDistanceKm > maxPickup) {
    result.reason = 'pickup_too_far';
    return result;
  }
  if (result.dropoffDistanceKm > maxDropoff) {
    result.reason = 'dropoff_too_far';
    return result;
  }

  // Route direction check: pickup should occur before dropoff
  if (
    driver.routePolyline &&
    driver.routePolyline.length >= 2 &&
    result.pickupSegmentIndex > result.dropoffSegmentIndex
  ) {
    result.reason = 'wrong_direction';
    return result;
  }

  result.passed = true;
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3 - Scoring
// ---------------------------------------------------------------------------

function computeScore(
  rider: RiderRequest,
  driver: DriverTrip,
  phase2: Phase2Result,
  config: MatchConfig,
): { score: number; breakdown: ScoreBreakdown } {
  const w = config.weights;
  const t = config.thresholds;

  // --- Pickup distance score (0-1, lower better) ---
  const pickupScore = Math.min(phase2.pickupDistanceKm / t.maxPickupDistanceKm, 1);

  // --- Dropoff distance score ---
  const dropoffScore = Math.min(phase2.dropoffDistanceKm / t.maxDropoffDistanceKm, 1);

  // --- Time alignment score ---
  const timeDiffMs = Math.abs(driver.departureTime - rider.earliestDeparture);
  const timeDiffMin = timeDiffMs / 60_000;
  const timeScore = Math.min(timeDiffMin / t.maxTimeDiffMinutes, 1);

  // --- Seat availability score (prefer cars that are filling up) ---
  // A car with 1 seat left scores better than one with 4, encouraging pooling
  const seatScore = driver.availableSeats <= rider.seatsNeeded
    ? 0 // perfect fit
    : Math.min((driver.availableSeats - rider.seatsNeeded) / driver.totalSeats, 1);

  // --- Shift alignment score ---
  let shiftScore = 0;
  if (driver.shiftLocation && rider.dropoff) {
    const shiftDist = haversine(rider.dropoff, driver.shiftLocation);
    shiftScore = Math.min(shiftDist / 5, 1); // normalise over 5 km
  }

  // --- Detour cost score ---
  let detourKm = 0;
  let detourScore = 0;
  if (driver.routePolyline && driver.routePolyline.length >= 2) {
    detourKm = estimateDetourKm(
      rider.pickup,
      rider.dropoff,
      driver.routePolyline,
    );
    const routeLen = driver.routeDistanceKm ?? 20; // fallback 20 km
    detourScore = Math.min(detourKm / (routeLen * t.maxDetourFraction), 1);
  }

  // --- Driver rating score (lower = better driver = lower score) ---
  let ratingScore = 0;
  if (driver.driverRating !== undefined) {
    // Invert: 5-star driver → 0 score, 1-star → 0.8
    ratingScore = Math.max(0, (5 - driver.driverRating) / 5);
  }

  // --- Composite weighted score ---
  const score =
    pickupScore * w.pickupDistance +
    dropoffScore * w.dropoffDistance +
    timeScore * w.timeMatch +
    seatScore * w.seatAvailability +
    shiftScore * w.shiftAlignment +
    detourScore * w.detourCost +
    ratingScore * w.driverRating;

  const breakdown: ScoreBreakdown = {
    pickupDistanceKm: phase2.pickupDistanceKm,
    pickupScore,
    dropoffDistanceKm: phase2.dropoffDistanceKm,
    dropoffScore,
    timeDiffMinutes: timeDiffMin,
    timeScore,
    seatScore,
    shiftScore,
    detourDistanceKm: detourKm,
    detourScore,
    ratingScore,
  };

  return { score, breakdown };
}

// ---------------------------------------------------------------------------
// Public API - Match a single rider to candidate drivers
// ---------------------------------------------------------------------------

export interface MatchingStats {
  candidatesTotal: number;
  passedPhase1: number;
  passedPhase2: number;
  matchesReturned: number;
  executionTimeMs: number;
}

/**
 * Match a single rider request against a list of candidate driver trips.
 *
 * Returns matches sorted by score (lower = better), limited to
 * `config.maxResults`.
 *
 * Designed to be called inside a Hono handler or Cloudflare Worker fetch.
 */
export function matchRiderToDrivers(
  rider: RiderRequest,
  drivers: DriverTrip[],
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): { matches: MatchResult[]; stats: MatchingStats } {
  const t0 = Date.now();
  const stats: MatchingStats = {
    candidatesTotal: drivers.length,
    passedPhase1: 0,
    passedPhase2: 0,
    matchesReturned: 0,
    executionTimeMs: 0,
  };

  const results: MatchResult[] = [];

  for (const driver of drivers) {
    // --- Phase 1: Hard Filters ---
    const p1 = applyHardFilters(rider, driver, config);
    if (!p1.passed) continue;
    stats.passedPhase1++;

    // --- Phase 2: Route Compatibility ---
    const p2 = checkRouteCompatibility(rider, driver, config);
    if (!p2.passed) continue;
    stats.passedPhase2++;

    // --- Phase 3: Scoring ---
    const { score, breakdown } = computeScore(rider, driver, p2, config);

    // Detour budget check (if configured)
    const detourMin = estimateDetourMinutes(breakdown.detourDistanceKm ?? 0);
    const maxDetour = rider.preferences?.maxDetourMinutes ?? config.maxPoolDetourMinutes;
    if (detourMin > maxDetour) continue;

    // Carbon savings estimate
    const riderDist = haversine(rider.pickup, rider.dropoff);
    const carbonSaved = estimateCarbonSavedKg(riderDist, breakdown.detourDistanceKm ?? 0);

    const match: MatchResult = {
      driverTripId: driver.id,
      driverId: driver.driverId,
      riderRequestId: rider.id,
      riderId: rider.riderId,
      score,
      explanation: buildExplanation(breakdown, score),
      breakdown,
      estimatedPickupTime: driver.departureTime + Math.round(breakdown.timeDiffMinutes * 60_000 * 0.5),
      estimatedDetourMinutes: Math.round(detourMin * 10) / 10,
      carbonSavedKg: Math.round(carbonSaved * 100) / 100,
    };

    results.push(match);
  }

  // Sort by score (lower = better)
  results.sort((a, b) => a.score - b.score);

  // Limit results
  const limited = results.slice(0, config.maxResults);

  stats.matchesReturned = limited.length;
  stats.executionTimeMs = Date.now() - t0;

  return { matches: limited, stats };
}

/**
 * Batch-match multiple rider requests against the same driver pool.
 * Useful for cron-based or event-driven bulk matching.
 */
export function batchMatchRiders(
  riders: RiderRequest[],
  drivers: DriverTrip[],
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): Map<string, { matches: MatchResult[]; stats: MatchingStats }> {
  const resultMap = new Map<string, { matches: MatchResult[]; stats: MatchingStats }>();

  for (const rider of riders) {
    resultMap.set(rider.id, matchRiderToDrivers(rider, drivers, config));
  }

  return resultMap;
}
