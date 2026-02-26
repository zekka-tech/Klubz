#!/usr/bin/env bash
# =============================================================================
# Klubz — Staging Provider Validation Script
#
# Usage:
#   ./scripts/validate-staging-providers.sh [STAGING_URL] [ADMIN_TOKEN]
#
# Arguments:
#   STAGING_URL   Base URL of the staging deployment
#                 Default: https://klubz-staging.pages.dev
#   ADMIN_TOKEN   Optional: JWT access token for an admin account
#                 Required for provider configuration check
#
# Exit codes:
#   0  All required checks passed
#   1  One or more checks failed
# =============================================================================

set -euo pipefail

STAGING_URL="${1:-https://klubz-staging.pages.dev}"
ADMIN_TOKEN="${2:-}"

PASS=0
FAIL=1
TOTAL_CHECKS=0
FAILED_CHECKS=0

# ── Colour helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'
  BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi

check_pass() { echo -e "${GREEN}  ✓${RESET}  $1"; }
check_fail() { echo -e "${RED}  ✗${RESET}  $1"; ((FAILED_CHECKS++)) || true; }
check_warn() { echo -e "${YELLOW}  !${RESET}  $1"; }
section()    { echo -e "\n${BOLD}$1${RESET}"; }

run_check() {
  local label="$1"; shift
  ((TOTAL_CHECKS++)) || true
  if "$@" &>/dev/null; then
    check_pass "$label"
    return $PASS
  else
    check_fail "$label"
    return $FAIL
  fi
}

# ── Helper: HTTP status code ──────────────────────────────────────────────────
http_status() {
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Accept: application/json" \
    "${@}"
}

# ── Helper: JSON field present ────────────────────────────────────────────────
json_field_eq() {
  local url="$1" field="$2" expected="$3"
  local body
  body=$(curl -s -H "Accept: application/json" "$url")
  echo "$body" | grep -q "\"${field}\":\"${expected}\""
}

# =============================================================================
echo -e "${BOLD}Klubz Staging Provider Validation${RESET}"
echo "  Target: ${STAGING_URL}"
echo "  Date  : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ── 1. Connectivity ───────────────────────────────────────────────────────────
section "1. Network connectivity"

((TOTAL_CHECKS++)) || true
STATUS=$(http_status "${STAGING_URL}/health" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
  check_pass "/health → 200 OK"
else
  check_fail "/health → expected 200, got ${STATUS}"
fi

# Verify health body contains 'healthy'
((TOTAL_CHECKS++)) || true
HEALTH_BODY=$(curl -s "${STAGING_URL}/health" 2>/dev/null || echo "")
if echo "$HEALTH_BODY" | grep -q '"status":"healthy"'; then
  check_pass "/health body status=healthy"
else
  check_fail "/health body status != healthy  (body: ${HEALTH_BODY:0:120})"
fi

# Verify DB is bound
((TOTAL_CHECKS++)) || true
if echo "$HEALTH_BODY" | grep -q '"database":"healthy"'; then
  check_pass "/health database=healthy"
else
  check_fail "/health database binding not healthy  (body: ${HEALTH_BODY:0:120})"
fi

# ── 2. Static assets ─────────────────────────────────────────────────────────
section "2. Static assets"

for ASSET in "/static/style.css" "/static/js/app.js" "/manifest.json"; do
  ((TOTAL_CHECKS++)) || true
  S=$(http_status "${STAGING_URL}${ASSET}" 2>/dev/null || echo "000")
  if [ "$S" = "200" ]; then
    check_pass "${ASSET} → 200"
  else
    check_fail "${ASSET} → expected 200, got ${S}"
  fi
done

# ── 3. Auth endpoints (unauthenticated shape checks) ─────────────────────────
section "3. Auth endpoint shapes"

((TOTAL_CHECKS++)) || true
REGISTER_STATUS=$(http_status -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "${STAGING_URL}/api/auth/register" 2>/dev/null || echo "000")
if [ "$REGISTER_STATUS" = "400" ] || [ "$REGISTER_STATUS" = "422" ]; then
  check_pass "POST /api/auth/register → ${REGISTER_STATUS} (rejects empty body)"
else
  check_fail "POST /api/auth/register → unexpected ${REGISTER_STATUS}"
fi

((TOTAL_CHECKS++)) || true
LOGIN_STATUS=$(http_status -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "${STAGING_URL}/api/auth/login" 2>/dev/null || echo "000")
if [ "$LOGIN_STATUS" = "400" ] || [ "$LOGIN_STATUS" = "422" ]; then
  check_pass "POST /api/auth/login → ${LOGIN_STATUS} (rejects empty body)"
else
  check_fail "POST /api/auth/login → unexpected ${LOGIN_STATUS}"
fi

((TOTAL_CHECKS++)) || true
GOOGLE_STATUS=$(http_status "${STAGING_URL}/api/auth/google" 2>/dev/null || echo "000")
if [ "$GOOGLE_STATUS" = "302" ] || [ "$GOOGLE_STATUS" = "503" ] || [ "$GOOGLE_STATUS" = "400" ]; then
  if [ "$GOOGLE_STATUS" = "302" ]; then
    check_pass "GET /api/auth/google → 302 (Google OAuth configured)"
  else
    check_warn "GET /api/auth/google → ${GOOGLE_STATUS} (OAuth not yet configured — expected after secret setup)"
    ((TOTAL_CHECKS--)) || true   # don't count optional as failure
  fi
else
  check_fail "GET /api/auth/google → unexpected ${GOOGLE_STATUS}"
fi

# ── 4. Monitoring endpoints ───────────────────────────────────────────────────
section "4. Monitoring endpoints"

((TOTAL_CHECKS++)) || true
MON_STATUS=$(http_status "${STAGING_URL}/api/monitoring/sla" \
  -H "Authorization: Bearer ${ADMIN_TOKEN:-invalid}" 2>/dev/null || echo "000")
if [ "$MON_STATUS" = "200" ] || [ "$MON_STATUS" = "401" ] || [ "$MON_STATUS" = "403" ]; then
  check_pass "GET /api/monitoring/sla → ${MON_STATUS} (endpoint exists)"
else
  check_fail "GET /api/monitoring/sla → unexpected ${MON_STATUS}"
fi

# ── 5. Provider configuration (requires admin token) ─────────────────────────
section "5. Provider configuration"

if [ -z "$ADMIN_TOKEN" ]; then
  check_warn "No ADMIN_TOKEN supplied — skipping provider config check"
  check_warn "To enable: obtain a JWT for an admin user, then re-run:"
  check_warn "  $0 ${STAGING_URL} <admin_token>"
else
  ((TOTAL_CHECKS++)) || true
  PROVIDERS_BODY=$(curl -s \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${STAGING_URL}/api/monitoring/providers" 2>/dev/null || echo "")

  if echo "$PROVIDERS_BODY" | grep -q '"ready":true'; then
    check_pass "All required providers configured (ready=true)"
  elif echo "$PROVIDERS_BODY" | grep -q '"ready":false'; then
    check_fail "Required providers missing (ready=false)  body: ${PROVIDERS_BODY:0:300}"
  else
    check_fail "Could not reach /api/monitoring/providers  (body: ${PROVIDERS_BODY:0:120})"
  fi

  # Individual provider checks
  for PROVIDER in "jwtSecret" "encryptionKey" "appUrl"; do
    ((TOTAL_CHECKS++)) || true
    if echo "$PROVIDERS_BODY" | grep -qP "\"${PROVIDER}\":\\{\"configured\":true"; then
      check_pass "core.${PROVIDER} configured"
    else
      check_fail "core.${PROVIDER} NOT configured"
    fi
  done

  for PROVIDER in "stripe.secretKey" "stripe.webhookSecret" "sendgrid.apiKey" \
                  "twilio.accountSid" "mapbox.accessToken" "google.clientId"; do
    KEY="${PROVIDER##*.}"
    if echo "$PROVIDERS_BODY" | grep -q "\"${KEY}\":{\"configured\":true"; then
      check_pass "${PROVIDER} configured"
    else
      check_warn "${PROVIDER} not configured (optional — set when enabling this integration)"
    fi
  done
fi

# ── 6. Rate limiting ──────────────────────────────────────────────────────────
section "6. Rate-limit headers present"

((TOTAL_CHECKS++)) || true
HEADERS=$(curl -s -D - -o /dev/null \
  -H "Content-Type: application/json" \
  -d '{"email":"x","password":"y"}' \
  -X POST "${STAGING_URL}/api/auth/login" 2>/dev/null || echo "")
if echo "$HEADERS" | grep -qi "x-ratelimit\|ratelimit\|retry-after"; then
  check_pass "Rate-limit response headers present on auth endpoints"
else
  check_warn "No rate-limit headers detected (may not be surfaced on 400 responses)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
PASSED_CHECKS=$((TOTAL_CHECKS - FAILED_CHECKS))
if [ "$FAILED_CHECKS" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All ${TOTAL_CHECKS} checks passed${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAILED_CHECKS}/${TOTAL_CHECKS} checks failed${RESET} (${PASSED_CHECKS} passed)"
  exit 1
fi
