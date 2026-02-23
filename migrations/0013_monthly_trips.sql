-- Pricing columns on trips (system-calculated, replaces driver-set price)
ALTER TABLE trips ADD COLUMN trip_type TEXT NOT NULL DEFAULT 'daily'
  CHECK (trip_type IN ('daily', 'monthly'));
ALTER TABLE trips ADD COLUMN route_distance_km REAL;
ALTER TABLE trips ADD COLUMN rate_per_km REAL;
-- price_per_seat remains but is now written by the backend (route_distance_km * rate_per_km)

-- Monthly subscription plans (must be created BEFORE adding FK references)
CREATE TABLE IF NOT EXISTS monthly_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_month TEXT NOT NULL,       -- YYYY-MM

  -- Schedule
  recurring_weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]', -- JSON ISO weekdays 1=Mon..7=Sun
  default_morning_departure TEXT NOT NULL DEFAULT '07:30', -- HH:MM
  default_evening_departure TEXT,                          -- HH:MM or NULL = one-way only

  -- Default locations (can be overridden per day)
  default_pickup_lat REAL,
  default_pickup_lng REAL,
  default_dropoff_lat REAL,
  default_dropoff_lng REAL,
  default_pickup_encrypted TEXT,
  default_dropoff_encrypted TEXT,

  -- Estimate at creation
  estimated_km_per_month REAL NOT NULL DEFAULT 0,
  estimated_amount_cents INTEGER NOT NULL DEFAULT 0,
  estimated_days INTEGER NOT NULL DEFAULT 0,

  -- Stripe upfront payment
  stripe_payment_intent_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','pending','paid','failed','refunded')),
  payment_completed_at DATETIME,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','active','cancelled','expired')),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, subscription_month)
);

-- Per-day trip slots for monthly subscribers
CREATE TABLE IF NOT EXISTS monthly_scheduled_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES monthly_subscriptions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_date TEXT NOT NULL,              -- YYYY-MM-DD
  trip_type TEXT NOT NULL CHECK (trip_type IN ('morning','evening')),
  departure_time TEXT NOT NULL,         -- HH:MM (may override subscription default)

  -- Location (may differ from subscription default)
  pickup_lat REAL,
  pickup_lng REAL,
  dropoff_lat REAL,
  dropoff_lng REAL,
  pickup_encrypted TEXT,
  dropoff_encrypted TEXT,
  is_destination_change INTEGER NOT NULL DEFAULT 0,  -- 1 if dropoff differs from default

  estimated_km REAL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','requested','matched','completed','cancelled','skipped')),

  -- Linked booking (set when matched)
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  participant_id INTEGER REFERENCES trip_participants(id) ON DELETE SET NULL,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subscription_id, trip_date, trip_type)
);

-- Subscription linkage on trip_participants (must come AFTER monthly_subscriptions and monthly_scheduled_days are created)
ALTER TABLE trip_participants ADD COLUMN subscription_id INTEGER
  REFERENCES monthly_subscriptions(id) ON DELETE SET NULL;
ALTER TABLE trip_participants ADD COLUMN scheduled_day_id INTEGER
  REFERENCES monthly_scheduled_days(id) ON DELETE SET NULL;
ALTER TABLE trip_participants ADD COLUMN fare_rate_per_km REAL;

CREATE INDEX IF NOT EXISTS idx_monthly_subs_user ON monthly_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_monthly_subs_month ON monthly_subscriptions(subscription_month, status);
CREATE INDEX IF NOT EXISTS idx_monthly_days_sub ON monthly_scheduled_days(subscription_id);
CREATE INDEX IF NOT EXISTS idx_monthly_days_user_date ON monthly_scheduled_days(user_id, trip_date, status);
CREATE INDEX IF NOT EXISTS idx_monthly_days_upcoming ON monthly_scheduled_days(trip_date, status)
  WHERE status = 'scheduled';
