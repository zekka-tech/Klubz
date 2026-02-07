/**
 * Klubz Smart Trip Pooling - Geo Utilities
 *
 * Production-grade geospatial helpers optimised for Cloudflare Workers.
 * All functions are pure, allocation-light, and avoid Node-only APIs.
 *
 * Includes:
 *  - Haversine distance
 *  - Point-to-segment perpendicular distance
 *  - Minimum distance from a point to a polyline (segment-aware)
 *  - Bounding-box construction & containment
 *  - Polyline index lookup (nearest segment to a point)
 *  - Detour distance estimation
 *  - Route ordering validation
 *  - Carbon-savings estimator
 */

import type { GeoPoint, BoundingBox } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mean Earth radius in kilometres (WGS-84 volumetric). */
const EARTH_RADIUS_KM = 6371.0088;

/** Degrees-to-radians conversion factor. */
const DEG2RAD = Math.PI / 180;

/** Average CO2 emissions per km for a single-occupancy car (kg). */
const CO2_PER_KM_SINGLE = 0.21;

// ---------------------------------------------------------------------------
// Core Distance Functions
// ---------------------------------------------------------------------------

/**
 * Convert degrees to radians.
 */
export function toRad(degrees: number): number {
  return degrees * DEG2RAD;
}

/**
 * Haversine distance between two points on the Earth.
 *
 * @returns Distance in **kilometres**.
 */
export function haversine(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Perpendicular (great-circle cross-track) distance from a point to
 * the line segment defined by two endpoints.
 *
 * If the perpendicular foot falls outside the segment, falls back to
 * the closer endpoint distance.
 *
 * @returns Distance in **kilometres**.
 */
export function pointToSegmentDistance(
  point: GeoPoint,
  segA: GeoPoint,
  segB: GeoPoint,
): number {
  const dAP = haversine(segA, point);
  const dBP = haversine(segB, point);
  const dAB = haversine(segA, segB);

  // Point coincides with an endpoint
  if (dAP < 1e-9) return 0;
  if (dBP < 1e-9) return 0;

  // Degenerate segment (same point)
  if (dAB < 1e-9) return dAP;

  // Project point onto the line using the angular approach.
  // t is the fractional distance along AB where the perpendicular foot is.
  const cosC =
    (dAP * dAP + dAB * dAB - dBP * dBP) / (2 * dAP * dAB);

  // If t < 0 the foot is before A; if t > 1 it's past B.
  if (cosC < 0) return dAP; // closer to A
  const t = (dAP * cosC) / dAB;
  if (t > 1) return dBP; // closer to B

  // Perpendicular distance via cross-track formula (spherical).
  const sinC = Math.sqrt(Math.max(0, 1 - cosC * cosC));
  const crossTrack = dAP * sinC;

  return crossTrack;
}

// ---------------------------------------------------------------------------
// Polyline Utilities
// ---------------------------------------------------------------------------

/**
 * Minimum distance from a point to a polyline, using **segment-aware**
 * projection rather than naive vertex-only sampling.
 *
 * Also returns the index of the nearest segment.
 *
 * @returns `{ distance, segmentIndex }` distance in km.
 */
export function minDistanceToRoute(
  point: GeoPoint,
  route: GeoPoint[],
): { distance: number; segmentIndex: number } {
  if (route.length === 0) {
    return { distance: Infinity, segmentIndex: -1 };
  }
  if (route.length === 1) {
    return { distance: haversine(point, route[0]), segmentIndex: 0 };
  }

  let minDist = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const d = pointToSegmentDistance(point, route[i], route[i + 1]);
    if (d < minDist) {
      minDist = d;
      bestIdx = i;
    }
  }

  return { distance: minDist, segmentIndex: bestIdx };
}

/**
 * Simple minimum distance (km) using vertex-only checks.
 * Faster but less accurate than segment-aware version.
 * Use for initial rough screening.
 */
export function minDistanceToRouteSimple(
  point: GeoPoint,
  route: GeoPoint[],
): number {
  let min = Infinity;
  for (const r of route) {
    const d = haversine(point, r);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Total polyline length in km (sum of segment lengths).
 */
export function polylineLength(route: GeoPoint[]): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += haversine(route[i], route[i + 1]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Bounding Box
// ---------------------------------------------------------------------------

/**
 * Build an axis-aligned bounding box that encloses a set of points.
 */
export function buildBoundingBox(points: GeoPoint[]): BoundingBox {
  if (points.length === 0) {
    return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Expand a bounding box by `paddingDeg` degrees on all sides.
 */
export function padBoundingBox(
  box: BoundingBox,
  paddingDeg: number,
): BoundingBox {
  return {
    minLat: box.minLat - paddingDeg,
    maxLat: box.maxLat + paddingDeg,
    minLng: box.minLng - paddingDeg,
    maxLng: box.maxLng + paddingDeg,
  };
}

/**
 * Check whether a point is inside a bounding box.
 */
export function isInsideBoundingBox(
  point: GeoPoint,
  box: BoundingBox,
): boolean {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lng >= box.minLng &&
    point.lng <= box.maxLng
  );
}

/**
 * Check whether two bounding boxes overlap.
 */
export function boundingBoxesOverlap(
  a: BoundingBox,
  b: BoundingBox,
): boolean {
  return !(
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat ||
    a.maxLng < b.minLng ||
    a.minLng > b.maxLng
  );
}

// ---------------------------------------------------------------------------
// Route Ordering & Detour Estimation
// ---------------------------------------------------------------------------

/**
 * Validates that the pickup occurs **before** the dropoff along the route
 * direction (i.e. pickupSegmentIndex <= dropoffSegmentIndex).
 */
export function isPickupBeforeDropoff(
  pickup: GeoPoint,
  dropoff: GeoPoint,
  route: GeoPoint[],
): boolean {
  const { segmentIndex: pickIdx } = minDistanceToRoute(pickup, route);
  const { segmentIndex: dropIdx } = minDistanceToRoute(dropoff, route);
  return pickIdx <= dropIdx;
}

/**
 * Estimate the additional detour distance (km) a driver would incur by
 * serving a rider (pickup + dropoff).
 *
 * The estimation uses:
 *   detour = dist(route_nearest_to_pickup, pickup)
 *          + dist(pickup, dropoff)        // rider in-vehicle
 *          + dist(dropoff, route_nearest_to_dropoff)
 *          - dist(route_nearest_to_pickup, route_nearest_to_dropoff)  // original segment
 *
 * This is an approximation — real detour requires re-routing.
 */
export function estimateDetourKm(
  pickup: GeoPoint,
  dropoff: GeoPoint,
  route: GeoPoint[],
): number {
  if (route.length < 2) {
    return haversine(pickup, dropoff);
  }

  const { distance: pickupDist, segmentIndex: pickIdx } =
    minDistanceToRoute(pickup, route);
  const { distance: dropoffDist, segmentIndex: dropIdx } =
    minDistanceToRoute(dropoff, route);

  // Distance along the original route between the two nearest segments
  let originalDist = 0;
  const startIdx = Math.min(pickIdx, dropIdx);
  const endIdx = Math.max(pickIdx, dropIdx);
  for (let i = startIdx; i <= endIdx && i < route.length - 1; i++) {
    originalDist += haversine(route[i], route[i + 1]);
  }

  // Detour path: divert to pickup → ride to dropoff → rejoin route
  const riderDist = haversine(pickup, dropoff);
  const detourPath = pickupDist + riderDist + dropoffDist;

  return Math.max(0, detourPath - originalDist);
}

/**
 * Estimate the time cost of a detour in minutes, assuming an average
 * urban speed of 30 km/h.
 */
export function estimateDetourMinutes(
  detourKm: number,
  avgSpeedKmh = 30,
): number {
  return (detourKm / avgSpeedKmh) * 60;
}

// ---------------------------------------------------------------------------
// Carbon Savings
// ---------------------------------------------------------------------------

/**
 * Estimate CO2 savings from sharing a ride (kg CO2).
 *
 * Each rider who joins avoids driving their own route, saving roughly
 * `riderRouteKm * CO2_PER_KM_SINGLE` kg CO2.
 *
 * A small deduction is made for the additional detour the driver incurs.
 */
export function estimateCarbonSavedKg(
  riderDistanceKm: number,
  detourKm: number,
): number {
  const saved = riderDistanceKm * CO2_PER_KM_SINGLE;
  const cost = detourKm * CO2_PER_KM_SINGLE * 0.5; // shared cost
  return Math.max(0, saved - cost);
}

// ---------------------------------------------------------------------------
// Encoding / Decoding Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a Google-encoded polyline string into an array of GeoPoints.
 *
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): GeoPoint[] {
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    // Decode latitude
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;

    // Decode longitude
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

/**
 * Encode an array of GeoPoints into a Google-encoded polyline string.
 */
export function encodePolyline(points: GeoPoint[]): string {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);

    encoded += encodeValue(lat - prevLat);
    encoded += encodeValue(lng - prevLng);

    prevLat = lat;
    prevLng = lng;
  }

  return encoded;
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';

  while (v >= 0x20) {
    encoded += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  encoded += String.fromCharCode(v + 63);

  return encoded;
}

/**
 * Simplify a polyline by removing intermediate points that add less than
 * `toleranceKm` deviation.  Uses Ramer-Douglas-Peucker algorithm.
 *
 * Useful for reducing the size of cached polylines in KV.
 */
export function simplifyPolyline(
  points: GeoPoint[],
  toleranceKm: number,
): GeoPoint[] {
  if (points.length <= 2) return [...points];

  // Find the point with the maximum distance from the line segment
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > toleranceKm) {
    const left = simplifyPolyline(points.slice(0, maxIdx + 1), toleranceKm);
    const right = simplifyPolyline(points.slice(maxIdx), toleranceKm);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}
