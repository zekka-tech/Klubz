-- Migration: Smart Trip Pooling - Matching Engine Tables
-- Adds driver_trips, rider_requests, match_results, and pool_assignments
-- for the Klubz intelligent ride-matching system.
--
-- Designed for Cloudflare D1 (SQLite). Uses bounding-box columns on
-- driver_trips for fast SQL-level spatial pre-filtering.

-- =====================================================================
-- Driver Trips (offers)
-- =====================================================================
CREATE TABLE IF NOT EXISTS driver_trips (
  id TEXT PRIMARY KEY,                    -- UUID
  driver_id INTEGER NOT NULL,             -- FK → users.id
  organization_id TEXT,

  -- Origin / Destination (plaintext lat/lng for matching)
  departure_lat REAL NOT NULL,
  departure_lng REAL NOT NULL,
  destination_lat REAL NOT NULL,
  destination_lng REAL NOT NULL,

  -- Optional shift / workplace location
  shift_lat REAL,
  shift_lng REAL,

  -- Timestamps (unix ms)
  departure_time INTEGER NOT NULL,        -- planned departure (ms)
  arrival_time INTEGER,                   -- estimated arrival (ms)

  -- Capacity
  available_seats INTEGER NOT NULL CHECK (available_seats >= 0),
  total_seats INTEGER NOT NULL CHECK (total_seats > 0),

  -- Pre-computed bounding box for SQL spatial filtering
  bbox_min_lat REAL,
  bbox_max_lat REAL,
  bbox_min_lng REAL,
  bbox_max_lng REAL,

  -- Route polyline (Google-encoded string, decoded in JS)
  route_polyline_encoded TEXT,
  route_distance_km REAL,

  -- Status lifecycle
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','active','completed','cancelled','expired')),

  -- Driver metadata
  driver_rating REAL,

  -- Vehicle (JSON blob)
  vehicle_json TEXT,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for matching query patterns
CREATE INDEX IF NOT EXISTS idx_dt_status ON driver_trips(status);
CREATE INDEX IF NOT EXISTS idx_dt_departure_time ON driver_trips(departure_time);
CREATE INDEX IF NOT EXISTS idx_dt_driver_id ON driver_trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_dt_org ON driver_trips(organization_id);
CREATE INDEX IF NOT EXISTS idx_dt_seats ON driver_trips(available_seats);

-- Spatial bounding-box indexes (used by SQL pre-filter)
CREATE INDEX IF NOT EXISTS idx_dt_bbox_lat ON driver_trips(bbox_min_lat, bbox_max_lat);
CREATE INDEX IF NOT EXISTS idx_dt_bbox_lng ON driver_trips(bbox_min_lng, bbox_max_lng);

-- Composite index for the primary matching query
CREATE INDEX IF NOT EXISTS idx_dt_match_query ON driver_trips(
  status,
  departure_time,
  available_seats,
  bbox_min_lat,
  bbox_max_lat,
  bbox_min_lng,
  bbox_max_lng
);

-- =====================================================================
-- Rider Requests
-- =====================================================================
CREATE TABLE IF NOT EXISTS rider_requests (
  id TEXT PRIMARY KEY,                    -- UUID
  rider_id INTEGER NOT NULL,              -- FK → users.id
  organization_id TEXT,

  -- Pickup / Dropoff
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  dropoff_lat REAL NOT NULL,
  dropoff_lng REAL NOT NULL,

  -- Time window (unix ms)
  earliest_departure INTEGER NOT NULL,
  latest_departure INTEGER NOT NULL,

  seats_needed INTEGER NOT NULL DEFAULT 1 CHECK (seats_needed > 0),

  -- Preferences (JSON blob)
  preferences_json TEXT,

  -- Status lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','matched','confirmed','in_progress','completed','cancelled','expired')),

  -- If matched, which match/pool
  matched_driver_trip_id TEXT,
  matched_at DATETIME,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_driver_trip_id) REFERENCES driver_trips(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_rr_status ON rider_requests(status);
CREATE INDEX IF NOT EXISTS idx_rr_rider_id ON rider_requests(rider_id);
CREATE INDEX IF NOT EXISTS idx_rr_org ON rider_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_rr_time ON rider_requests(earliest_departure, latest_departure);
CREATE INDEX IF NOT EXISTS idx_rr_matched ON rider_requests(matched_driver_trip_id);

-- =====================================================================
-- Match Results (individual rider-driver matches)
-- =====================================================================
CREATE TABLE IF NOT EXISTS match_results (
  id TEXT PRIMARY KEY,                    -- UUID
  driver_trip_id TEXT NOT NULL,
  rider_request_id TEXT NOT NULL,
  driver_id INTEGER NOT NULL,
  rider_id INTEGER NOT NULL,

  -- Composite score (lower = better)
  score REAL NOT NULL,

  -- Breakdown (JSON blob)
  breakdown_json TEXT NOT NULL,

  -- Human-readable explanation
  explanation TEXT,

  -- Estimates
  estimated_pickup_time INTEGER,          -- unix ms
  estimated_detour_minutes REAL,
  carbon_saved_kg REAL,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','cancelled','expired')),

  confirmed_at DATETIME,
  rejected_at DATETIME,
  rejection_reason TEXT,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (driver_trip_id) REFERENCES driver_trips(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_request_id) REFERENCES rider_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,

  UNIQUE(driver_trip_id, rider_request_id)
);

CREATE INDEX IF NOT EXISTS idx_mr_driver_trip ON match_results(driver_trip_id);
CREATE INDEX IF NOT EXISTS idx_mr_rider_request ON match_results(rider_request_id);
CREATE INDEX IF NOT EXISTS idx_mr_status ON match_results(status);
CREATE INDEX IF NOT EXISTS idx_mr_score ON match_results(score);

-- =====================================================================
-- Pool Assignments (multi-rider optimized assignments per driver)
-- =====================================================================
CREATE TABLE IF NOT EXISTS pool_assignments (
  id TEXT PRIMARY KEY,                    -- UUID
  driver_trip_id TEXT NOT NULL,
  driver_id INTEGER NOT NULL,

  -- Aggregated metrics
  total_score REAL NOT NULL,
  average_score REAL NOT NULL,
  seats_used INTEGER NOT NULL,
  seats_remaining INTEGER NOT NULL,
  total_detour_minutes REAL NOT NULL,
  total_carbon_saved_kg REAL NOT NULL,

  -- Ordered stop list (JSON array of PoolStop)
  ordered_stops_json TEXT NOT NULL,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','active','completed','cancelled')),

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (driver_trip_id) REFERENCES driver_trips(id) ON DELETE CASCADE,
  FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pa_driver_trip ON pool_assignments(driver_trip_id);
CREATE INDEX IF NOT EXISTS idx_pa_status ON pool_assignments(status);

-- =====================================================================
-- Pool Members (junction: pool_assignments ↔ match_results)
-- =====================================================================
CREATE TABLE IF NOT EXISTS pool_members (
  id TEXT PRIMARY KEY,
  pool_assignment_id TEXT NOT NULL,
  match_result_id TEXT NOT NULL,
  rider_id INTEGER NOT NULL,

  -- Position in the stop order
  pickup_order INTEGER NOT NULL,
  dropoff_order INTEGER NOT NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (pool_assignment_id) REFERENCES pool_assignments(id) ON DELETE CASCADE,
  FOREIGN KEY (match_result_id) REFERENCES match_results(id) ON DELETE CASCADE,
  FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,

  UNIQUE(pool_assignment_id, rider_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_pool ON pool_members(pool_assignment_id);
CREATE INDEX IF NOT EXISTS idx_pm_rider ON pool_members(rider_id);

-- =====================================================================
-- Route Polyline Cache (for KV fall-through)
-- =====================================================================
CREATE TABLE IF NOT EXISTS route_polylines (
  id TEXT PRIMARY KEY,                    -- same as driver_trip_id
  driver_trip_id TEXT NOT NULL UNIQUE,
  encoded_polyline TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  total_distance_km REAL,
  simplified_polyline TEXT,               -- RDP-simplified for quick matching
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (driver_trip_id) REFERENCES driver_trips(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rp_driver_trip ON route_polylines(driver_trip_id);

-- =====================================================================
-- Matching Configuration Overrides (per-organization)
-- =====================================================================
CREATE TABLE IF NOT EXISTS matching_config (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,              -- serialised MatchConfig
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mc_org ON matching_config(organization_id);
