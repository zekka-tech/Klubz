#!/usr/bin/env bash
set -euo pipefail

# Routes Codex tasks to a smaller model profile for low-compute operations
# (git status/pull/push/commit, code search, file inspection), and to a
# higher-capability profile for implementation/reasoning-heavy work.
#
# Requires profiles to exist in ~/.codex/config.toml:
#   - fast_ops
#   - deep_work

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is not installed or not in PATH." >&2
  exit 127
fi

has_explicit_model_or_profile=0
for arg in "$@"; do
  case "$arg" in
    -m|--model|-p|--profile)
      has_explicit_model_or_profile=1
      break
      ;;
  esac
done

if [[ "$has_explicit_model_or_profile" -eq 1 ]]; then
  exec codex "$@"
fi

if [[ -n "${CODEX_PROFILE_FORCE:-}" ]]; then
  if [[ "${CODEX_ROUTE_DEBUG:-0}" == "1" ]]; then
    echo "[codex-route] forced profile=${CODEX_PROFILE_FORCE}" >&2
  fi
  exec codex -p "${CODEX_PROFILE_FORCE}" "$@"
fi

joined_args="$*"
lowered_args="$(printf '%s' "$joined_args" | tr '[:upper:]' '[:lower:]')"

if [[ "$lowered_args" =~ (^|[[:space:]])(git[[:space:]]+(status|pull|push|commit|log|show|diff|branch)|rg([[:space:]]|$)|grep([[:space:]]|$)|find([[:space:]]|$)|ls([[:space:]]|$)|cat([[:space:]]|$)|sed([[:space:]]|$)|head([[:space:]]|$)|tail([[:space:]]|$)|wc([[:space:]]|$)|search[[:space:]]+codebase|scan[[:space:]]+repo|read[[:space:]]+files) ]]; then
  if [[ "${CODEX_ROUTE_DEBUG:-0}" == "1" ]]; then
    echo "[codex-route] profile=fast_ops" >&2
  fi
  exec codex -p fast_ops "$@"
fi

if [[ "${CODEX_ROUTE_DEBUG:-0}" == "1" ]]; then
  echo "[codex-route] profile=deep_work" >&2
fi
exec codex -p deep_work "$@"
