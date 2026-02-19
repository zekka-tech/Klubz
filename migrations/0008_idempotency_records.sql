-- Migration 0008: Add durable idempotency record store
-- Purpose: Preserve write-idempotency contracts when KV is unavailable

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  response_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at
ON idempotency_records(created_at);
