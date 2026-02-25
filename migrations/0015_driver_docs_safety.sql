-- Migration 0015: Driver Documents & Safety Features

-- Driver document verification
CREATE TABLE IF NOT EXISTS driver_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('drivers_license','id_document','vehicle_registration','proof_of_insurance')),
  file_key TEXT NOT NULL,
  file_name_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  rejection_reason TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_driver_documents_user_id ON driver_documents(user_id, doc_type);

-- Add documents_verified flag to users
ALTER TABLE users ADD COLUMN documents_verified INTEGER NOT NULL DEFAULT 0;

-- Emergency contacts
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_encrypted TEXT NOT NULL,
  phone_encrypted TEXT NOT NULL,
  relationship TEXT,
  is_primary INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user_id ON emergency_contacts(user_id);

-- SOS events
CREATE TABLE IF NOT EXISTS sos_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  trip_id INTEGER REFERENCES trips(id),
  lat REAL,
  lng REAL,
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sos_events_user_id ON sos_events(user_id);
