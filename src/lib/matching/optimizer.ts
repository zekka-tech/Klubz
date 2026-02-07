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
  estimateDetourKm,
  estimateDetourMinutes,
  estimateCarbonSavedKg,
  minDistanceToRoute,
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
 * Estimate the cumulative detour of the current pool (sum of individual
 * detour estimates). This is an approximation; real detour would require
 * full re-routing with all stops.
 */
function estimatePoolDetour(
  driver: DriverTrip,
  riders: MatchResult[],
): number {
  let total = 0;
  for (const rider of riders) {
    total += rider.estimatedDetourMinutes ?? 0;
  }
  // Shared rides tend to have overlapping detours, so apply a discount
  const overlapDiscount = riders.length > 1 ? 0.7 : 1.0;
  return total * overlapDiscount;
}

/**
 * Optimise a pool of riders for a single driver trip.
 *
 * Algorithm:
 *   1. Sort candidate matches by score (best first)
 *   2. Greedily add riders one by one
 *   3. After each addition, check:
 *      a. Seat constraint is still satisfied
 *      b. Cumulative detour is within budget
 *   4. If adding a rider violates constraints, skip it
 *   5. Return the best valid combination found
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
  const maxDetour = config.maxPoolDetourMinutes;
  const maxSeats = driver.availableSeats;

  // Candidates are already sorted by score (ascending = better)
  const selected: MatchResult[] = [];
  let seatsUsed = 0;

  for (const candidate of candidates) {
    // Determine seats needed (stored in breakdown or default 1)
    const seatsNeeded = 1; // Each match represents 1 rider request

    // Seat check
    if (seatsUsed + seatsNeeded > maxSeats) continue;

    // Max riders check
    if (selected.length >= maxRiders) break;

    // Tentatively add and check detour
    const tentative = [...selected, candidate];
    const poolDetour = estimatePoolDetour(driver, tentative);
    if (poolDetour > maxDetour) continue;

    // All checks passed — add to pool
    selected.push(candidate);
    seatsUsed += seatsNeeded;
  }

  if (selected.length === 0) return null;

  // Build ordered stop list
  const pickups = new Map<string, GeoPoint>();
  const dropoffs = new Map<string, GeoPoint>();
  for (const match of selected) {
    const riderData = riderMap.get(match.riderId);
    if (riderData) {
      pickups.set(match.riderId, riderData.pickup);
      dropoffs.set(match.riderId, riderData.dropoff);
    }
  }
  const orderedStops = orderStops(driver, selected, pickups, dropoffs);

  // Aggregate metrics
  const totalScore = selected.reduce((sum, m) => sum + m.score, 0);
  const totalDetour = estimatePoolDetour(driver, selected);
  const totalCarbon = selected.reduce((sum, m) => sum + (m.carbonSavedKg ?? 0), 0);

  return {
    driverTripId: driver.id,
    driverId: driver.driverId,
    riders: selected,
    totalScore,
    averageScore: totalScore / selected.length,
    seatsUsed,
    seatsRemaining: maxSeats - seatsUsed,
    totalDetourMinutes: Math.round(totalDetour * 10) / 10,
    totalCarbonSavedKg: Math.round(totalCarbon * 100) / 100,
    orderedStops,
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

  for (const [driverTripId, { driver, matches }] of driverMatches) {
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

  for (const [riderId, matches] of riderMatches) {
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
