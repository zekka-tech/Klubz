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
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_refresh_token';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_user_status';"
wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_type';"

echo "Migration smoke check passed."
