-- Migration 0006: User preferences persistence
-- Date: 2026-02-17
-- Purpose: Persist user-level notification/privacy/accessibility preferences

CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  notifications_json TEXT NOT NULL,
  privacy_json TEXT NOT NULL,
  accessibility_json TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  currency TEXT NOT NULL DEFAULT 'ZAR',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
ON user_preferences(user_id);
