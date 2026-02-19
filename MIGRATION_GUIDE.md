# Database Migration Guide

This guide covers migration policy, execution, verification, and recovery.

## 1. Migration Policy

Filename format:
- `NNNN_description.sql` (e.g. `0011_add_feature_x.sql`)

Ordering and determinism:
- Numeric prefixes must be contiguous from `0001` and unique.
- Duplicate prefixes are no longer permitted; renumber any legacy duplicates before introducing new migrations.
- New migrations must use the next unique version (currently `0011_*`).

Policy check:

```bash
npm run db:check-migrations
```

## 2. Current Migration Set

- `0001_initial_schema.sql`
- `0002_sample_data.sql`
- `0003_add_payment_fields.sql`
- `0004_performance_indexes.sql`
- `0005_notifications.sql`
- `0006_user_preferences.sql`
- `0007_webhook_event_replay.sql`
- `0008_idempotency_records.sql`
- `0009_add_trip_participant_passenger_count.sql`
- `0010_smart_matching.sql` (renamed from `0003_smart_matching.sql` to enforce prefix uniqueness)

Expected next unique version: `0011_*`

Migration order matches the numeric prefixes above, so the renamed smart matching migration now executes after the passenger-count upgrade instead of sharing the `0003` slot.

## 3. Apply Migrations (Local)

```bash
npm run db:migrate:local
```

Deep smoke verification:

```bash
npm run db:smoke
```

The smoke script validates core tables/indexes including:
- `trip_participants`
- `sessions`
- `notifications`
- `user_preferences`
- critical indexes (`idx_sessions_refresh_token`, `idx_notifications_user_status`, etc.)

## 4. Apply Migrations (Remote)

List pending:

```bash
wrangler d1 migrations list klubz-db-prod --remote
```

Apply:

```bash
wrangler d1 migrations apply klubz-db-prod --remote
```

Verify schema/index sample:

```bash
wrangler d1 execute klubz-db-prod --remote --command "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name LIMIT 20"
```

## 5. Release Sequence with Migrations

1. `npm run db:check-migrations`
2. `npm run type-check && npm run lint && npm test && npm run build`
3. Apply migrations to staging/prod as appropriate
4. Deploy app code
5. Run post-deploy health and critical-path checks

## 6. Failure Handling

If migration application fails:
1. Stop rollout.
2. Capture exact failing migration and error output.
3. Fix forward with a new migration version whenever possible.
4. Only perform down-migrations with explicit approval and backup awareness.

## 7. Common Issues

Authentication issues:
- run `wrangler login` or set `CLOUDFLARE_API_TOKEN`

Missing DB binding:
- confirm DB name/id in Wrangler config

Filename/order violations:
- run `npm run db:check-migrations` and correct prefix/format before merge

## 8. Related Documents

- `DEPLOYMENT.md`
- `docs/OPERATIONS_RUNBOOK.md`
- `codex.md`
