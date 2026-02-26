-- Migration 0004: Performance Indexes
-- Date: 2026-02-12
-- Purpose: Add indexes to optimize common query patterns

-- NOTE:
-- This migration must be safe on a clean database created from 0001 + 0002 + 0003.
-- Some legacy environments may not have optional feature tables/columns yet.
-- We only create indexes for schema that is guaranteed by prior migrations.
--
-- Matching-engine tables (`driver_trips`, `rider_requests`, etc.) are introduced
-- in 0010_smart_matching.sql. Keep matching indexes with that migration so clean
-- replay does not depend on historical numbering drift.

-- ═══════════════════════════════════════════════════════════════════════════
-- Trip Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize trip search queries (status + departure time)
CREATE INDEX IF NOT EXISTS idx_trips_status_departure
ON trips(status, departure_time);

-- Optimize driver's trips queries
CREATE INDEX IF NOT EXISTS idx_trips_driver_status
ON trips(driver_id, status);

-- Optimize trip location searches
CREATE INDEX IF NOT EXISTS idx_trips_origin_hash
ON trips(origin_hash);

CREATE INDEX IF NOT EXISTS idx_trips_destination_hash
ON trips(destination_hash);

-- ═══════════════════════════════════════════════════════════════════════════
-- Trip Participants Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize user's bookings queries
CREATE INDEX IF NOT EXISTS idx_trip_participants_user_status
ON trip_participants(user_id, status);

-- Optimize trip's participants queries
CREATE INDEX IF NOT EXISTS idx_trip_participants_trip_status
ON trip_participants(trip_id, status);

-- Optimize role-based queries (drivers vs riders)
CREATE INDEX IF NOT EXISTS idx_trip_participants_role
ON trip_participants(role, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- User Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize email lookups (authentication)
CREATE INDEX IF NOT EXISTS idx_users_email_hash
ON users(email_hash);

-- Optimize active user queries
CREATE INDEX IF NOT EXISTS idx_users_active
ON users(is_active, deleted_at);

-- Optimize role-based queries
CREATE INDEX IF NOT EXISTS idx_users_role
ON users(role, deleted_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- Session Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
ON sessions(user_id, is_active);

-- Optimize session expiration cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_expires
ON sessions(expires_at);

-- Optimize refresh token lookups
-- Current schema guarantees token_hash. refresh_token_hash may not exist on all DBs.
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token
ON sessions(token_hash);

-- ═══════════════════════════════════════════════════════════════════════════
-- Audit Log Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize user audit log queries (most recent first)
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
ON audit_logs(user_id, created_at DESC);

-- Optimize entity audit trail queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON audit_logs(entity_type, entity_id, created_at DESC);

-- Optimize action-based queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
ON audit_logs(action, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- Matching Engine Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Intentionally omitted in this migration:
-- Matching tables are created later in 0010_smart_matching.sql and receive
-- dedicated indexes there (idx_dt_*, idx_rr_*).

-- ═══════════════════════════════════════════════════════════════════════════
-- Notification Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Notification indexes intentionally omitted here because notifications table
-- is not part of the base schema yet. Add in a dedicated migration when the
-- notifications table is introduced.

-- ═══════════════════════════════════════════════════════════════════════════
-- Data Retention Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- Optimize deleted user cleanup queries
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
ON users(deleted_at)
WHERE deleted_at IS NOT NULL;

-- Optimize old audit log cleanup
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
ON audit_logs(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════

-- Query to verify all indexes were created
-- SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY tbl_name, name;
