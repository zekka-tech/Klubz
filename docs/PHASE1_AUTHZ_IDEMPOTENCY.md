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

- [ ] **Route audit table completion**: The table above covers the major route groups, but there are more specialized endpoints (`/api/admin/metrics`, `/api/matching/pool`, `/api/users/export`, etc.) that need at least a one-sentence guard/middleware note and a targeted test that asserts correct role enforcement. Capture these per-route notes inside this document or extend `tests/integration/route-authz-contracts.test.ts` if missing.
- [ ] **Webhook metadata idempotency contracts**: Ensure every webhook event type consulted by the payment matching logic declares whether it is idempotent, what replay key it uses, and how metadata/booking integrity is asserted. Add integration regression contract(s) if not yet covered.
- [ ] **Secret-handling checklist**: Create a short appendix (linked here or in `docs/SECURITY.md`) listing the secrets in `src/types.ts` and verifying they are only accessed after runtime validation.

Once these actions are complete (documented + covered by tests), we can check off Phase 1 in `codex.md` and move to Phase 2 reliability work.
