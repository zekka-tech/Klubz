# Staging Provider Runbook

Covers the complete process for configuring live external-provider secrets on
`klubz-staging` and validating each integration end-to-end.

Execute this runbook:
- After first-time staging deployment
- After rotating secrets
- Before every production promotion

---

## 0. Prerequisites

| Requirement | Check |
|---|---|
| `wrangler` CLI authenticated | `wrangler whoami` |
| Cloudflare account access | Pages project `klubz-staging` visible |
| Provider developer accounts active | Stripe, SendGrid, Twilio, Mapbox, Google Cloud |
| Staging deployed and healthy | `curl https://klubz-staging.pages.dev/health` → `status:healthy` |

---

## 1. Core Secrets (Required — App Fails Closed Without These)

### 1.1 JWT_SECRET

```bash
openssl rand -hex 32 | wrangler pages secret put JWT_SECRET \
  --project-name=klubz-staging
```

**Verification:** `GET /health` returns `200 { "status": "healthy" }`.
A missing or short JWT_SECRET causes all requests to fail with `CONFIGURATION_ERROR`.

### 1.2 ENCRYPTION_KEY

```bash
openssl rand -hex 32 | wrangler pages secret put ENCRYPTION_KEY \
  --project-name=klubz-staging
```

> **Warning:** If the staging database already contains encrypted PII, changing
> this key breaks decryption of existing records. Use a fresh DB or
> re-encrypt before rotating.

---

## 2. Stripe (Payments)

### 2.1 Set secrets

Use **test-mode keys** (`sk_test_...`, `whsec_...`) for staging.

```bash
wrangler pages secret put STRIPE_SECRET_KEY \
  --project-name=klubz-staging
# Paste: sk_test_...

wrangler pages secret put STRIPE_WEBHOOK_SECRET \
  --project-name=klubz-staging
# Paste: whsec_...
```

### 2.2 Configure webhook endpoint in Stripe Dashboard

1. Go to **Developers → Webhooks → Add endpoint**
2. URL: `https://klubz-staging.pages.dev/api/payments/webhook`
3. Events to listen for:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`

### 2.3 Validate

```bash
# 1. Register + log in → obtain access token
# 2. Create a payment intent (tripId must exist in staging DB)
curl -s -X POST https://klubz-staging.pages.dev/api/payments/intent \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tripId": 1, "amount": 5000}' \
  | jq '.clientSecret'
# Expected: "pi_xxx_secret_yyy"

# 3. Trigger a test webhook event via Stripe CLI
stripe trigger payment_intent.succeeded \
  --stripe-account <staging-account-id> \
  --override payment_intent:metadata.tripId=1
# Expected: /api/payments/webhook → 200

# 4. Confirm trip_participants.payment_status updated
#    (via GET /api/trips/:id as the driver)
```

---

## 3. SendGrid (Email Notifications)

### 3.1 Set secret

```bash
wrangler pages secret put SENDGRID_API_KEY \
  --project-name=klubz-staging
# Paste: SG....
```

### 3.2 Validate

```bash
# Register a new user on staging — a verification email is dispatched
curl -s -X POST https://klubz-staging.pages.dev/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "qa-test@yourdomain.com",
    "password": "TestPassword123!",
    "firstName": "QA",
    "lastName": "Test",
    "role": "passenger"
  }' | jq .
```

**Expected:** Verification email arrives in the inbox with a link containing
`/api/auth/verify-email?token=...`.

If the email does not arrive within 2 minutes:
1. Check SendGrid **Activity Feed** for delivery status
2. Verify the sending domain is authenticated (Settings → Sender Authentication)
3. Check audit_logs table: `action = 'USER_REGISTERED'`

---

## 4. Twilio (SMS Notifications)

### 4.1 Set secrets

```bash
wrangler pages secret put TWILIO_ACCOUNT_SID \
  --project-name=klubz-staging
# Paste: ACxxxxxxxx

wrangler pages secret put TWILIO_AUTH_TOKEN \
  --project-name=klubz-staging
# Paste: <auth token>

wrangler pages secret put TWILIO_PHONE_NUMBER \
  --project-name=klubz-staging
# Paste: +1xxxxxxxxxx  (E.164 format)
```

> Use a Twilio trial number for staging. Trial accounts can only send to
> verified numbers. Add your test phone number under **Verified Caller IDs**.

### 4.2 Validate

SMS notifications fire on booking confirmation. To trigger:

1. Offer a trip (driver account)
2. Book the trip (rider account with phone number set in profile)
3. Driver accepts the booking

**Expected:** Rider receives SMS "Your booking for trip #X has been confirmed."

If the SMS does not arrive:
1. Check **Twilio Console → Monitor → Logs**
2. Verify the destination number is verified (trial account limitation)
3. Check that `phone_encrypted` is set on the rider profile

---

## 5. Mapbox (Geocoding & Routing)

### 5.1 Set secret

```bash
wrangler pages secret put MAPBOX_ACCESS_TOKEN \
  --project-name=klubz-staging
# Paste: pk.eyJ1...
```

### 5.2 Validate

```bash
# Offer a trip with a text address (the backend geocodes it via GeoService)
curl -s -X POST https://klubz-staging.pages.dev/api/trips/offer \
  -H "Authorization: Bearer <driver-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "pickupLocation": "Sandton City, Sandton",
    "dropoffLocation": "Rosebank Mall, Johannesburg",
    "scheduledTime": "2026-03-01T07:00:00.000Z",
    "availableSeats": 3,
    "vehicleInfo": "Toyota Corolla, ABC 123 GP"
  }' | jq '{id, status, pickupLocation, fare}'
```

**Expected:** Trip created with computed `fareDaily`, `fareMonthly`,
`etaMinutes`, and numeric `pickup_lat`/`pickup_lng` stored in the DB.

If geocoding fails, the trip is still created but coordinates will be `null`.
Check `MAPBOX_ACCESS_TOKEN` is a public token with `geocoding` scope enabled.

---

## 6. Google OAuth (Sign In with Google)

### 6.1 Configure Google Cloud Console

1. [Open OAuth credentials](https://console.cloud.google.com/apis/credentials)
2. Edit the **Web application** OAuth client
3. Add Authorised redirect URI:
   `https://klubz-staging.pages.dev/api/auth/google/callback`
4. Save and copy **Client ID** and **Client Secret**

### 6.2 Set secrets

```bash
wrangler pages secret put GOOGLE_CLIENT_ID \
  --project-name=klubz-staging
# Paste: xxxxxxxxxx.apps.googleusercontent.com

wrangler pages secret put GOOGLE_CLIENT_SECRET \
  --project-name=klubz-staging
# Paste: GOCSPX-...
```

### 6.3 Validate

```bash
# Initiate OAuth flow — must return a redirect to accounts.google.com
curl -s -o /dev/null -w "%{http_code} %{redirect_url}" \
  https://klubz-staging.pages.dev/api/auth/google
# Expected: 302 https://accounts.google.com/o/oauth2/v2/auth?...
```

Complete the flow in a browser:
1. Open `https://klubz-staging.pages.dev/#login`
2. Click **Continue with Google**
3. Approve consent → redirected to `/?oauth_code=...#login`
4. App exchanges code → access token issued
5. User row created with `oauth_provider='google'`

If the redirect returns `503 Google OAuth not configured`:
Check both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

---

## 7. Web Push (VAPID)

### 7.1 Generate VAPID keys (one-time per environment)

```bash
npx web-push generate-vapid-keys
# Copy the output:
# Public Key:  BM...
# Private Key: x1...
```

### 7.2 Set secrets

```bash
wrangler pages secret put VAPID_PUBLIC_KEY \
  --project-name=klubz-staging
# Paste public key

wrangler pages secret put VAPID_PRIVATE_KEY \
  --project-name=klubz-staging
# Paste private key
```

### 7.3 Validate

1. Open the app on a device/browser that supports push notifications
2. Accept the notification permission prompt
3. Check audit_logs: `action = 'PUSH_SUBSCRIBED'`
4. Trigger a trip reminder (or use the cron endpoint):
   `POST /api/admin/cron/run` with body `{ "task": "hourly" }` (super_admin token required)
5. **Expected:** Push notification received on the device

---

## 7.5 Stripe Connect (Driver Payouts)

Prerequisites: `STRIPE_SECRET_KEY` must be set (Section 2).

1. Register a test driver account and log in.
2. Navigate to **Profile → Payouts → Set Up / Continue**.
3. Verify redirect to Stripe Connect Express onboarding URL.
4. Complete onboarding with Stripe test data.
5. Navigate back to **Profile → Payouts** and confirm status shows **Payouts Ready**.
6. Create and complete a trip with a rider payment.
7. Call `GET /api/payments/connect/status` using the same driver token and verify:
   `chargesEnabled: true`, `payoutsEnabled: true`.
8. Verify transfer appears in Stripe Dashboard → **Payments → Transfers**.

Validation command (driver token required):

```bash
curl -H "Authorization: Bearer $DRIVER_TOKEN" \
  https://klubz-staging.pages.dev/api/payments/connect/status
```

Expected:

```json
{ "connected": true, "chargesEnabled": true, "payoutsEnabled": true }
```

---

## 7.6 Web Push Notifications

1. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (generate with `npx web-push generate-vapid-keys`).
2. Open the app in Chrome/Edge and accept notification permission.
3. Confirm push subscription registration (`POST /api/push/subscribe` in Network tab).
4. Trigger reminders via `POST /api/admin/cron/run` with `{ "task": "hourly" }`.
5. Verify a push notification appears on the test device.

```bash
wrangler pages secret put VAPID_PUBLIC_KEY --project-name=klubz-staging
wrangler pages secret put VAPID_PRIVATE_KEY --project-name=klubz-staging
```

---

## 8. Automated Validation Script

Run the validation script after secrets are set to confirm all checks pass:

```bash
# Basic connectivity and public endpoint checks (no token needed)
./scripts/validate-staging-providers.sh

# Full check including provider config (requires admin JWT)
./scripts/validate-staging-providers.sh \
  https://klubz-staging.pages.dev \
  <admin-access-token>
```

Exit code `0` = all required checks passed.
Exit code `1` = one or more required checks failed.

---

## 9. Secret Rotation Procedure

When rotating a secret (e.g., after a compromise or team change):

```bash
# 1. Generate new value
NEW_SECRET=$(openssl rand -hex 32)

# 2. Set new value
echo "$NEW_SECRET" | wrangler pages secret put <SECRET_NAME> \
  --project-name=klubz-staging

# 3. Trigger a new deployment to pick up the rotated secret
npm run deploy:staging

# 4. Verify health
curl https://klubz-staging.pages.dev/health

# 5. Run validation script
./scripts/validate-staging-providers.sh
```

> Rotating `ENCRYPTION_KEY` requires a data migration. See `docs/ENVIRONMENT.md`.
> Rotating `JWT_SECRET` invalidates all active sessions — users must log in again.

---

## 10. Pre-Production-Promotion Checklist

Before deploying to `klubz-production`, confirm all items below:

- [ ] `GET /health` → `{ "status": "healthy", "services": { "database": "healthy" } }`
- [ ] `GET /api/monitoring/providers` → `{ "ready": true }` (admin token)
- [ ] Email verification flow works end-to-end (SendGrid)
- [ ] Payment intent creation succeeds (Stripe test key)
- [ ] Stripe webhook delivers to staging and updates `payment_status`
- [ ] Google OAuth sign-in completes (if GOOGLE_* secrets set)
- [ ] `npm run test:e2e` passes locally against staging URL (via `BASE_URL` env)
- [ ] `npm run db:check-migrations` reports no issues
- [ ] Staging secrets are **different** from production secrets
- [ ] ENCRYPTION_KEY backup stored in the team password vault
- [ ] All SEV-1/SEV-2 open incidents resolved or accepted

---

## 11. Related Documents

- `docs/ENVIRONMENT.md` — Full list of every environment variable
- `docs/OPERATIONS_RUNBOOK.md` — Incident response and severity classification
- `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md` — Webhook security threat model
- `DEPLOYMENT.md` — Staging → production deployment steps
- `MIGRATION_GUIDE.md` — How to apply and validate DB migrations
