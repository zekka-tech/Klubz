-- Migration 0020: Trip waitlist and auto-promotion support

CREATE TABLE IF NOT EXISTS trip_waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passenger_count INTEGER NOT NULL DEFAULT 1 CHECK(passenger_count > 0 AND passenger_count <= 4),
  joined_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'now')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'promoted', 'expired', 'removed')),
  promoted_at TEXT,
  UNIQUE(trip_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_waitlist_trip
ON trip_waitlist(trip_id, status, joined_at);

CREATE INDEX IF NOT EXISTS idx_trip_waitlist_user
ON trip_waitlist(user_id, status, joined_at DESC);
