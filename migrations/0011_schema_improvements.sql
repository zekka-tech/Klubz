-- Migration 0011: Schema improvements from audit findings
-- Adds missing audit/reconciliation columns, retry tracking, and performance indexes.

-- ── trip_participants: payment reconciliation columns ───────────────────────
ALTER TABLE trip_participants ADD COLUMN amount_paid REAL;
ALTER TABLE trip_participants ADD COLUMN amount_refunded REAL;

-- ── notifications: retry tracking ──────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN last_retry_at DATETIME;

-- ── audit_logs: PII protection flag ────────────────────────────────────────
ALTER TABLE audit_logs ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE;

-- ── notifications: index for recent notifications without user filter ───────
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
ON notifications(created_at DESC);
