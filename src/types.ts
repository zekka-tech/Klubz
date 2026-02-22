/**
 * Klubz - Shared Type Definitions
 *
 * Central type registry for the entire application.
 * All route files, middleware, and services import from here.
 */

// ---------------------------------------------------------------------------
// Cloudflare Bindings (matches wrangler.toml)
// ---------------------------------------------------------------------------

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface KVNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  get(key: string, options?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** Cloudflare Worker environment bindings */
export interface Bindings {
  // Database
  DB: D1Database;

  // KV Namespaces
  CACHE: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  SESSIONS: KVNamespace;

  // Secrets (configured via wrangler secret put)
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  SENDGRID_API_KEY: string;
  MAPBOX_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // Environment variables
  ENVIRONMENT: string;
  APP_URL: string;
  API_VERSION: string;
}

// ---------------------------------------------------------------------------
// Authenticated User (set via context after JWT verification)
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'user' | 'admin' | 'super_admin';
  organizationId?: string;
}

// ---------------------------------------------------------------------------
// Hono App Type (used by all route files)
// ---------------------------------------------------------------------------

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: AuthUser;
    requestId: string;
    cspNonce?: string;
  };
};

// ---------------------------------------------------------------------------
// JWT Payload
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: number;       // user.id
  email: string;
  name: string;
  role: string;
  orgId?: string;
  iat: number;       // issued at (unix seconds)
  exp: number;       // expires at (unix seconds)
  type: 'access' | 'refresh';
}

// ---------------------------------------------------------------------------
// Database Row Types
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  email_hash: string;
  password_hash: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  phone_encrypted: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin' | 'super_admin';
  is_active: number; // SQLite boolean
  email_verified: number;
  phone_verified: number;
  mfa_enabled: number;
  mfa_secret_encrypted: string | null;
  backup_codes_encrypted: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
  created_ip: string | null;
  updated_ip: string | null;
}

export interface TripRow {
  id: number;
  title: string;
  description: string | null;
  origin: string;
  destination: string;
  origin_hash: string;
  destination_hash: string;
  departure_time: string;
  arrival_time: string | null;
  available_seats: number;
  total_seats: number;
  price_per_seat: number;
  currency: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  vehicle_type: string;
  vehicle_model_encrypted: string | null;
  vehicle_plate_encrypted: string | null;
  driver_id: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  trip_type: string;
  route_distance_km: number | null;
  rate_per_km: number | null;
}

export interface TripParticipantRow {
  id: number;
  trip_id: number;
  user_id: number;
  role: 'driver' | 'rider';
  status: 'requested' | 'accepted' | 'rejected' | 'completed' | 'cancelled';
  pickup_location_encrypted: string | null;
  pickup_location_hash: string | null;
  dropoff_location_encrypted: string | null;
  dropoff_location_hash: string | null;
  requested_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  passenger_count: number | null;
  rating: number | null;
  review_encrypted: string | null;
  subscription_id: number | null;
  scheduled_day_id: number | null;
  fare_rate_per_km: number | null;
}

export interface AuditLogRow {
  id: number;
  user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  old_values_encrypted: string | null;
  new_values_encrypted: string | null;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_accessed_at: string;
  is_active: number;
}

// ---------------------------------------------------------------------------
// API Request / Response Types
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  status: number;
  requestId?: string;
  timestamp: string;
  details?: unknown;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ---------------------------------------------------------------------------
// Payment Types
// ---------------------------------------------------------------------------

export interface PaymentIntent {
  id: string;
  tripId: number;
  userId: number;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded';
  stripePaymentIntentId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'in_app' | 'email' | 'sms' | 'push';

export interface Notification {
  id: number;
  userId: number;
  channel: NotificationChannel;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  sentAt?: string;
  readAt?: string;
}

// ---------------------------------------------------------------------------
// Geocoding Types
// ---------------------------------------------------------------------------

export interface GeocodingResult {
  lat: number;
  lng: number;
  address: string;
  placeId?: string;
  confidence: number;
}

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  polyline: string;         // encoded polyline
  waypoints: Array<{ lat: number; lng: number }>;
}

// ---------------------------------------------------------------------------
// Monthly Subscription Types
// ---------------------------------------------------------------------------

export type TripType = 'daily' | 'monthly';

export interface MonthlySubscriptionRow {
  id: number;
  user_id: number;
  subscription_month: string;
  recurring_weekdays: string;         // JSON
  default_morning_departure: string;
  default_evening_departure: string | null;
  default_pickup_lat: number | null;
  default_pickup_lng: number | null;
  default_dropoff_lat: number | null;
  default_dropoff_lng: number | null;
  default_pickup_encrypted: string | null;
  default_dropoff_encrypted: string | null;
  estimated_km_per_month: number;
  estimated_amount_cents: number;
  estimated_days: number;
  stripe_payment_intent_id: string | null;
  payment_status: 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';
  payment_completed_at: string | null;
  status: 'pending_payment' | 'active' | 'cancelled' | 'expired';
  created_at: string;
  updated_at: string;
}

export interface ScheduledDayRow {
  id: number;
  subscription_id: number;
  user_id: number;
  trip_date: string;
  trip_type: 'morning' | 'evening';
  departure_time: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_encrypted: string | null;
  dropoff_encrypted: string | null;
  is_destination_change: number;
  estimated_km: number | null;
  status: 'scheduled' | 'requested' | 'matched' | 'completed' | 'cancelled' | 'skipped';
  trip_id: number | null;
  participant_id: number | null;
  created_at: string;
  updated_at: string;
}
