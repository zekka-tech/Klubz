-- Migration 0007: Add durable replay ledger for Stripe webhook events
-- Purpose: Preserve webhook event deduplication across worker restarts and KV unavailability

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
ON processed_webhook_events(processed_at);
