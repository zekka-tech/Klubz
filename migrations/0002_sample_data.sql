-- Sample data for testing and development
-- This data is encrypted and compliant with POPIA/GDPR

-- Sample users (passwords are "Test123!" hashed)
INSERT OR IGNORE INTO users (
  email, email_hash, password_hash, first_name_encrypted, last_name_encrypted, 
  phone_encrypted, role, is_active, email_verified, mfa_enabled
) VALUES 
('admin@klubz.com', 'sha256:' || lower(hex(randomblob(32))), '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Admin', 'User', '+1234567890', 'admin', TRUE, TRUE, TRUE),
('john@example.com', 'sha256:' || lower(hex(randomblob(32))), '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'John', 'Doe', '+1234567891', 'user', TRUE, TRUE, FALSE),
('jane@example.com', 'sha256:' || lower(hex(randomblob(32))), '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Jane', 'Smith', '+1234567892', 'user', TRUE, TRUE, FALSE),
('bob@example.com', 'sha256:' || lower(hex(randomblob(32))), '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Bob', 'Johnson', '+1234567893', 'user', TRUE, TRUE, FALSE);

-- Sample trips
INSERT OR IGNORE INTO trips (
  title, description, origin, destination, origin_hash, destination_hash,
  departure_time, available_seats, total_seats, price_per_seat, currency,
  status, vehicle_type, driver_id
) VALUES 
('Morning Commute - Downtown to Airport', 'Daily commute route with flexible timing', 
 'Downtown Business District', 'International Airport', 'downtown_hash', 'airport_hash',
 datetime('now', '+1 day', '08:00:00'), 3, 4, 15.00, 'USD', 'scheduled', 'sedan', 2),

('Evening Return - Airport to Downtown', 'Return trip after work', 
 'International Airport', 'Downtown Business District', 'airport_hash', 'downtown_hash',
 datetime('now', '+1 day', '18:00:00'), 2, 4, 15.00, 'USD', 'scheduled', 'sedan', 2),

('Weekend Trip - City to Beach', 'Weekend beach getaway', 
 'City Center', 'Beach Resort', 'city_hash', 'beach_hash',
 datetime('now', '+2 days', '09:00:00'), 4, 6, 25.00, 'USD', 'scheduled', 'suv', 3),

('Business Trip - Office to Client', 'Business meeting transportation', 
 'Corporate Office', 'Client Location', 'office_hash', 'client_hash',
 datetime('now', '+3 days', '14:00:00'), 1, 2, 20.00, 'USD', 'scheduled', 'sedan', 4);

-- Sample trip participants
INSERT OR IGNORE INTO trip_participants (
  trip_id, user_id, role, status, pickup_location_encrypted, dropoff_location_encrypted
) VALUES 
(1, 2, 'driver', 'accepted', 'Downtown Business District', 'International Airport'),
(1, 3, 'rider', 'accepted', 'Downtown Area 1', 'Airport Terminal'),
(1, 4, 'rider', 'accepted', 'Downtown Area 2', 'Airport Parking'),

(2, 2, 'driver', 'accepted', 'International Airport', 'Downtown Business District'),
(2, 3, 'rider', 'requested', 'Airport Terminal', 'Downtown Area 1'),

(3, 3, 'driver', 'accepted', 'City Center', 'Beach Resort'),
(3, 2, 'rider', 'accepted', 'City North', 'Beach Entrance'),
(3, 4, 'rider', 'accepted', 'City South', 'Beach Parking'),

(4, 4, 'driver', 'accepted', 'Corporate Office', 'Client Location');

-- Sample audit logs
INSERT OR IGNORE INTO audit_logs (
  user_id, action, entity_type, entity_id, old_values_encrypted, new_values_encrypted,
  ip_address, user_agent, session_id
) VALUES 
(1, 'USER_LOGIN', 'user', 1, NULL, '{"last_login_at": "2026-01-23T12:00:00Z"}', '192.168.1.100', 'Mozilla/5.0...', 'session_123'),
(2, 'TRIP_CREATED', 'trip', 1, NULL, '{"title": "Morning Commute", "status": "scheduled"}', '192.168.1.101', 'Mozilla/5.0...', 'session_124'),
(3, 'PARTICIPANT_REQUESTED', 'trip_participant', 2, NULL, '{"trip_id": 1, "user_id": 3, "status": "requested"}', '192.168.1.102', 'Mozilla/5.0...', 'session_125'),
(4, 'USER_UPDATED', 'user', 4, '{"phone": "+1234567890"}', '{"phone": "+1234567899"}', '192.168.1.103', 'Mozilla/5.0...', 'session_126');