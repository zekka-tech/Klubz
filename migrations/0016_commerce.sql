-- Migration 0016: Commerce — Disputes & Promo Codes

-- Trip disputes
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  filed_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  evidence_text TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','resolved','closed')),
  resolution TEXT,
  refund_issued INTEGER DEFAULT 0,
  refund_amount_cents INTEGER,
  admin_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_disputes_trip_id ON disputes(trip_id);
CREATE INDEX IF NOT EXISTS idx_disputes_filed_by ON disputes(filed_by);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- Promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed_cents')),
  discount_value INTEGER NOT NULL,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  min_fare_cents INTEGER DEFAULT 0,
  expires_at TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Promo redemptions (one per user per code)
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  trip_id INTEGER REFERENCES trips(id),
  discount_applied_cents INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(promo_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user_id ON promo_redemptions(user_id);
