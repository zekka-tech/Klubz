/**
 * Klubz Smart Trip Pooling - Module Index
 *
 * Re-exports all public APIs for the matching engine.
 */

// Types
export type {
  GeoPoint,
  BoundingBox,
  GeoLocation,
  DriverTrip,
  DriverTripStatus,
  VehicleInfo,
  RiderRequest,
  RiderRequestStatus,
  RiderPreferences,
  MatchResult,
  ScoreBreakdown,
  PoolAssignment,
  PoolStop,
  MatchWeights,
  MatchThresholds,
  MatchConfig,
  FindMatchesRequest,
  FindMatchesResponse,
  CreateDriverTripRequest,
  CreateRiderRequestPayload,
  ConfirmMatchRequest,
  MatchStatusResponse,
} from './types';

export { DEFAULT_MATCH_CONFIG } from './types';

// Geo utilities
export {
  toRad,
  haversine,
  pointToSegmentDistance,
  minDistanceToRoute,
  minDistanceToRouteSimple,
  polylineLength,
  buildBoundingBox,
  padBoundingBox,
  isInsideBoundingBox,
  boundingBoxesOverlap,
  isPickupBeforeDropoff,
  estimateDetourKm,
  estimateDetourMinutes,
  estimateCarbonSavedKg,
  decodePolyline,
  encodePolyline,
  simplifyPolyline,
} from './geo';

// Matching engine
export {
  matchRiderToDrivers,
  batchMatchRiders,
} from './engine';
export type { MatchingStats } from './engine';

// Multi-rider optimizer
export {
  optimizePool,
  optimizeMultiDriverPools,
  assignRidersToDrivers,
} from './optimizer';

// D1 repository
export { MatchingRepository } from './repository';
