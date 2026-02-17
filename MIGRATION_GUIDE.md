# Database Migration Guide

## New Migrations Created

1. **0003_add_payment_fields.sql** - Adds payment tracking to trip_participants
2. **0004_performance_indexes.sql** - Adds 30+ performance indexes
3. **0005_notifications.sql** - Adds notifications table and notification indexes

## Determinism and Safety Notes

- `0004_performance_indexes.sql` now indexes only schema guaranteed by prior migrations.
- Notification indexes were moved into `0005_notifications.sql` together with table creation.
- Session token index uses `sessions.token_hash` (present in base schema).
- Legacy duplicate prefix (`0003_*`) is retained for backward compatibility with already-applied environments.

## Apply Migrations

### Option 1: Local Development Database

```bash
# Create local database (if not exists)
npx wrangler d1 create klubz-production --local

# Apply all migrations locally
npx wrangler d1 migrations apply klubz-production --local

# Smoke test (apply + schema verification)
npm run db:smoke

# Verify migrations
npx wrangler d1 execute klubz-production --local \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### Option 2: Remote Production Database

**Prerequisites:**
- Cloudflare account authenticated
- Database already created in Cloudflare dashboard

```bash
# Set up Cloudflare authentication (choose one):

# Method A: Login interactively
npx wrangler login

# Method B: Set API token
export CLOUDFLARE_API_TOKEN="your-token-here"

# List pending migrations
npx wrangler d1 migrations list klubz-production --remote

# Apply migrations to production
npx wrangler d1 migrations apply klubz-production --remote

# Verify indexes were created
npx wrangler d1 execute klubz-production --remote \
  --command "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY tbl_name LIMIT 10"
```

### Option 3: Via Cloudflare Dashboard

1. Go to https://dash.cloudflare.com/
2. Navigate to Workers & Pages > D1
3. Select your database
4. Go to "Migrations" tab
5. Upload migration files:
   - migrations/0003_add_payment_fields.sql
   - migrations/0004_performance_indexes.sql
   - migrations/0005_notifications.sql
6. Click "Apply Migrations"

## Migration Details

### 0003_add_payment_fields.sql
```sql
-- Adds to trip_participants table:
- payment_intent_id (TEXT) - Stripe payment intent ID
- payment_status (TEXT) - Payment status enum
- payment_completed_at (DATETIME) - Payment completion timestamp

-- Indexes:
- idx_trip_participants_payment_intent
- idx_trip_participants_payment_status
```

### 0004_performance_indexes.sql
```sql
-- 30+ indexes covering:
- Trip searches (status, departure time, location hashes)
- User authentication (email hash)
- Bookings (user_id, trip_id, status combinations)
- Sessions (user_id, expiration, refresh tokens)
- Audit logs (user_id, entity lookups, timestamps)
- Matching engine (bounding boxes, departure times)
```

### 0005_notifications.sql
```sql
-- Adds notifications table with:
- user_id, trip_id references
- notification_type, channel, status lifecycle
- message payload + metadata fields

-- Indexes:
- idx_notifications_user_status
- idx_notifications_type
- idx_notifications_trip
```

## Verification Commands

### Check Applied Migrations
```bash
npx wrangler d1 migrations list klubz-production --remote
```

### Verify Tables
```bash
npx wrangler d1 execute klubz-production --remote \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='trip_participants'"
```

### Verify Indexes
```bash
npx wrangler d1 execute klubz-production --remote \
  --command "SELECT COUNT(*) as index_count FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
```

### Check Payment Fields
```bash
npx wrangler d1 execute klubz-production --remote \
  --command "PRAGMA table_info(trip_participants)"
```

## Rollback (If Needed)

```bash
# Rollback last migration
npx wrangler d1 migrations apply klubz-production --remote --down

# WARNING: This will:
# - Drop payment fields from trip_participants
# - Drop all performance indexes
# - May cause data loss for payment_intent_id and payment_status
```

## Troubleshooting

### "Couldn't find D1 DB"
- Check wrangler.toml has correct database_name
- Verify database exists: `npx wrangler d1 list`
- Update database_id in wrangler.toml if needed

### "Authentication failed"
```bash
# Login again
npx wrangler login

# Or set API token
export CLOUDFLARE_API_TOKEN="your-token"
```

### "Migration already applied"
- Migrations are tracked in d1_migrations table
- Use --force flag to reapply (dangerous):
  `npx wrangler d1 migrations apply klubz-production --remote --force`

## Migration Order

Migrations are applied in order:
1. 0001_initial_schema.sql (existing)
2. 0002_sample_data.sql (existing)
3. 0003_smart_matching.sql (existing)
4. 0003_add_payment_fields.sql (existing)
5. 0004_performance_indexes.sql (existing)
6. 0005_notifications.sql (new)

Note: Multiple files numbered 0003 exist. Wrangler applies them alphabetically.
