-- Migration 0021: Stripe Connect account and payout tracking

ALTER TABLE users ADD COLUMN stripe_connect_account_id TEXT;
ALTER TABLE users ADD COLUMN stripe_connect_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE trip_participants ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(payout_status IN ('pending', 'transferred', 'failed', 'not_applicable'));
ALTER TABLE trip_participants ADD COLUMN payout_transfer_id TEXT;
ALTER TABLE trip_participants ADD COLUMN payout_transferred_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_users_stripe_connect_account
ON users(stripe_connect_account_id);

CREATE INDEX IF NOT EXISTS idx_trip_participants_payout_status
ON trip_participants(payout_status);
