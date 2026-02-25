# Codex Project Ledger - Klubz

Last updated: 2026-02-25 17:58:00 UTC
Current branch: `main`
Tracking branch: `origin/main`

## Purpose
This file is the persistent continuity and operations ledger for this repository.
Before starting work, read this file first.
After any significant action, update this file.

Mandatory updates to this file:
- Every commit
- Every push
- Every pull
- Every migration/script/run action that materially changes project state
- Every major review decision

---

## Current State Snapshot
Quality gate status (latest run):
- `npm run verify`: PASS (`type-check`, `lint`, `test` 278/278, `build` 347.60 kB worker)
- `npm run db:check-migrations`: PASS (18 files, next `0019`)

Repository state:
- Working tree clean after local commits
- `main` ahead of `origin/main` (push pending)

---

## Implemented and Completed
Recent delivery stream (newest first):
1. `66d5409` - Daily & monthly trip types with distance-based pricing: migration 0013 (monthly_subscriptions, monthly_scheduled_days tables + trip_type/route_distance_km/rate_per_km columns); src/lib/pricing.ts (R2.85/km daily, R2.15/km monthly, haversine, ETA); src/routes/subscriptions.ts (full CRUD + calendar + Stripe upfront payment intent); trips.ts updated to compute system fare from coordinates; payments.ts webhook handles subscription payment state; subscription + monthly-calendar screens in app.js; trip cards show fareDaily/fareMonthly/etaMinutes; find-ride has daily/monthly toggle; my-trips shows subscription section.
2. `bb61889` - Route-efficient matching algorithm: added absolute 10 km per-rider detour hard cap (`maxAbsoluteDetourKm: 10` in MatchThresholds, Phase 2 hard filter in engine.ts); replaced pool-detour minute-estimate heuristic with cumulative km budget tracking using cheapest-insertion `computeMarginalDetourKm()` in geo.ts (`maxPoolDetourKm: 10` in MatchConfig); reweighted scoring so detour cost rises to 13% (from 5%) for route-efficiency priority (shiftAlignment ↓ to 2%, timeMatch ↓ to 15%, seatAvailability ↓ to 5%); 9 new matching unit tests (70 total in matching.test.js); all 262 Vitest tests still pass.
3. `(pending)` - Implemented Google OAuth Sign-in with distance-based pricing: migration 0013 (monthly_subscriptions, monthly_scheduled_days tables + trip_type/route_distance_km/rate_per_km columns); src/lib/pricing.ts (R2.85/km daily, R2.15/km monthly, haversine, ETA); src/routes/subscriptions.ts (full CRUD + calendar + Stripe upfront payment intent); trips.ts updated to compute system fare from coordinates; payments.ts webhook handles subscription payment state; subscription + monthly-calendar screens in app.js; trip cards show fareDaily/fareMonthly/etaMinutes; find-ride has daily/monthly toggle; my-trips shows subscription section.
3. `(pending)` - Implemented Google OAuth Sign-in (Authorization Code flow with CSRF state, short-lived code exchange, PII encryption for new users, account linking for existing accounts); added migration 0012 for oauth_provider/oauth_id columns; fixed CSP connect-src to include Nominatim geocoding; documented GOOGLE_CLIENT_ID/SECRET setup in ENVIRONMENT.md.
2. `(pending)` - Fixed Cloudflare Workers compatibility: replaced Node.js Stripe SDK with Workers-native StripeService; fixed broken PII decrypt pattern in trips.ts notifications; added safeDecryptPII for safe migration-path decryption; fixed PII encryption on registration and profile update; added passenger_count to TripParticipantRow; fixed wrangler.toml missing staging/dev KV namespace bindings.
2. `213a812` - Decoupled in-app trip notifications from email/SMS transport availability across booking request/accept/reject and trip cancel flows, ensuring persisted notifications remain preference-driven even when providers are unavailable; added integration enforcement contracts.
2. `be39508` - Fixed trip-cancel notification regression by loading accepted rider recipients before participant status transition to `cancelled`, preserving cancellation notifications while retaining participant cancellation integrity updates; added integration regression contract for execution ordering.
3. `42af5f9` - Added formal payment webhook threat-model artifact (`docs/PAYMENT_WEBHOOK_THREAT_MODEL.md`) and expanded integration abuse-path contracts to assert non-mutation for unknown-booking and payment-intent-mismatch failed/canceled webhook events.
4. `b54a306` - Hardened payment webhook trust boundaries by binding state transitions to canonical `trip_participants.payment_intent_id` + booking context, enforcing metadata-to-booking consistency on success events, and expanding abuse-path integration contracts for spoofed metadata and intent mismatch handling.
5. `cd5bb88` - Consolidated operational documentation to current production standards: replaced stale deployment/migration guidance, added `docs/OPERATIONS_RUNBOOK.md` for incident response and on-call procedures, and introduced standardized verification scripts (`verify`, `verify:ci`).
6. `5f64e92` - Introduced shared query-integer validation helper (`src/lib/validation.ts`) and unified pagination/query integer parsing across admin, matching, and user routes to reduce duplicated validation logic and drift risk while preserving existing contracts.
7. `9b6b1e1` - Expanded admin authorization matrix integration coverage with additional negative-role contracts across admin read/mutation/export subroutes (`/stats`, `/users`, `/users/:id`, `PUT /users/:id`, `POST /users/:id/export`) plus super-admin allow-path pass-through assertions.
8. `2819b2c` - Added route-level observability contract assertions for global error telemetry classification, validating `handled` (`VALIDATION_ERROR`) and `unhandled` (`CONFIGURATION_ERROR`) structured log emissions on representative payment webhook paths.
9. `82a1048` - Added non-critical transition audit persistence for matching confirm/reject and payment webhook succeeded/failed/canceled state transitions, with integration contracts enforcing `MATCH_CONFIRMED`, `MATCH_REJECTED`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, and `PAYMENT_CANCELED`.
10. `e8a818b` - Added dedicated audit taxonomy integration contracts for critical auth/privacy flows, asserting expected audit actions on successful operations: `USER_LOGIN`, `USER_REGISTER`, `USER_LOGOUT`, `DATA_EXPORT`, and `ACCOUNT_DELETED`.

Functional status:
- Application compiles and builds.
- Unit tests pass.
- Lint and type-check pass.
- Route typing quality significantly improved.

---

## Remaining Work to Production-Ready (Prioritized)

### Priority 0 - Critical Risk / Hard Problems
1. End-to-end security hardening and verification:
   - Full authz review per route (role checks, ownership checks, data exposure boundaries).
   - CSP/CORS policy audit against deployment domains.
   - Payment webhook threat model (replay protection, event idempotency, metadata trust boundaries).
   - Secret handling review (runtime-only, no accidental logging, strict env validation).
2. Data and migration integrity:
   - Resolve/normalize migration numbering strategy to prevent ordering ambiguity long term.
   - Add migration smoke validation in CI against clean DB.
3. Reliability controls:
   - Idempotency keys for write-critical endpoints.
   - Transaction/consistency checks for booking/payment state transitions.

### Priority 1 - High Value / High Impact
1. Integration and contract tests:
   - API-level tests for auth, trips lifecycle, booking acceptance/rejection/cancel, payments webhook.
   - Negative-path and abuse-path tests.
2. Observability maturity:
   - Structured event taxonomy and correlation IDs across all modules.
   - Error budget/SLO-oriented metrics with clear dashboards.
3. CI/CD quality gates:
   - Enforce `type-check`, `lint`, `test`, `build` on every PR/push.
   - Add migration verification job.

### Priority 2 - Medium Complexity
1. Remove remaining dynamic typing debt in non-critical areas (if any newly introduced).
2. Improve domain model consistency across modules (shared row interfaces where practical).
3. Expand caching strategy with explicit invalidation contracts and tests.

### Priority 3 - Lower Complexity / Polish
1. Documentation consolidation (ops runbook, incident recovery, onboarding docs).
2. Script ergonomics (`verify`, `verify:ci`, `db:smoke`, `security:check`).
3. Developer DX cleanup and code comments for complex sections.

---

## Sequenced Execution Plan for Dev Team

### Phase 1 - Security + Data Integrity (Critical)
- Complete route-by-route authz matrix.
- Lock webhook and write-path idempotency.
- Standardize migrations and add clean-DB migration CI test.
- Exit criterion: security review sign-off and migration determinism validated.

### Phase 2 - Reliability + Test Expansion
- Add integration tests for primary user and payment flows.
- Add failure-path tests (DB unavailable, webhook replay, invalid tokens).
- Exit criterion: high-risk flows covered by automated tests.

### Phase 3 - Observability + Operations
- Add actionable dashboards and alerting thresholds.
- Improve structured logging metadata consistency.
- Exit criterion: on-call can diagnose and triage from logs/metrics without code spelunking.

### Phase 4 - Hardening and Cleanup
- Tighten remaining type/model inconsistencies.
- Final docs + runbook completion.
- Exit criterion: stable release candidate and production checklist complete.

---

## Action Log
Use this format for every significant action:
- `YYYY-MM-DD HH:MM UTC` | `actor` | `action` | `ref` | `result`

- `2026-02-20 18:45 UTC` | codex | action | phase2-lifecycle-reliability-tests | exercised every `/api/trips` offer/accept/reject/cancel path under KV failure, ensured DB-ledger idempotency responses surface `IDEMPOTENCY_REPLAY`, and verified the monitoring metrics audit test logs the injected `X-Request-ID`.
- `2026-02-25 17:58 UTC` | codex | action | roadmap-p0-p3-implementation | implemented roadmap delivery across backend/frontend: cron matching + reminders, documents R2 upload proxy, disputes/promo/loyalty/organizations routes, ToS acceptance, points hooks, Apple Sign-In OAuth flow, MFA/settings wiring, driver docs + earnings + referral + organization screens, and integration contract coverage.
- `2026-02-25 17:58 UTC` | codex | action | quality-gates | ran `npm run verify` with full pass (`type-check`, `lint`, `test` 278/278, `build` 347.60 kB).
- `2026-02-25 17:58 UTC` | codex | action | db-migration-order-check | ran `npm run db:check-migrations` -> `18 files, 18 unique versions, next 0019`.
- `2026-02-25 17:58 UTC` | codex | commit | `bb5b91d` | delivered production readiness roadmap implementation (P0-P3) across backend/frontend/routes/migrations and integration contract tests.
- `2026-02-20 18:48 UTC` | codex | action | phase2-payment-reliability-tests | extended payments coverage with KV/DB outage simulations (intent cache failure, webhook replay ledger fallback, config error guards) and asserted structured logging carries the same request ID as the HTTP response.
- `2026-02-20 18:53 UTC` | codex | action | docs-phase2-reliability-audit | captured the new lifecycle/payment failure-mode contracts plus the monitoring metrics request-ID reasoning in `docs/PHASE2_RELIABILITY_AUDIT.md`.
- `2026-02-20 19:00 UTC` | codex | action | quality-gates | reran `npm run type-check`, `npm run lint`, `npm test` (200), and `npm run build` to validate the new reliability surface end-to-end.
- `2026-02-20 19:15 UTC` | codex | action | phase2-monitoring-metrics-failure | added `BatchFailingDB` to simulate `/api/monitoring/metrics` batch failures, ensured the handler still returns zeroed metrics, and asserted the `Metrics DB error` log emitted via `withRequestContext` keeps the propagated `X-Request-ID`.
- `2026-02-20 19:17 UTC` | codex | action | docs-phase2-reliability-audit | documented the monitoring metrics failure contract and correlated logging expectations in `docs/PHASE2_RELIABILITY_AUDIT.md`.
- `2026-02-20 19:25 UTC` | codex | action | quality-gates | reran `npm run type-check`, `npm run lint`, `npm test` (205), and `npm run build` after the admin/matching/metrics reliability updates.

- `2026-02-19 15:03 UTC` | codex | action | quality-gates | reran `npm run lint`, `npm run type-check`, `npm test` (193) and `npm run build` after migration renumbering and doc updates
- `2026-02-19 14:53 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (10 files, next 0011) after removing the legacy duplicate migration prefix
- `2026-02-19 14:52 UTC` | codex | action | migration-number-normalization | renamed `migrations/0003_smart_matching.sql` to `0010_smart_matching.sql`, deleted the legacy duplicate prefix allowance, and updated migration sequencing docs for unique prefixes
- `2026-02-19 11:50 UTC` | codex | action | admin-stats-cache-hardening | added KV-backed caching to `/admin/stats`, retained `ADMIN_STATS_VIEWED` audit write, and snapshot the SLA/carbon metrics before caching
- `2026-02-19 11:47 UTC` | codex | action | quality-gates | ran `npm run lint`, `npm run type-check`, and `npm test` (193 tests) after stats cache change
- `2026-02-19 14:36 UTC` | codex | action | quality-gates | ran `npm run verify` (type-check, lint, test 193, build) to validate the cached admin stats change end-to-end
- `2026-02-22 18:55 UTC` | codex | action | daily-monthly-pricing-implementation | added migration 0013 (monthly_subscriptions + monthly_scheduled_days + trip_type/route_distance_km/rate_per_km columns); src/lib/pricing.ts with TRIP_RATES, calculateFareCents, estimateETAMinutes, haversineKm, generateScheduledDates, estimateMonthlyTotal; src/routes/subscriptions.ts with full CRUD + calendar + Stripe upfront payment; updated trips.ts with system-computed fare and subscription-aware booking; updated payments.ts webhook for subscription payment state; added subscription + calendar screens and handlers in app.js; updated renderTripCard, renderMatchResult, renderFindRideScreen, renderMyTripsScreen, handleOfferRide
- `2026-02-22 18:55 UTC` | codex | action | quality-gates | type-check PASS, lint PASS, test 262/262, build PASS (287.71 kB), db:check-migrations PASS (13 files, next 0014)
- `2026-02-22 13:45 UTC` | codex | deploy | production | `npm run deploy:prod` success → https://3919e026.klubz-production.pages.dev; health check OK; migration 0012 already applied (shared D1)
- `2026-02-22 13:30 UTC` | codex | push | `main -> origin/main` | success (`4e30d57`)
- `2026-02-22 13:30 UTC` | codex | deploy | staging | `npm run deploy:staging` success → https://70959099.klubz-staging.pages.dev; migration 0012 applied; health check OK
- `2026-02-22 13:30 UTC` | codex | action | google-oauth-implementation | full Google OAuth Sign-in: GET /api/auth/google, GET /api/auth/google/callback, GET /api/auth/oauth-session; migration 0012 (oauth_provider, oauth_id); frontend wiring; CSP Nominatim fix; docs update
- `2026-02-22 13:30 UTC` | codex | action | quality-gates | type-check PASS, lint PASS, test 250/250, build PASS, db:check-migrations 12 files next 0013
- Latest entries:
- `2026-02-19 15:05 UTC` | codex | action | phase1-authz-idempotency-inventory | documented authorization/idempotency coverage and remaining gaps in `docs/PHASE1_AUTHZ_IDEMPOTENCY.md` to complete Phase 1 material risk review
- `2026-02-19 15:03 UTC` | codex | action | quality-gates | reran `npm run lint`, `npm run type-check`, `npm test` (193) and `npm run build` after migration renumbering and doc updates
- `2026-02-19 14:53 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (10 files, next 0011) after removing the legacy duplicate migration prefix
- `2026-02-19 14:52 UTC` | codex | action | migration-number-normalization | renamed `migrations/0003_smart_matching.sql` to `0010_smart_matching.sql`, deleted the legacy duplicate prefix allowance, and updated migration sequencing docs for unique prefixes
- `2026-02-19 11:50 UTC` | codex | action | admin-stats-cache-hardening | added KV-backed caching to `/admin/stats`, retained `ADMIN_STATS_VIEWED` audit write, and snapshot the SLA/carbon metrics before caching
- `2026-02-19 11:47 UTC` | codex | action | quality-gates | ran `npm run lint`, `npm run type-check`, and `npm test` (193 tests) after stats cache change
- `2026-02-19 14:36 UTC` | codex | action | quality-gates | ran `npm run verify` (type-check, lint, test 193, build) to validate the cached admin stats change end-to-end
- `2026-02-19 15:03 UTC` | codex | action | quality-gates | reran `npm run lint`, `npm run type-check`, `npm test` (193) and `npm run build` after migration renumbering and doc updates
- `2026-02-19 14:53 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (10 files, next 0011) after removing the legacy duplicate migration prefix
- `2026-02-19 14:52 UTC` | codex | action | migration-number-normalization | renamed `migrations/0003_smart_matching.sql` to `0010_smart_matching.sql`, deleted the legacy duplicate prefix allowance, and updated migration sequencing docs for unique prefixes
- `2026-02-19 11:50 UTC` | codex | action | admin-stats-cache-hardening | added KV-backed caching to `/admin/stats`, retained `ADMIN_STATS_VIEWED` audit write, and snapshot the SLA/carbon metrics before caching
- `2026-02-19 11:47 UTC` | codex | action | quality-gates | ran `npm run lint`, `npm run type-check`, and `npm test` (193 tests) after stats cache change
- `2026-02-19 14:36 UTC` | codex | action | quality-gates | ran `npm run verify` (type-check, lint, test 193, build) to validate the cached admin stats change end-to-end
- `2026-02-19 11:03 UTC` | codex | push | `main -> origin/main` | success (`213a812`)
- `2026-02-19 11:03 UTC` | codex | commit | `213a812` | decoupled in-app trip notifications from email/SMS provider availability for booking request/accept/reject and trip cancel flows; added integration enforcement coverage
- `2026-02-19 11:02 UTC` | codex | action | notification-channel-decoupling-hardening | decoupled in-app trip notifications from email/SMS provider availability across booking request/accept/reject and trip cancel flows; provider transports remain conditional while persisted notifications honor user preferences
- `2026-02-19 11:02 UTC` | codex | action | quality-gates | ran `npm run type-check`, targeted `tests/integration/notification-preferences-enforcement.test.ts` (8/8) and `tests/integration/security-hardening.test.ts` (81/81), and full `npm run verify` (`type-check`, `lint`, `test` 187/187, `build`) all passing
- `2026-02-19 10:54 UTC` | codex | push | `main -> origin/main` | success (`be39508`)
- `2026-02-19 10:54 UTC` | codex | commit | `be39508` | fixed trip cancellation notification ordering regression by loading accepted riders before participant cancellation transition; added integration regression contract
- `2026-02-19 10:54 UTC` | codex | action | trip-cancel-notification-order-hardening | fixed trip cancellation flow ordering to capture accepted riders before participant cancellation transition, preserving rider cancellation notifications while keeping participant status integrity updates
- `2026-02-19 10:54 UTC` | codex | action | quality-gates | ran `npm run type-check`, targeted `tests/integration/security-hardening.test.ts` (81/81), and full `npm run verify` (`type-check`, `lint`, `test` 184/184, `build`) all passing
- `2026-02-19 10:46 UTC` | codex | push | `main -> origin/main` | success (`2b3dde6`)
- `2026-02-19 10:46 UTC` | codex | commit | `2b3dde6` | fixed trip offer seat-capacity persistence invariant (`total_seats == available_seats`) and added integration contract coverage
- `2026-02-19 10:46 UTC` | codex | action | quality-gates | ran targeted `tests/integration/security-hardening.test.ts` and full `npm run verify` (`type-check`, `lint`, `test` 183/183, `build`) all passing
- `2026-02-19 10:45 UTC` | codex | action | trip-offer-seat-capacity-consistency-hardening | fixed trip offer persistence to keep `total_seats` equal to offered `available_seats` and added integration contract coverage for seat-capacity invariants
- `2026-02-19 09:49 UTC` | codex | push | `main -> origin/main` | success (`26d4d86`)
- `2026-02-19 09:49 UTC` | codex | commit | `26d4d86` | hardened trip cancellation/account deletion consistency by cancelling rider participant records on trip cancel and scoping account deletion active-trip checks to active rider participation on active trips
- `2026-02-19 09:49 UTC` | codex | action | quality-gates | ran targeted `tests/integration/security-hardening.test.ts` and full `npm run verify` (`type-check`, `lint`, `test` 182/182, `build`) all passing
- `2026-02-19 09:48 UTC` | codex | action | trip-cancellation-participant-state-hardening | cancel flow now marks rider participants `requested|accepted -> cancelled` with `cancelled_at`, and account deletion active-trip detection now scopes to active rider participation joined to active trip states
- `2026-02-19 09:44 UTC` | codex | push | `main -> origin/main` | success (`f95d8cd`)
- `2026-02-19 09:44 UTC` | codex | commit | `f95d8cd` | hardened trip booking/reject/cancel payload validation contracts with strict passenger integer enforcement and reason type/length validation, plus integration coverage
- `2026-02-19 09:44 UTC` | codex | commit | `c4b28a7` | enforced canonical passenger-count persistence and seat decrement integrity on trip booking accept path with migration and integration coverage
- `2026-02-19 09:44 UTC` | codex | action | quality-gates | ran targeted `tests/integration/security-hardening.test.ts` and full `npm run verify` (`type-check`, `lint`, `test` 180/180, `build`) all passing
- `2026-02-19 09:43 UTC` | codex | action | trip-payload-validation-hardening | replaced permissive trip booking/reject/cancel body parsing with strict schema validation, enforced integer `passengers` bounds and constrained optional `reason` payloads
- `2026-02-19 09:39 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (pass), targeted trip/audit/notification suites, and full `npm run verify` (`type-check`, `lint`, `test` 176/176, `build`) all passing
- `2026-02-19 09:37 UTC` | codex | action | trip-passenger-count-integrity-hardening | added migration `0009_add_trip_participant_passenger_count.sql`, persist `passenger_count` on booking creation, and enforce seat decrement/availability checks using canonical booking passenger count on accept path; expanded integration contracts
- `2026-02-19 09:32 UTC` | codex | push | `main -> origin/main` | success (`539891a`)
- `2026-02-19 09:32 UTC` | codex | commit | `539891a` | expanded trip-route fail-closed integration coverage for offer/reject/cancel/rate DB-unavailable and runtime DB-failure contracts
- `2026-02-19 09:31 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (pass), targeted security suite (71/71), and full `npm run verify` (`type-check`, `lint`, `test` 174/174, `build`) all passing
- `2026-02-19 09:29 UTC` | codex | action | trip-fail-closed-contract-expansion | added integration coverage for trip write-path fail-closed contracts across offer/reject/cancel/rate endpoints (DB unavailable + runtime DB failure cases)
- `2026-02-19 08:50 UTC` | codex | push | `main -> origin/main` | success (`0149f05`)
- `2026-02-19 08:49 UTC` | codex | commit | `0149f05` | hardened trip write endpoints to fail closed on missing/failed DB operations and expanded integration contracts for booking DB-unavailable/runtime-failure paths
- `2026-02-19 08:48 UTC` | codex | action | quality-gates | ran `npm run verify` (`type-check`, `lint`, `test` 166/166, `build`) all passing
- `2026-02-19 08:47 UTC` | codex | action | trip-write-fail-closed-hardening | removed false-success fallbacks in trip write endpoints, enforced DB-unavailable fail-closed `CONFIGURATION_ERROR`, and added integration contracts for DB-unavailable and runtime DB-failure paths
- `2026-02-19 06:15 UTC` | codex | push | `main -> origin/main` | success (`d41dce9`)
- `2026-02-19 06:15 UTC` | codex | commit | `d41dce9` | added durable DB-backed idempotency fallback for trip writes and payment intent replay when KV is unavailable, plus migration and integration coverage
- `2026-02-19 06:14 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (pass), targeted security suite (59/59), and full `npm run verify` (`type-check`, `lint`, `test` 162/162, `build`) all passing
- `2026-02-19 06:13 UTC` | codex | action | idempotency-durability-hardening | added durable DB-backed fallback for request idempotency when KV is unavailable across trip write endpoints and payment intent replay (`idempotency_records`), added migration `0008_idempotency_records.sql`, updated db smoke checks, and expanded no-KV replay integration coverage
- `2026-02-19 06:09 UTC` | codex | push | `main -> origin/main` | success (`20a3524`)
- `2026-02-19 06:09 UTC` | codex | commit | `20a3524` | added durable DB-backed Stripe webhook replay ledger fallback + migration and expanded replay contract coverage for no-KV environments
- `2026-02-19 06:08 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (pass), targeted webhook/audit suites (62/62), and full `npm run verify` (`type-check`, `lint`, `test` 160/160, `build`) all passing
- `2026-02-19 06:07 UTC` | codex | action | webhook-replay-durability-hardening | added durable DB-backed Stripe webhook replay ledger fallback (`processed_webhook_events`) when KV replay cache is unavailable, updated webhook replay marker persistence path, added migration `0007_webhook_event_replay.sql`, and expanded replay integration coverage for no-KV environments
- `2026-02-19 06:02 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (159/159), and `build` all passing
- `2026-02-19 06:01 UTC` | codex | action | webhook-replay-reliability-hardening | deferred webhook replay marking until post-successful processing, fail-closed on transient webhook processing DB failures (`PAYMENT_WEBHOOK_ERROR`), and added retry regression contract for same-event-id retries
- `2026-02-19 05:54 UTC` | codex | push | `main -> origin/main` | success (`1722f2d`)
- `2026-02-19 05:54 UTC` | codex | commit | `1722f2d` | expanded CORS allow/expose headers for browser idempotency and rate-limit observability contracts
- `2026-02-19 05:49 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (158/158), and `build` all passing
- `2026-02-19 05:47 UTC` | codex | action | rate-limiter-consolidation-hardening | replaced in-app bespoke API rate limiter with shared `middleware/rateLimiter` (KV-capable, `Retry-After` contract), aligned auth audit user-agent extraction to shared HTTP helper, and added integration rate-limiter contract coverage
- `2026-02-19 05:45 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (156/156), and `build` all passing
- `2026-02-19 05:44 UTC` | codex | action | client-ip-normalization-hardening | centralized client IP extraction/normalization in `lib/http` (header casing, forwarded-chain first-hop, IPv4 port stripping, oversized-header rejection), and wired index/middleware rate-limit, security, and audit logging paths to shared helper with added unit/integration contracts
- `2026-02-19 05:38 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (151/151), and `build` all passing
- `2026-02-19 05:36 UTC` | codex | action | request-id-contract-hardening | centralized request-id validation/propagation in app middleware, reused canonical request ID in error payloads/logs, and added dedicated integration contracts for echo/sanitization/log-correlation behavior
- `2026-02-19 05:32 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (148/148), and `build` all passing
- `2026-02-19 05:31 UTC` | codex | action | production-runtime-config-guard | added fail-closed production runtime config validation (`JWT_SECRET` length, `ENCRYPTION_KEY` format, `APP_URL` URL validity) with integration contracts and CSP/CORS follow-up test alignment
- `2026-02-19 05:23 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (143/143), and `build` all passing
- `2026-02-19 05:22 UTC` | codex | action | cors-security-hardening | consolidated strict CORS allowlist handling for preflight/non-preflight, removed permissive origin reflection, added `Vary: Origin` and new CORS integration contract suite
- `2026-02-19 05:07 UTC` | codex | action | quality-gates | re-ran full `npm run verify`; `type-check`, `lint`, `test` (139/139), and `build` all passing
- `2026-02-19 05:06 UTC` | codex | action | auth-mfa-contract-hardening | removed unreachable dead code in `/api/auth/mfa/verify` and added integration contract asserting explicit `501 NOT_IMPLEMENTED` behavior
- `2026-02-19 04:57 UTC` | codex | action | quality-gates | re-ran `npm run verify` (`type-check`, `lint`, `test`, `build`) all passing with 136 tests
- `2026-02-19 04:57 UTC` | codex | action | notifications-query-contract-hardening | replaced permissive notifications pagination parsing with strict validated query contracts and added malformed-metadata resilience plus integration coverage
- `2026-02-19 04:49 UTC` | codex | action | quality-gates | re-ran `npm run verify` (`type-check`, `lint`, `test`, `build`) all passing with 135 tests
- `2026-02-19 04:49 UTC` | codex | action | admin-organizations-implementation | replaced `/api/admin/organizations` placeholder with D1-derived paginated organization summaries and added integration contracts for validation, fail-closed DB errors, and response shape
- `2026-02-18 11:54 UTC` | codex | push | `main -> origin/main` | success (`fe68632`)
- `2026-02-18 11:54 UTC` | codex | commit | `fe68632` | hardened auth fail-closed behavior for unavailable DB in non-development environments and added production contract tests
- `2026-02-18 11:53 UTC` | codex | action | auth-fail-closed-hardening | switched auth login/register/logout DB access to optional binding path and enforced explicit `CONFIGURATION_ERROR` fail-closed behavior outside development when auth DB is unavailable
- `2026-02-18 11:53 UTC` | codex | action | quality-gates | re-ran targeted security suite plus full `type-check`, `lint`, `test`, and `build` all passing (132 tests)
- `2026-02-18 11:45 UTC` | codex | commit | `42af5f9` | added payment webhook threat-model document and expanded abuse-path integration contracts for unknown booking and intent mismatch handling
- `2026-02-18 11:45 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, full `test`, and `build` all passing (130 tests)
- `2026-02-18 11:43 UTC` | codex | action | webhook-threat-model-formalization | documented Stripe webhook threats/controls and linked artifact into deployment/operations docs
- `2026-02-18 11:34 UTC` | codex | commit | `b54a306` | hardened webhook booking-intent binding and metadata trust checks with expanded integration coverage
- `2026-02-18 11:33 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, targeted webhook suites, full `test`, and `build` all passing (127 tests)
- `2026-02-18 11:31 UTC` | codex | action | webhook-trust-boundary-hardening | constrained payment webhook transitions to canonical booking+intent context and added spoofed-metadata abuse-path assertions
- `2026-02-18 10:54 UTC` | codex | commit | `cd5bb88` | consolidated deployment/migration/readme docs, added operations runbook, and added `verify`/`verify:ci` scripts
- `2026-02-18 10:52 UTC` | codex | action | quality-gates | ran `npm run db:check-migrations` (pass) and `npm run verify` (`type-check`, `lint`, `test`, `build` all passing with 126 tests)
- `2026-02-18 10:53 UTC` | codex | action | migration-smoke-local | attempted `npm run db:smoke`; blocked in sandbox (`listen EPERM 127.0.0.1`), CI migration-smoke remains authoritative
- `2026-02-18 10:51 UTC` | codex | action | docs-ops-consolidation | replaced stale deployment/migration guidance and added centralized incident response/runbook documentation
- `2026-02-18 10:44 UTC` | codex | commit | `5f64e92` | centralized query integer validation helper and wired admin/matching/users routes to shared parser
- `2026-02-18 10:42 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, and `build` all passing (126 tests)
- `2026-02-18 10:41 UTC` | codex | action | validation-contract-alignment | extracted shared query integer parser and removed route-local duplicate implementations
- `2026-02-18 10:40 UTC` | codex | commit | `9b6b1e1` | expanded admin subroute authz matrix coverage with additional negative-role denial contracts and super-admin allow-path pass-through checks
- `2026-02-18 10:39 UTC` | codex | action | quality-gates | re-ran `lint`, targeted authz integration suite, `type-check`, full `test`, and `build` all passing (126 tests)
- `2026-02-18 10:38 UTC` | codex | action | authz-matrix-expansion-admin-subroutes | added integration contracts for non-admin denial on admin stats/users/detail/mutation/export routes and explicit super-admin pass-through behavior
- `2026-02-18 10:37 UTC` | codex | commit | `2819b2c` | added route-level observability contracts asserting handled/unhandled structured telemetry on validation vs server-error webhook paths
- `2026-02-18 10:36 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, targeted integration suite, full `test`, and `build` all passing (124 tests)
- `2026-02-18 10:35 UTC` | codex | action | observability-metrics-contracts | added integration assertions for global error classification logs (`type=handled` and `type=unhandled`) on key payment webhook failure paths
- `2026-02-18 10:32 UTC` | codex | commit | `82a1048` | added transition audit persistence for matching confirm/reject and payment webhook success/failure/cancel paths with integration contract coverage
- `2026-02-18 10:32 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (122 tests)
- `2026-02-18 10:32 UTC` | codex | action | observability-transition-audit-hardening | implemented best-effort audit writes on critical matching/payment state transitions and extended taxonomy contract tests
- `2026-02-18 06:23 UTC` | codex | commit | `e8a818b` | added observability audit taxonomy integration contracts for auth/user security actions (`USER_LOGIN`, `USER_REGISTER`, `USER_LOGOUT`, `DATA_EXPORT`, `ACCOUNT_DELETED`)
- `2026-02-18 06:23 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (120 tests)
- `2026-02-18 06:22 UTC` | codex | action | observability-contract-hardening | introduced dedicated integration suite for audit action taxonomy consistency on critical auth/privacy workflows
- `2026-02-18 06:19 UTC` | codex | commit | `96fe130` | expanded route authz matrix integration coverage for matching organization-scope access contracts and super-admin override behavior
- `2026-02-18 06:19 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (117 tests)
- `2026-02-18 06:18 UTC` | codex | action | authz-matrix-expansion | added cross-org admin-denial contracts in route authz suite for matching `rider-requests`, `results`, `find`, `find-pool`, and `reject`
- `2026-02-18 06:16 UTC` | codex | commit | `3e6ab19` | enforced org-scoped admin access controls in matching routes and added cross-org authorization integration tests
- `2026-02-18 06:15 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (116 tests)
- `2026-02-18 06:14 UTC` | codex | action | authz-hardening-org-scope | restricted matching admin access to same-organization resources (super-admin exempt) and scoped batch processing by organization
- `2026-02-18 06:11 UTC` | codex | commit | `4778fb4` | normalized malformed-JSON validation contract across matching write endpoints and added integration coverage
- `2026-02-18 06:10 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (113 tests)
- `2026-02-18 06:09 UTC` | codex | action | matching-json-contract-hardening | added shared JSON-parse guard and standardized `400 VALIDATION_ERROR` response for malformed JSON on matching write paths
- `2026-02-18 06:06 UTC` | codex | commit | `6e018d8` | added privileged read-access audit coverage across admin/monitoring routes and expanded integration contracts
- `2026-02-18 06:05 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (111 tests)
- `2026-02-18 06:04 UTC` | codex | action | security-audit-coverage | implemented best-effort admin/monitoring security event logging for privileged read paths (`ADMIN_*_VIEWED`, `ADMIN_MONITORING_*_VIEWED`)
- `2026-02-18 05:21 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:21 UTC` | codex | commit | `c1cd599` | hardened admin mutation error contracts and added dedicated admin integration suite (authz, audit logging, DB failure behavior)
- `2026-02-18 05:20 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (85 tests)
- `2026-02-18 05:19 UTC` | codex | action | admin-hardening | added explicit failure behavior for admin update/export DB errors, enforced update payload validation, and added admin audit-log writes for update/export actions
- `2026-02-18 05:13 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:13 UTC` | codex | commit | `b9c526d` | hardened admin user-management authz to prevent super-admin privilege escalation and unauthorized super-admin account modification
- `2026-02-18 05:12 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (79 tests)
- `2026-02-18 05:11 UTC` | codex | action | authz-hardening-admin | enforced super-admin-only constraints for `super_admin` role assignment and super-admin account updates in admin routes
- `2026-02-18 05:10 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:10 UTC` | codex | commit | `87ce1fe` | added migration filename/order policy enforcement script, CI gate wiring, and migration guide policy updates
- `2026-02-18 05:09 UTC` | codex | action | quality-gates | re-ran `db:check-migrations`, `type-check`, `lint`, `test`, `build` all passing (77 tests)
- `2026-02-18 05:08 UTC` | codex | action | migration-determinism-hardening | introduced automated migration prefix/format checks with explicit legacy duplicate allowance for `0003_*` only and contiguous-version enforcement
- `2026-02-18 05:06 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:06 UTC` | codex | commit | `24152fd` | added route authz matrix artifact and new route authz integration contracts for public/auth/admin boundaries
- `2026-02-18 05:05 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (77 tests)
- `2026-02-18 05:04 UTC` | codex | action | authz-matrix-enforcement | added `docs/ROUTE_AUTHZ_MATRIX.md` and `tests/integration/route-authz-contracts.test.ts` to codify and enforce route access contracts
- `2026-02-18 04:59 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:59 UTC` | codex | commit | `6f016e3` | blocked user account deletion when user is still driving active trips and added integration validation coverage
- `2026-02-18 04:58 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (73 tests)
- `2026-02-18 04:57 UTC` | codex | action | account-deletion-hardening | added active-driver-trip guard (`scheduled|active`) before account anonymization to prevent orphaned active trips
- `2026-02-18 04:56 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:56 UTC` | codex | commit | `06a4016` | enforced monitoring route auth/authz contracts and added integration coverage for monitoring access boundaries
- `2026-02-18 04:55 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (72 tests)
- `2026-02-18 04:54 UTC` | codex | action | monitoring-auth-hardening | secured monitoring endpoints per documented contracts (`auth` for operational views, `admin` for security telemetry)
- `2026-02-18 04:49 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:49 UTC` | codex | commit | `0cfe8b2` | hardened match confirm/reject integrity with pending-state guards and payload-context mismatch protection
- `2026-02-18 04:49 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (70 tests)
- `2026-02-18 04:48 UTC` | codex | action | match-integrity-hardening | bound confirm/reject flows to canonical `match_results` context, enforced pending-only transitions, and expanded integration contracts for mismatch/conflict paths
- `2026-02-18 04:46 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:46 UTC` | codex | commit | `305d7dc` | hardened matching route authz boundaries, tightened trip-cancel state guards, and expanded integration security coverage
- `2026-02-18 04:45 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (68 tests)
- `2026-02-18 04:44 UTC` | codex | action | authz-hardening | enforced auth middleware + owner/admin checks across `/api/matching/*`, added admin gating for `batch/config/stats`, and added match-ownership reject protection
- `2026-02-18 04:41 UTC` | codex | action | transition-hardening | tightened trip cancel transitions to cancellable states (`scheduled|active`) and added explicit conflict contracts for `cancelled/completed` states
- `2026-02-18 04:29 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:29 UTC` | codex | commit | `31ddff2` | added payment-intent idempotent replay handling with cached response reuse and pending intent retrieval fallback
- `2026-02-18 04:29 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (62 tests)
- `2026-02-18 04:27 UTC` | codex | action | payment-intent-idempotency-hardening | extended `/api/payments/intent` with scoped idempotency key handling and replay-safe response path
- `2026-02-18 04:19 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:19 UTC` | codex | commit | `f328d53` | added idempotency replay protection for trip accept/reject/cancel flows and coverage for replay safety
- `2026-02-18 04:19 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (61 tests)
- `2026-02-18 04:18 UTC` | codex | action | idempotency-hardening | extended `Idempotency-Key` protection to driver write transitions and asserted replay no-op behavior in integration tests
- `2026-02-18 04:15 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:15 UTC` | codex | commit | `91c038d` | added reject/cancel transition guards with `CONFLICT` contracts for non-pending and already-cancelled states
- `2026-02-18 04:15 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (59 tests)
- `2026-02-18 04:14 UTC` | codex | action | transition-hardening | enforced pending-only reject transition and non-terminal cancel transition; added security integration coverage for both conflict paths
- `2026-02-18 04:11 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:11 UTC` | codex | commit | `1cbfe37` | hardened booking acceptance flow with pending-only updates, seat conflict guards, and compensating rollback path
- `2026-02-18 04:11 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (57 tests)
- `2026-02-18 04:10 UTC` | codex | action | booking-consistency-hardening | added acceptance conflict handling for non-pending bookings and seat exhaustion race with explicit `CONFLICT` responses
- `2026-02-18 04:07 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:07 UTC` | codex | commit | `bf1a256` | added payment webhook transition guards to block terminal-state downgrades and expanded integration coverage
- `2026-02-18 04:07 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (55 tests)
- `2026-02-18 04:06 UTC` | codex | action | payment-transition-hardening | constrained webhook update transitions by current `payment_status` and skipped side effects on zero-row updates
- `2026-02-18 04:02 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:02 UTC` | codex | commit | `d6a7f7b` | enforced server-side payment amount integrity for `/api/payments/intent` and added tampering-rejection integration coverage
- `2026-02-18 04:02 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (54 tests)
- `2026-02-18 04:02 UTC` | codex | action | payment-integrity-hardening | validated client-provided payment amount against persisted trip fare and rejected mismatches with `VALIDATION_ERROR`
- `2026-02-18 04:00 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:00 UTC` | codex | commit | `5dbb35d` | updated codex ledger for webhook abuse-path hardening batch
- `2026-02-18 04:00 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 04:00 UTC` | codex | commit | `9cac544` | added payment webhook abuse-path coverage (missing signature + metadata) with no-mutation assertions
- `2026-02-18 04:00 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (53 tests)
- `2026-02-18 03:59 UTC` | codex | action | integration-hardening | expanded webhook contract suite for missing signature and missing metadata handling across Stripe event variants
- `2026-02-18 03:47 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 03:47 UTC` | codex | commit | `5e84015` | scoped payment auth to `/intent` only and expanded integration contract coverage for payment auth + webhook behavior
- `2026-02-18 03:46 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (49 tests)
- `2026-02-18 03:45 UTC` | codex | action | payment-webhook-contract-hardening | removed JWT auth requirement from Stripe webhook endpoint, preserved auth on payment intent creation, and updated security tests to assert both contracts
- `2026-02-18 03:39 UTC` | codex | commit | `17bb25d` | reduced expected-error log noise by classifying known client/auth/validation failures as handled warnings
- `2026-02-18 03:39 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 03:38 UTC` | codex | action | logging-hardening | refined global error logging to classify expected 4xx/auth/validation paths as `type: handled` warnings while keeping 5xx/internal failures as `type: unhandled` errors
- `2026-02-18 03:37 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (48 tests); verified handled-vs-unhandled logging behavior in integration output
- `2026-02-17 19:14 UTC` | codex | commit | `f6537ef` | added notifications auth contract integration coverage and updated quality status
- `2026-02-17 19:14 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 19:13 UTC` | codex | action | integration-tests | added unauthorized-access contract coverage for `/api/notifications`, `/api/notifications/:id/read`, and `/api/notifications/read-all` (missing + malformed token paths)
- `2026-02-17 19:13 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (48 tests)
- `2026-02-17 19:09 UTC` | codex | commit | `66b5dcf` | added invalid notification status filter validation integration test and updated quality metrics
- `2026-02-17 19:09 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 19:08 UTC` | codex | action | integration-tests | added invalid `status` query-param contract test for `/api/notifications` (`400 VALIDATION_ERROR`)
- `2026-02-17 19:08 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (47 tests)
- `2026-02-17 19:05 UTC` | codex | commit | `f947ae7` | added notification pagination boundary integration coverage and updated quality status
- `2026-02-17 19:05 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 19:04 UTC` | codex | action | integration-tests | added pagination boundary coverage for `/api/notifications` (`limit` clamp and `offset`/`hasMore` behavior)
- `2026-02-17 19:04 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (46 tests)
- `2026-02-17 18:47 UTC` | codex | commit | `29988f2` | added notification status lifecycle integration coverage (`status=read` filtering and read transition assertions)
- `2026-02-17 18:47 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:44 UTC` | codex | action | integration-tests | expanded notification lifecycle coverage with status-filter tests and mark-read->query-read state transition assertions
- `2026-02-17 18:44 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (44 tests)
- `2026-02-17 18:36 UTC` | codex | commit | `0759a65` | added stateful user preferences persistence-contract integration test and updated quality status
- `2026-02-17 18:36 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:35 UTC` | codex | action | integration-tests | added stateful `PUT -> GET` persistence-contract test for `/api/users/preferences` across separate requests
- `2026-02-17 18:35 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (42 tests)
- `2026-02-17 18:30 UTC` | codex | commit | `e5b56d5` | added allow-path notification preference enforcement coverage (SMS sent when enabled, payment notification persisted when enabled)
- `2026-02-17 18:30 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:29 UTC` | codex | action | integration-tests | expanded notification preference enforcement suite with positive-path assertions for SMS delivery + notification persistence when preferences are enabled
- `2026-02-17 18:29 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (41 tests)
- `2026-02-17 18:24 UTC` | codex | commit | `2293ec4` | extended preference enforcement coverage for SMS-disabled delivery path under Twilio-enabled branch
- `2026-02-17 18:24 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:22 UTC` | codex | action | integration-tests | expanded `tests/integration/notification-preferences-enforcement.test.ts` with Twilio-enabled branch validation ensuring SMS is skipped when `smsNotifications=false`
- `2026-02-17 18:22 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (39 tests)
- `2026-02-17 18:09 UTC` | codex | commit | `607d752` | added integration coverage for notification preference enforcement paths
- `2026-02-17 18:09 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:08 UTC` | codex | action | integration-tests | added `tests/integration/notification-preferences-enforcement.test.ts` to verify notifications are not persisted when `tripUpdates=false` for trip acceptance and payment success flows
- `2026-02-17 18:08 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (38 tests)
- `2026-02-17 18:02 UTC` | codex | commit | `14dbefe` | persisted user preferences and enforced notification preference checks across trip/payment flows
- `2026-02-17 18:02 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:01 UTC` | codex | action | preference-enforcement | enforced user notification preferences (`tripUpdates`, `smsNotifications`) across trip and payment notification persistence/sending paths
- `2026-02-17 18:00 UTC` | codex | action | preference-persistence | added `0006_user_preferences.sql`, `src/lib/userPreferences.ts`, and persisted `GET/PUT /api/users/preferences` backed by D1
- `2026-02-17 18:00 UTC` | codex | action | integration-tests | added `tests/integration/user-preferences.test.ts` for defaults and upsert behavior
- `2026-02-17 18:00 UTC` | codex | action | migration-smoke | expanded `scripts/db-smoke.sh` and `MIGRATION_GUIDE.md` to validate/document `user_preferences` schema
- `2026-02-17 18:00 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (36 tests); local `db:smoke` remains sandbox-blocked (`listen EPERM 127.0.0.1`)
- `2026-02-17 17:51 UTC` | codex | commit | `c4c3e07` | implemented notifications API endpoints, in-app notification persistence hooks, and integration coverage
- `2026-02-17 17:51 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 17:51 UTC` | codex | action | notification-api | added `/api/notifications` route with list, mark-read, and read-all endpoints
- `2026-02-17 17:50 UTC` | codex | action | notification-persistence | added `src/lib/notificationStore.ts` and wired in-app persistence to trip booking/accept/reject/cancel plus payment succeeded/failed flows
- `2026-02-17 17:50 UTC` | codex | action | integration-tests | added `tests/integration/notifications-routes.test.ts` with route-level authz/pagination/read-state coverage
- `2026-02-17 17:50 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (34 tests)
- `2026-02-17 17:46 UTC` | codex | commit | `98a044b` | added notifications schema migration and expanded migration smoke verification
- `2026-02-17 17:46 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 17:46 UTC` | codex | action | migration-feature | added `0005_notifications.sql` with notifications table, constraints, and indexes (`idx_notifications_user_status`, `idx_notifications_type`, `idx_notifications_trip`)
- `2026-02-17 17:46 UTC` | codex | action | migration-smoke | extended `scripts/db-smoke.sh` to verify notifications table and indexes
- `2026-02-17 17:45 UTC` | codex | action | docs | updated `MIGRATION_GUIDE.md` with 0005 migration details/order and deployment instructions
- `2026-02-17 17:45 UTC` | codex | action | quality-gates | re-ran type-check/lint/test/build all passing; local `db:smoke` remains sandbox-blocked (`listen EPERM 127.0.0.1`)
- `2026-02-17 17:40 UTC` | codex | commit | `fdc1026` | hardened migration determinism, added `db:smoke` script, and wired migration-smoke CI job
- `2026-02-17 17:40 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 17:38 UTC` | codex | action | migration-hardening | fixed `0004_performance_indexes.sql` to avoid non-existent schema assumptions (`sessions.refresh_token_hash`, `notifications` indexes)
- `2026-02-17 17:37 UTC` | codex | action | ci-migration-gates | added `db:smoke` script and `migrations-smoke` CI job in `.github/workflows/ci.yml`
- `2026-02-17 17:36 UTC` | codex | action | validation | local `db:smoke` blocked by sandbox networking (`listen EPERM`), while type-check/lint/test/build passed
- `2026-02-17 17:36 UTC` | codex | action | docs | updated `MIGRATION_GUIDE.md` with migration safety notes and smoke-check command
- `2026-02-17 17:25 UTC` | codex | commit | `160a2ca` | guaranteed structured JSON error responses via global app handler and aligned integration assertions
- `2026-02-17 17:25 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 17:25 UTC` | codex | action | error-handling-hardening | added global `app.onError` JSON response handler to guarantee structured API errors for thrown route exceptions
- `2026-02-17 17:25 UTC` | codex | action | integration-hardening | tightened production webhook configuration assertion to validate `CONFIGURATION_ERROR` code and masked production message
- `2026-02-17 17:25 UTC` | codex | action | quality-gates | re-ran full gates (`type-check`, `lint`, `test`, `build`) all passing with 30 tests
- `2026-02-17 17:23 UTC` | codex | commit | `63f1a01` | expanded integration hardening coverage and added CI quality-gates workflow
- `2026-02-17 17:23 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 17:23 UTC` | codex | action | ci-gates | added `.github/workflows/ci.yml` to enforce `npm ci`, type-check, lint, test, and build on push/PR
- `2026-02-17 17:22 UTC` | codex | action | integration-hardening | expanded security integration tests for reject/cancel ownership, completed-only rating, and production webhook config guard
- `2026-02-17 17:22 UTC` | codex | action | quality-gates | re-ran full gates (`type-check`, `lint`, `test`, `build`) all passing with 30 tests
- `2026-02-17 17:15 UTC` | codex | action | test-hardening | added integration security suite (`tests/integration/security-hardening.test.ts`) and included integration tests in Vitest run
- `2026-02-17 17:08 UTC` | codex | action | input-hardening | made auth schemas strict and added numeric bounds validation for payment intent amount
- `2026-02-17 17:06 UTC` | codex | action | reliability-hardening | added idempotency-key replay protection on trip booking/offer write endpoints using KV
- `2026-02-17 17:04 UTC` | codex | action | payment-hardening | added required Stripe metadata validation before booking/payment status mutations
- `2026-02-17 17:02 UTC` | codex | action | security-hardening | implemented Stripe webhook replay protection via KV event-id cache
- `2026-02-17 17:02 UTC` | codex | action | authz-hardening | enforced driver ownership checks for booking accept/reject/cancel and completed-trip rating guard
- `2026-02-17 16:56 UTC` | codex | action | security-hardening | started critical fixes (registration role escalation + production webhook secret enforcement)
- `2026-02-17 18:48 UTC` | codex | commit | `e2658f6` | unknown-based DB typing + explicit row models
- `2026-02-17 18:49 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:42 UTC` | codex | commit | `17d7d89` | typed route model refactor wave
- `2026-02-17 18:42 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-17 18:33 UTC` | codex | commit | `3e0f272` | auth/middleware strict typing hardening
- `2026-02-17 18:33 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:26 UTC` | codex | action | admin-query-hardening | enforced strict validation for `/api/admin/users` and `/api/admin/logs` query params (`page`, `limit`, role/status/level filters) with explicit `400 VALIDATION_ERROR` contracts
- `2026-02-18 05:26 UTC` | codex | action | integration-tests | expanded `tests/integration/admin-routes-hardening.test.ts` with invalid-query contract coverage for admin users/logs endpoints
- `2026-02-18 05:26 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (89 tests)
- `2026-02-18 05:26 UTC` | codex | commit | `8d68c48` | hardened admin list query validation and expanded integration contracts
- `2026-02-18 05:26 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:33 UTC` | codex | action | fallback-removal-hardening | removed silent fallback responses from authenticated admin/user read-write routes (`/api/admin/stats`, `/api/admin/users`, `/api/admin/users/:id`, `/api/admin/logs`, `/api/users/profile`, `/api/users/trips`, `/api/users/trips` create, `/api/users/profile` update) and standardized explicit `500 INTERNAL_ERROR` responses on DB failures
- `2026-02-18 05:33 UTC` | codex | action | integration-tests | expanded `tests/integration/admin-routes-hardening.test.ts` and added `tests/integration/user-routes-hardening.test.ts` to assert fail-closed behavior for DB failure paths
- `2026-02-18 05:33 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (97 tests)
- `2026-02-18 05:34 UTC` | codex | commit | `398d49a` | removed silent DB fallbacks and enforced fail-closed contracts across admin/user endpoints with expanded integration coverage
- `2026-02-18 05:34 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:41 UTC` | codex | action | validation-hardening | enforced strict query/body validation across `/api/matching` list endpoints (`status`, `limit`, `offset`), `/api/users/trips` filters (`page`, `limit`, `status`), `/api/users/trips` create payload seat/price constraints, and `/api/trips/available` coordinate/maxDetour bounds
- `2026-02-18 05:41 UTC` | codex | action | integration-tests | added `tests/integration/query-validation-hardening.test.ts` to lock validation contracts across matching/user/trip routes
- `2026-02-18 05:41 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (102 tests)
- `2026-02-18 05:42 UTC` | codex | commit | `28e2623` | hardened matching/user/trip query+payload validation contracts and added integration coverage
- `2026-02-18 05:42 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 05:51 UTC` | codex | action | mutation-validation-hardening | hardened matching mutation payload contracts (`PUT /api/matching/driver-trips/:id`, `PUT /api/matching/config`), added cross-field matching/trip write constraints (`availableSeats<=totalSeats`), and tightened trip offer payload validation (strict shape + positive price bounds)
- `2026-02-18 05:51 UTC` | codex | action | integration-tests | expanded `tests/integration/query-validation-hardening.test.ts` to cover matching mutation/config validation and trip-offer payload constraints
- `2026-02-18 05:51 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (106 tests)
- `2026-02-18 05:52 UTC` | codex | commit | `0b94ae4` | hardened matching mutation/config validation and trip-offer payload constraints with expanded integration coverage
- `2026-02-18 05:52 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-18 06:00 UTC` | codex | action | transactional-consistency-hardening | implemented atomic matching seat reservation (`reserveDriverTripSeat`) with compensation (`releaseDriverTripSeat`) in `/api/matching/confirm` to prevent over-confirmation under seat contention
- `2026-02-18 06:00 UTC` | codex | action | integration-tests | expanded `tests/integration/security-hardening.test.ts` with booking/payment race-path contracts (distinct webhook-event idempotency for success side effects; sequential seat-contention confirm flow)
- `2026-02-18 06:00 UTC` | codex | action | quality-gates | re-ran `type-check`, `lint`, `test`, `build` all passing (108 tests)
- `2026-02-18 06:00 UTC` | codex | commit | `b9802b2` | hardened matching seat reservation consistency and expanded booking/payment race-path integration contracts
- `2026-02-18 06:00 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-19 11:11 UTC` | codex | action | booking-role-hardening | enforced `role='rider'` guards in trip booking accept/reject updates, seat-decrement subqueries, and related booking-detail lookups to prevent non-rider participant transitions
- `2026-02-19 11:11 UTC` | codex | action | integration-tests | tightened `tests/integration/security-hardening.test.ts` assertions to require rider-role guard presence in accept/reject mutation SQL and accept compensation path
- `2026-02-19 11:11 UTC` | codex | action | quality-gates | re-ran `npm run verify` (`type-check`, `lint`, `test`, `build`) all passing (187 tests)
- `2026-02-19 11:11 UTC` | codex | commit | `6db7d5e` | hardened rider-role scoping in booking accept/reject flows and expanded integration guard assertions
- `2026-02-19 11:11 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-19 11:24 UTC` | codex | action | sse-authz-hardening | required JWT auth on `/api/events`, introduced role-aware event visibility filtering (non-admin users only receive events scoped to their `userId`), and preserved payment event delivery by emitting booking `user_id` context
- `2026-02-19 11:24 UTC` | codex | action | integration-tests | expanded route authz contracts to enforce unauthenticated denial on `/api/events`
- `2026-02-19 11:24 UTC` | codex | action | unit-tests | added `tests/unit/eventBus.test.ts` to lock event visibility policy for `user` vs `admin`/`super_admin` roles
- `2026-02-19 11:24 UTC` | codex | action | quality-gates | re-ran `npm run verify` (`type-check`, `lint`, `test`, `build`) all passing (191 tests)
- `2026-02-19 11:24 UTC` | codex | commit | `9c0f520` | hardened SSE event auth and user-scoped visibility
- `2026-02-19 11:24 UTC` | codex | push | `main -> origin/main` | success
- `2026-02-19 11:31 UTC` | codex | action | correlation-id-hardening | added `src/lib/observability.ts` request-context helper and propagated correlation IDs through auth/payment structured logs (including webhook replay/idempotency/audit-warning paths)
- `2026-02-19 11:31 UTC` | codex | action | logger-hardening | normalized request-id extraction in logger emit path (promote `metadata.requestId` to top-level `requestId`) and fixed `logger.error/logger.fatal` metadata merge semantics for `errorOrMeta` + explicit `meta` arguments
- `2026-02-19 11:31 UTC` | codex | action | integration-tests | expanded `tests/integration/request-id-contracts.test.ts` with cross-module observability assertions ensuring auth/payment warning+error logs retain client-provided `X-Request-ID`
- `2026-02-19 11:31 UTC` | codex | action | quality-gates | re-ran `npm run verify` (`type-check`, `lint`, `test`, `build`) all passing (193 tests)
- `2026-02-19 11:31 UTC` | codex | commit | `9b87518` | hardened request-id propagation in auth and payments logs
- `2026-02-19 11:31 UTC` | codex | push | `main -> origin/main` | success

---

## Next Active Tasks
1. High: apply migration 0013 to production/staging D1 (`scripts/apply-migrations-remote.cjs` — run after 0012 if not yet applied).
2. High: provision GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Google Cloud Console and set as Cloudflare Pages secrets.
3. High: set STRIPE_SECRET_KEY on production/staging if not already set (needed for subscription payment intents).
4. High: apply migration 0012 to production/staging D1 if not already done.
5. Medium: wire Stripe webhook `payment_intent.succeeded` / `payment_intent.payment_failed` metadata to include `subscriptionId` in production Stripe dashboard event metadata.
6. Medium: add correlation ID propagation consistency checks across modules and related observability assertions.
7. Medium: expand caching invalidation contracts/tests for user/admin/matching read models.

Owner guidance:
- Keep this file authoritative.
- Keep entries factual and timestamped.
- Do not skip failed attempts; log them with outcome.
