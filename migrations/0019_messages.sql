-- Migration 0019: In-app trip messaging

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_encrypted TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_trip_sent
ON messages(trip_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender
ON messages(sender_id, sent_at DESC);
