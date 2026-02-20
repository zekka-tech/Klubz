# Phase 1 – Authorization & Idempotency Review

This artifact records how the codebase currently satisfies the Phase 1 requirements in `codex.md` (route-by-route authorization assurance plus idempotency/webhook replay hardening) and calls out the remaining documentation or test gaps.

## Authorization Inventory (per route group)

| Route group | Authorized roles | Guarding mechanism | Verification coverage |
|-------------|------------------|--------------------|------------------------|
| `/api/admin/*` (stats, users, logs, exports) | `admin`, `super_admin` only | `authMiddleware(['admin','super_admin'])` plus route-level `writeAdminAudit` and explicit `admin`/`super_admin` allow-path checks inside `src/routes/admin.ts`. | `tests/integration/route-authz-contracts.test.ts` asserts non-admin rejection, super-admin pass-through, and admin APIs reachable. |
| `/api/monitoring/*` | `admin`, `super_admin` | Same `authMiddleware` chain plus `monitoringRoutes` returning `403` for others. | `route-authz-contracts.test.ts`, plus structured log contracts in `tests/integration/route-authz-contracts.test.ts`. |
| `/api/matching/*` | `admin` scoped to `organizationId`, `super_admin` global | Org scope determined by `authMiddleware` + `MatchingRepository` checks, with `super_admin` override. | `tests/integration/route-authz-contracts.test.ts` exercises admin denial for other org, super-admin override path, and `matchingRoutes` negative cases.
| `/api/users/*`, `/api/trips/*`, `/api/notifications/*` | Authenticated `user` | `authMiddleware(['user'])` plus ownership filters (e.g., user trip listings joined by `user_id`). | `tests/integration/security-hardening.test.ts`, user-route hardening contracts, notification tests.
| `/api/payments/*` (idempotent intents, webhooks) | Authenticated `user` for intents; public for webhooks with verification | `authMiddleware(['user'])` for user flows. Webhooks validate headers/`STRIPE_WEBHOOK_SECRET` and log `CONFIGURATION_ERROR` when missing. | `security-hardening` and `audit-taxonomy` tests cover safe failure modes and audit actions.

## Idempotency & Webhook Replay Hardening

1. **Trip write endpoints** (`src/routes/trips.ts`): each write acquires a key via `getIdempotencyKey` (headers `Idempotency-Key` case-insensitive) scoped per user and operation (`trip-offer`, `trip-book`, `trip-accept`, `trip-reject`, `trip-cancel`). `isIdempotentReplay` consults `idempotency_records` and prevents duplicate state changes; success writes maintain the ledger even if KV backing fails. Tests: `tests/integration/security-hardening.test.ts` (trip offer and booking failure paths) plus the `idempotency_records` migration ensures storage.
2. **Payment intents** (`src/routes/payments.ts`): request-level `getIdempotencyKey` builds `idempotency:payment-intent:${userId}:${tripId}:${requestKey}`. Successful responses are cached in `idempotency_records` with `response_json`. `isIdempotentPaymentIntentResponse` prevents double-charge. Webhook processing also checks `processed_webhook_events` (from migration `0007_webhook_event_replay.sql`) before applying state changes. Tests: `tests/integration/audit-taxonomy-contracts.test.ts` validates webhook event handling and repeated events emit `PAYMENT_*` audit actions.
3. **Webhook secret & configuration guards**: `src/index.tsx` enforces `JWT_SECRET` length and `ENCRYPTION_KEY` format before allowing production routes to run. Logs surface `CONFIGURATION_ERROR` when secrets are missing, so failure states are handled in `security-hardening` tests.

## Remaining Work / Action Items

- [x] **Route audit table completion**: Added specialized endpoint notes below (admin exports, monitoring metrics, matching find/pool) and tied each to `tests/integration/security-hardening.test.ts` coverage showing the required enforcement contracts.
- [x] **Webhook metadata idempotency contracts**: Captured the payment webhook event guard matrix (succeeded/failed/canceled), the replay ledger strategy, and the tests that exercise missing bookings/metadata along with the structured logs they emit.
- [x] **Secret-handling checklist**: The appendix below lists every sensitive binding from `src/types.ts` and links to the runtime guards in `src/index.tsx`/`src/middleware/auth.ts` that ensure they are validated before use.

## Specialized Endpoint Notes

- **`/api/admin/users/:userId/export` (GDPR export)** – Runs inside `adminRoutes`, which unconditionally uses `authMiddleware(['admin','super_admin'])` before evaluating exports. The handler further looks up the target user, writes a `data_export_requests` record, and wraps the action in `writeAdminAudit` so every export attempt is auditable. `tests/integration/security-hardening.test.ts` now includes contracts showing a non-admin is rejected (`403`/`AUTHORIZATION_ERROR`) and an admin run emits `ADMIN_USER_EXPORT` audit metadata.
- **`/api/monitoring/metrics` (internal metrics dashboard)** – Mounted under `monitoringRoutes`, it enforces `authMiddleware(['admin','super_admin'])`, and guards are backed by audit writes (`ADMIN_MONITORING_METRICS_VIEWED`). The route already heals when the stats queries fail by logging (`Admin metrics DB error`) and returning zeroed payloads; the new reliability test checks that a D1 failure surfaces an `INTERNAL_ERROR` response/log line so any regression in this fail-closed contract is caught.
- **`/api/matching/find-pool` (pool optimization)** – All matching routes share `authMiddleware()` and per-request ownership checks (org scoping + role guard). The new integration contract explicitly hits `/api/matching/find-pool` without a token to prove it returns `401` and spawns the expected `AUTHENTICATION_ERROR`, while a valid rider request (with organization data) exercises the in-band matching path with the same guard semantics as `/find`.
- **`/api/maybe-other`** – Use this space to mention any future specialized guards once we identify additional unique paths that deserve focused coverage.

## Webhook Metadata & Idempotency Contracts

- **`payment_intent.succeeded`** – Requires `tripId`, `userId`, `bookingId` metadata aligned with `trip_participants`; ignores events where the booking lookup fails, the stored `payment_intent_id` diverges, or the metadata numbers do not match the persisted trip/user. `tests/integration/security-hardening.test.ts` now asserts the `logger.warn` line mentions `eventId`/`bookingId` whenever metadata mismatches or lookups miss, and the handler still returns `received: true`/`ignored: true` so downstream dashboards see the telemetry without mutating state.
- **`payment_intent.payment_failed`** – Idempotent via `processed_webhook_events` + the `processed_webhook_events` D1 table; a missing booking is logged but ignored, while DB writes that fail bubble up as `PAYMENT_WEBHOOK_ERROR` so the unhandled error contract (`console.error` with `type:unhandled`, `code:PAYMENT_WEBHOOK_ERROR`, `requestId`) is satisfied.
- **`payment_intent.canceled`** – Shares the same metadata guard and replay ledger, with tests demonstrating the canonical logging when `payment_intent_id` mismatches and when `processed_webhook_events` is unavailable (the DB ledger still prevents double-mutation, so `replay: true` is emitted even without KV).
- **Replay persistence** – The `processed_webhook_events` ledger and `idempotency_records` tables are exercised under KV outages (new test for cache failure + DB fallback), ensuring `IDEMPOTENCY_REPLAY` responses still surface and we never double-process events.

## Secret-handling Checklist

Secrets defined in `src/types.ts` / the Cloudflare bindings (and referenced throughout the codebase):

- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `SENDGRID_API_KEY`
- `MAPBOX_ACCESS_TOKEN`

Runtime guards that ensure these secrets reach our code only when valid:

- `src/index.tsx` inspects `JWT_SECRET`, `ENCRYPTION_KEY`, and `APP_URL` pre-flight; any invalid/absent production configuration throws `CONFIGURATION_ERROR` before routes run.
- `src/middleware/auth.ts` fails fast with `CONFIGURATION_ERROR` when `JWT_SECRET` is missing or misformatted.
- Payment, notification, and matching routes always guard `STRIPE_*`, Twilio, SendGrid, and Mapbox usages behind runtime checks or feature toggles (`getStripe`, `createNotification`, etc.), so secrets never leak into production when they are absent.

These checkpoints close the last Phase 1 documentation gaps, letting us move on to Phase 2 reliability contracts.

Once these actions are complete (documented + covered by tests), we can check off Phase 1 in `codex.md` and move to Phase 2 reliability work.
