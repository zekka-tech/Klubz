-- Initial database schema for Klubz enterprise carpooling platform
-- Supports POPIA/GDPR compliance with encryption and audit logging

-- Users table with PII encryption support
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  email_hash TEXT NOT NULL, -- Hashed email for lookup without exposing email
  password_hash TEXT NOT NULL,
  first_name_encrypted TEXT, -- AES encrypted
  last_name_encrypted TEXT,   -- AES encrypted
  phone_encrypted TEXT,      -- AES encrypted (optional)
  avatar_url TEXT,
  role TEXT CHECK (role IN ('user', 'admin', 'super_admin')) DEFAULT 'user',
  is_active BOOLEAN DEFAULT TRUE,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret_encrypted TEXT,  -- TOTP secret (encrypted)
  backup_codes_encrypted TEXT, -- Backup codes (encrypted)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME,
  deleted_at DATETIME DEFAULT NULL, -- Soft delete for GDPR
  created_ip TEXT,
  updated_ip TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- Trips table
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL, -- Encrypted coordinates
  destination TEXT NOT NULL, -- Encrypted coordinates
  origin_hash TEXT NOT NULL, -- Hashed for search
  destination_hash TEXT NOT NULL, -- Hashed for search
  departure_time DATETIME NOT NULL,
  arrival_time DATETIME,
  available_seats INTEGER NOT NULL CHECK (available_seats > 0),
  total_seats INTEGER NOT NULL CHECK (total_seats > 0),
  price_per_seat DECIMAL(10,2) DEFAULT 0.00,
  currency TEXT DEFAULT 'USD',
  status TEXT CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')) DEFAULT 'scheduled',
  vehicle_type TEXT CHECK (vehicle_type IN ('sedan', 'suv', 'van', 'truck', 'electric', 'hybrid')) DEFAULT 'sedan',
  vehicle_model_encrypted TEXT, -- Encrypted for privacy
  vehicle_plate_encrypted TEXT, -- Encrypted for privacy
  driver_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (driver_id) REFERENCES users(id)
);

-- Indexes for trips
CREATE INDEX IF NOT EXISTS idx_trips_driver_id ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_trips_departure_time ON trips(departure_time);
CREATE INDEX IF NOT EXISTS idx_trips_origin_hash ON trips(origin_hash);
CREATE INDEX IF NOT EXISTS idx_trips_destination_hash ON trips(destination_hash);

-- Trip participants (riders)
CREATE TABLE IF NOT EXISTS trip_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT CHECK (role IN ('driver', 'rider')) DEFAULT 'rider',
  status TEXT CHECK (status IN ('requested', 'accepted', 'rejected', 'completed', 'cancelled')) DEFAULT 'requested',
  pickup_location_encrypted TEXT, -- Encrypted coordinates
  pickup_location_hash TEXT, -- Hashed for matching
  dropoff_location_encrypted TEXT, -- Encrypted coordinates
  dropoff_location_hash TEXT, -- Hashed for matching
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  accepted_at DATETIME DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5) DEFAULT NULL,
  review_encrypted TEXT, -- Encrypted review text
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(trip_id, user_id)
);

-- Indexes for trip participants
CREATE INDEX IF NOT EXISTS idx_trip_participants_trip_id ON trip_participants(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_participants_user_id ON trip_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_trip_participants_status ON trip_participants(status);

-- Audit log table for compliance
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- 'user', 'trip', 'participant', etc.
  entity_id INTEGER,
  old_values_encrypted TEXT, -- JSON of changed fields (encrypted)
  new_values_encrypted TEXT,  -- JSON of changed fields (encrypted)
  ip_address TEXT,
  user_agent TEXT,
  session_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL, -- IP address or user ID
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  request_count INTEGER DEFAULT 1,
  window_start DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- Indexes for rate limiting
CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier);
CREATE INDEX IF NOT EXISTS idx_rate_limits_endpoint ON rate_limits(endpoint, method);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- Sessions table for secure session management
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, -- UUID
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL, -- Hashed session token
  ip_address TEXT,
  user_agent TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active, last_accessed_at);

-- GDPR data export requests
CREATE TABLE IF NOT EXISTS data_export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_type TEXT CHECK (request_type IN ('export', 'deletion')) NOT NULL,
  status TEXT CHECK (status IN ('pending', 'processing', 'completed', 'failed')) DEFAULT 'pending',
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  export_data_encrypted TEXT, -- Exported data (encrypted)
  failure_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for data export requests
CREATE INDEX IF NOT EXISTS idx_data_export_user_id ON data_export_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_data_export_status ON data_export_requests(status);

-- System configuration table
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value_encrypted TEXT NOT NULL, -- Encrypted value
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default system configurations
INSERT OR IGNORE INTO system_config (key, value_encrypted, description) VALUES 
('max_trips_per_user', 'eyJ2YWx1ZSI6IjEwIn0=', 'Maximum active trips per user'),
('rate_limit_window_minutes', 'eyJ2YWx1ZSI6IjEifQ==', 'Rate limit window in minutes'),
('rate_limit_max_requests', 'eyJ2YWx1ZSI6IjEwMCJ9', 'Maximum requests per window'),
('session_duration_hours', 'eyJ2YWx1ZSI6IjI0In0=', 'Session duration in hours'),
('mfa_backup_codes_count', 'eyJ2YWx1ZSI6IjEwIn0=', 'Number of MFA backup codes'),
('data_retention_days', 'eyJ2YWx1ZSI6IjM2NSJ9', 'Data retention period in days');