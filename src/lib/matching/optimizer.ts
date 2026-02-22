/**
 * Klubz Smart Trip Pooling - Multi-Rider Pool Optimizer
 *
 * Given a driver trip and a set of candidate rider matches, find the
 * optimal combination of riders that:
 *   1. Fits within the driver's available seats
 *   2. Stays within the maximum detour budget
 *   3. Maximises pooling efficiency (best aggregate score)
 *   4. Produces a sensible stop ordering
 *
 * The optimizer uses a greedy heuristic with look-ahead pruning,
 * suitable for real-time execution on edge workers.
 *
 * For N candidate riders and K available seats, a brute-force approach
 * would be C(N, K). We cap candidates at `maxCandidates` and use a
 * greedy insertion strategy that runs in O(N * K) time.
 */

import type {
  DriverTrip,
  MatchResult,
  PoolAssignment,
  PoolStop,
  MatchConfig,
  GeoPoint,
} from './types';
import { DEFAULT_MATCH_CONFIG } from './types';
import {
  haversine,
  minDistanceToRoute,
  computeMarginalDetourKm,
} from './geo';

// ---------------------------------------------------------------------------
// Stop Ordering
// ---------------------------------------------------------------------------

/**
 * Given a driver route and a set of rider pickup/dropoff points, produce
 * an ordered list of stops that follows the driver's route direction.
 *
 * Strategy: for each stop, find the nearest segment index on the route,
 * then sort by segment index (and within the same segment, by distance
 * along the segment from the start).
 */
function orderStops(
  driver: DriverTrip,
  riders: MatchResult[],
  riderPickups: Map<string, GeoPoint>,
  riderDropoffs: Map<string, GeoPoint>,
): PoolStop[] {
  const route = driver.routePolyline;
  const stops: Array<{
    stop: PoolStop;
    segIdx: number;
    dist: number;
  }> = [];

  for (const rider of riders) {
    const pickup = riderPickups.get(rider.riderId);
    const dropoff = riderDropoffs.get(rider.riderId);

    if (pickup) {
      const { segmentIndex, distance } = route.length >= 2
        ? minDistanceToRoute(pickup, route)
        : { segmentIndex: 0, distance: 0 };
      stops.push({
        stop: { type: 'pickup', riderId: rider.riderId, location: pickup },
        segIdx: segmentIndex,
        dist: distance,
      });
    }

    if (dropoff) {
      const { segmentIndex, distance } = route.length >= 2
        ? minDistanceToRoute(dropoff, route)
        : { segmentIndex: 0, distance: 0 };
      stops.push({
        stop: { type: 'dropoff', riderId: rider.riderId, location: dropoff },
        segIdx: segmentIndex,
        dist: distance,
      });
    }
  }

  // Sort by segment index, then by distance within segment
  stops.sort((a, b) => {
    if (a.segIdx !== b.segIdx) return a.segIdx - b.segIdx;
    return a.dist - b.dist;
  });

  // Ensure all pickups come before their corresponding dropoffs
  const ordered = stops.map((s) => s.stop);
  return enforcePickupBeforeDropoff(ordered);
}

/**
 * Post-process the stop list to guarantee every rider's pickup appears
 * before their dropoff. If it doesn't, swap them.
 */
function enforcePickupBeforeDropoff(stops: PoolStop[]): PoolStop[] {
  const result = [...stops];
  const pickupSeen = new Set<string>();

  for (let i = 0; i < result.length; i++) {
    const stop = result[i];
    if (stop.type === 'pickup') {
      pickupSeen.add(stop.riderId);
    } else if (stop.type === 'dropoff' && !pickupSeen.has(stop.riderId)) {
      // Dropoff appeared before pickup — find the pickup and move it here
      const pickupIdx = result.findIndex(
        (s, j) => j > i && s.type === 'pickup' && s.riderId === stop.riderId,
      );
      if (pickupIdx !== -1) {
        const [pickup] = result.splice(pickupIdx, 1);
        result.splice(i, 0, pickup);
        pickupSeen.add(stop.riderId);
      }
    }
  }

  // Add ETAs based on sequential distances
  let prevLocation: GeoPoint | null = null;
  for (const stop of result) {
    if (prevLocation) {
      stop.distanceFromPrevKm = haversine(prevLocation, stop.location);
    }
    prevLocation = stop.location;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Greedy Pool Optimizer
// ---------------------------------------------------------------------------

/**
 * Optimise a pool of riders for a single driver trip.
 *
 * Algorithm (cheapest-insertion greedy):
 *   1. Sort candidate matches by score (best first — lowest score wins)
 *   2. For each candidate, compute the **marginal km** of inserting their
 *      pickup + dropoff into the current stop sequence (cheapest-insertion).
 *   3. Accept the candidate only if:
 *      a. Seats remain available
 *      b. `cumulativeDetourKm + marginalKm ≤ maxPoolDetourKm`
 *         (absolute budget — never exceed 10 km total regardless of pool size)
 *   4. After each acceptance, rebuild the ordered stop sequence so the next
 *      rider's marginal cost is computed relative to the updated route.
 *   5. Return the resulting PoolAssignment (or null if no rider fits).
 *
 * This replaces the previous approach (sum of individual minute estimates ×
 * 0.7 overlap discount) with a geometrically accurate cumulative km budget
 * that correctly accounts for shared route segments.
 *
 * @param driver       The driver trip to fill
 * @param candidates   Candidate matches (pre-sorted by score, best first)
 * @param riderMap     Map of riderId → { pickup, dropoff } for stop ordering
 * @param config       Matching configuration
 */
export function optimizePool(
  driver: DriverTrip,
  candidates: MatchResult[],
  riderMap: Map<string, { pickup: GeoPoint; dropoff: GeoPoint }>,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): PoolAssignment | null {
  if (candidates.length === 0 || driver.availableSeats <= 0) {
    return null;
  }

  const maxRiders = config.maxRidersPerPool;
  // Use the absolute km budget (primary); fall back to converting minutes if absent
  const maxDetourKm =
    config.maxPoolDetourKm ??
    config.thresholds.maxAbsoluteDetourKm ??
    10;
  const maxSeats = driver.availableSeats;

  const selected: MatchResult[] = [];
  let seatsUsed = 0;
  let cumulativeDetourKm = 0;
  // Ordered stops rebuilt after each acceptance so the next rider's marginal
  // cost is computed against the most accurate current stop sequence.
  let currentStops: PoolStop[] = [];

  for (const candidate of candidates) {
    // Seat check
    if (seatsUsed + 1 > maxSeats) continue;

    // Max riders check
    if (selected.length >= maxRiders) break;

    // Skip if location data missing (shouldn't happen in normal flow)
    const riderData = riderMap.get(candidate.riderId);
    if (!riderData) continue;

    // Compute the additional km required to serve this rider given the
    // current pool's ordered stop sequence (cheapest-insertion heuristic).
    const marginalKm = computeMarginalDetourKm(
      driver.departure,
      driver.destination,
      riderData.pickup,
      riderData.dropoff,
      currentStops,
    );

    // Absolute detour budget check
    if (cumulativeDetourKm + marginalKm > maxDetourKm) continue;

    // Accept this rider
    selected.push(candidate);
    seatsUsed += 1;
    cumulativeDetourKm += marginalKm;

    // Rebuild ordered stops for the next marginal cost computation
    const pickups = new Map<string, GeoPoint>(
      selected.map((m) => [m.riderId, riderMap.get(m.riderId)!.pickup]),
    );
    const dropoffs = new Map<string, GeoPoint>(
      selected.map((m) => [m.riderId, riderMap.get(m.riderId)!.dropoff]),
    );
    currentStops = orderStops(driver, selected, pickups, dropoffs);
  }

  if (selected.length === 0) return null;

  // Aggregate metrics
  const totalScore = selected.reduce((sum, m) => sum + m.score, 0);
  const totalCarbon = selected.reduce((sum, m) => sum + (m.carbonSavedKg ?? 0), 0);
  // Convert cumulative km to minutes for display (30 km/h urban average)
  const totalDetourMinutes = Math.round((cumulativeDetourKm / 30) * 60 * 10) / 10;

  return {
    driverTripId: driver.id,
    driverId: driver.driverId,
    riders: selected,
    totalScore,
    averageScore: totalScore / selected.length,
    seatsUsed,
    seatsRemaining: maxSeats - seatsUsed,
    totalDetourMinutes,
    totalCarbonSavedKg: Math.round(totalCarbon * 100) / 100,
    orderedStops: currentStops,
  };
}

/**
 * Find the best pool assignment across multiple drivers.
 *
 * For each driver, we take the rider matches assigned to that driver and
 * run the pool optimizer. Returns the top pools sorted by average score.
 */
export function optimizeMultiDriverPools(
  driverMatches: Map<string, { driver: DriverTrip; matches: MatchResult[] }>,
  riderMap: Map<string, { pickup: GeoPoint; dropoff: GeoPoint }>,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): PoolAssignment[] {
  const pools: PoolAssignment[] = [];

  for (const [, { driver, matches }] of driverMatches) {
    const pool = optimizePool(driver, matches, riderMap, config);
    if (pool) {
      pools.push(pool);
    }
  }

  // Sort pools by average score (lower = better)
  pools.sort((a, b) => a.averageScore - b.averageScore);

  return pools;
}

/**
 * Assign multiple pending rider requests to the best available drivers.
 *
 * This is the top-level "dispatch" function used by cron jobs or webhooks.
 *
 * Algorithm:
 *   1. For each rider, collect their best driver matches
 *   2. Group matches by driver
 *   3. For each driver, optimise the rider pool
 *   4. Resolve conflicts (rider assigned to multiple drivers) by keeping
 *      the assignment with the best score
 *
 * @returns Map of riderId → best PoolAssignment they were included in
 */
export function assignRidersToDrivers(
  riderMatches: Map<string, MatchResult[]>,
  drivers: Map<string, DriverTrip>,
  riderMap: Map<string, { pickup: GeoPoint; dropoff: GeoPoint }>,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): Map<string, { pool: PoolAssignment; match: MatchResult }> {
  // Step 1: Group matches by driver
  const driverGroups = new Map<string, { driver: DriverTrip; matches: MatchResult[] }>();

  for (const [, matches] of riderMatches) {
    for (const match of matches) {
      const driver = drivers.get(match.driverTripId);
      if (!driver) continue;

      if (!driverGroups.has(match.driverTripId)) {
        driverGroups.set(match.driverTripId, { driver, matches: [] });
      }
      driverGroups.get(match.driverTripId)!.matches.push(match);
    }
  }

  // Deduplicate matches per driver (keep best score per rider)
  for (const [, group] of driverGroups) {
    const bestPerRider = new Map<string, MatchResult>();
    for (const match of group.matches) {
      const existing = bestPerRider.get(match.riderId);
      if (!existing || match.score < existing.score) {
        bestPerRider.set(match.riderId, match);
      }
    }
    group.matches = Array.from(bestPerRider.values()).sort(
      (a, b) => a.score - b.score,
    );
  }

  // Step 2: Optimise pools per driver
  const pools = optimizeMultiDriverPools(driverGroups, riderMap, config);

  // Step 3: Resolve conflicts — each rider gets their best assignment
  const assignments = new Map<string, { pool: PoolAssignment; match: MatchResult }>();

  for (const pool of pools) {
    for (const match of pool.riders) {
      const existing = assignments.get(match.riderId);
      if (!existing || match.score < existing.match.score) {
        assignments.set(match.riderId, { pool, match });
      }
    }
  }

  return assignments;
}
