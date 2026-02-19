#!/usr/bin/env bash
set -euo pipefail

# Keep Wrangler state and logs inside workspace for CI/sandbox friendliness.
WORKDIR="$(pwd)"
export HOME="${WORKDIR}/.tmp/wrangler-home"
export XDG_CONFIG_HOME="${WORKDIR}/.tmp/wrangler-config"
mkdir -p "$HOME" "$XDG_CONFIG_HOME"

DB_NAME="${1:-klubz-db-prod}"

echo "Running local D1 migration smoke for ${DB_NAME}..."
wrangler d1 migrations apply "$DB_NAME" --local

echo "Verifying critical schema after migrations..."
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(trip_participants);"
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(sessions);"
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(notifications);"
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(user_preferences);"
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(processed_webhook_events);"
wrangler d1 execute "$DB_NAME" --local --command "PRAGMA table_info(idempotency_records);"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_refresh_token';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_user_status';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_type';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user_preferences_user_id';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_processed_webhook_events_processed_at';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_idempotency_records_created_at';"

echo "Migration smoke check passed."
