-- Migration 0005: Notifications table and indexes
-- Date: 2026-02-17
-- Purpose: Persist in-app/email/sms notification records with query-friendly indexes

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  trip_id INTEGER,
  notification_type TEXT NOT NULL
    CHECK (notification_type IN ('booking_request', 'booking_accepted', 'booking_rejected', 'trip_cancelled', 'payment_succeeded', 'payment_failed', 'system')),
  channel TEXT NOT NULL
    CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'read')),
  subject TEXT,
  message TEXT NOT NULL,
  metadata TEXT,
  sent_at DATETIME,
  delivered_at DATETIME,
  read_at DATETIME,
  failure_reason TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_status
ON notifications(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_type
ON notifications(notification_type, status);

CREATE INDEX IF NOT EXISTS idx_notifications_trip
ON notifications(trip_id, created_at DESC);
