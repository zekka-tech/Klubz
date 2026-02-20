# Phase 2 – Reliability Audit

**Last updated:** 2026-02-19  
**Scope:** Validation of trip lifecycle idempotency fail-closed contracts, payment failure/replay telemetry, and admin/matching observability under KV/D1 degradations.

## Trip lifecycle contracts

- `tests/integration/security-hardening.test.ts::trip offer logs configuration error when DB is unavailable` – exercises `/api/trips/offer` with the DB binding removed to prove the handler still returns `CONFIGURATION_ERROR`, surfaces the `Trip offer denied because DB is unavailable` log, and never emits multiple trips when KV or D1 tear down.
- `...::trip booking accept logs configuration error when DB is unavailable` – captures `Booking acceptance denied because DB is unavailable`, validates the 500 response contract, and ensures the `CONFIGURATION_ERROR` log is emitted with a request ID even when `getDBOptional` short-circuits.
- `...::trip booking reject logs configuration error when DB is unavailable` – covers `/api/trips/:trip/bookings/:booking/reject` under the same outage path and asserts the `Booking rejection denied...` log line plus the consistent `CONFIGURATION_ERROR` payload.
- `...::trip cancel logs configuration error when DB is unavailable` – repeats the contract around `/api/trips/:id/cancel`.
- `...::trip booking reject remains idempotent when CACHE fails and only DB fallback runs` – ensures the rejection path still honors idempotent replay (IDEMPOTENCY_REPLAY) without the KV cache while the `idempotency_records` table provides durability.
- `tests/integration/security-hardening.test.ts::trip booking reject is idempotent without CACHE using durable DB idempotency records` – forces the `FailingKV` stub so the KV layer throws, proves the DB ledger drives the replay check, and exercises the new 409/IDEMPOTENCY_REPLAY contract when only the persistent ledger is available.
- `tests/integration/security-hardening.test.ts::trip cancel is idempotent without CACHE using durable DB idempotency records` – mirrors the reject coverage for the cancel endpoint, asserting the DB-only path still short-circuits replays and returns the stored ledger indicator instead of mutating state again.
- `tests/integration/security-hardening.test.ts::trip offer is idempotent without CACHE using durable DB idempotency records` – extends lifecycle reliability to the offer route so the driver’s trip creation path also tolerates KV outages while keeping the DB ledger authoritative for dedup detection.

## Payment domain failure modes & telemetry

- **Webhook replay under KV failure:** `tests/integration/security-hardening.test.ts::payment webhook dedupes replays when KV fails using DB ledger` installs the `FailingKV` stub so `isReplayEvent` short-circuits to the D1 ledger, verifies the second request returns `replay: true`, and asserts the structured log contains both `eventId` and `requestId`.
- **Webhook configuration guard:** `...::payment webhook logs configuration error when DB is unavailable` removes the D1 binding to trigger `getDB(c)`’s `CONFIGURATION_ERROR`, and the global error handler records the same code (with `type:unhandled`) so the incident log can be correlated via `requestId`.
- **Metadata mismatch telemetry:** `...::payment succeeded webhook ignores metadata mismatch against canonical booking context` now spies on `console.warn` to confirm the `eventId`-aware warning includes the `requestId` field, satisfying structured logging requirements for audit/telemetry dashboards.
- **Payment intent creation failure:** `...::payment intent logs configuration error when DB is unavailable` proves `/api/payments/intent` emits `CONFIGURATION_ERROR` when D1 is offline, and the error log line contains the same code emitted to callers.
- **Payment intent cache failure telemetry:** `tests/integration/security-hardening.test.ts::payment intent replays durable DB response when CACHE fails and logs request id` simulates a non-responsive `CACHE` via `FailingKV`, exercises the DB ledger response, and ensures the warning (`Payment intent cache read failed`) references the same `requestId` surfaced to the caller.
- **Payment webhook dedupes under cache faults:** `tests/integration/security-hardening.test.ts::webhook replay dedupes using DB ledger when CACHE fails and logs request id` replicates the KV outage for replayed events, confirms the DB `processed_webhook_events` guard kicks in, and asserts the `INFO` log (`Ignoring replayed Stripe webhook event`) carries both the `eventId` and the propagated `requestId`.
- **Payment intent configuration guard:** `tests/integration/security-hardening.test.ts::payment intent logs configuration error when DB is unavailable` now also asserts the error response retains the request ID and the global log entry matches the same code/request pair.
- **Payment webhook configuration guard:** `tests/integration/security-hardening.test.ts::payment webhook logs configuration error when DB is unavailable` proves the webhook handler raises `CONFIGURATION_ERROR` when D1 is missing and validates that the resulting `ERROR` log message (`Stripe processing unavailable`) can be correlated via the request ID in the response.

## Admin/Matching resilience

- **Monitoring metrics degradation:** `tests/integration/security-hardening.test.ts::monitoring metrics logs error when DB batch fails` forces the D1 batch query to throw via `BatchFailingDB`, validates the handler still returns zeroed `application`/`business` totals, and asserts the `Metrics DB error` `ERROR` log keeps the propagated `X-Request-ID` so runbooks can retreive incidents from logs.
- **Matching confirm failure handling:** `...::matching confirm logs internal error when DB fails after seat reservation` simulates `confirmMatch` timing out after a successful seat reservation so the route releases the seat, responds with `INTERNAL_ERROR`, and emits an `unhandled` log that contains the `requestId`.
- `tests/integration/security-hardening.test.ts::admin stats logs configuration error when DB is unavailable` – removes the D1 binding to `/api/admin/stats`, exercises the new `CONFIGURATION_ERROR` guard, and asserts the admin audit log plus global `type:unhandled` entry surface the propagated `requestId`.
- `tests/integration/security-hardening.test.ts::matching confirm fails closed when driver seat reservation DB fails` – injests a D1 error during `reserveDriverTripSeat`, confirms the route returns `INTERNAL_ERROR`, and verifies the unhandled log contains the request ID.
- `tests/integration/security-hardening.test.ts::matching confirm releases reserved seat when confirmation update fails` – throws when updating `match_results` to ensure the catch path calls `releaseDriverTripSeat`, confirms the route still logs `INTERNAL_ERROR` with the request ID, and validates the reserved seat is released.
- `tests/integration/security-hardening.test.ts::matching reject fails closed when DB update fails` – simulates a D1 failure on `rejectMatch`, checks the global error response/500 contract, and ensures the `UNHANDLED` log records the same `requestId`.
- **Monitoring metrics request tracking:** `tests/integration/security-hardening.test.ts::monitoring metrics endpoint writes admin audit log on success` now also captures the injected `X-Request-ID` header and proves the middleware request/response log pair includes the same identifier, closing the loop between the HTTP surface and the log stream.

## Expected telemetry / observability

| Code | Context | Log format |
| CONFIGURATION_ERROR | Trip offer/accept/reject/cancel + payment intent/webhook when D1 is undefined | The global error handler emits `{"level":"error","type":"unhandled","code":"CONFIGURATION_ERROR","requestId":...}` and the route-specific logger writes `Trip ... denied because DB is unavailable`. |
| INTERNAL_ERROR | Matching confirm/reject DB failures | The `unhandled` log contains `code":"INTERNAL_ERROR"` plus the `requestId` so downstream alerts can tie to the request trace, covering seat-reservation failures, release compensation, and reject transitions. |
| WARN | Metadata guard tripped | `logger.warn` includes `{ eventId, requestId }` to keep replay investigation straightforward for security/ops. |
| INFO | Webhook replay dedupes | `logger.info` includes `{ eventId, eventType, requestId }` and the JSON payload signals `replay: true`. |

## Quality gates

1. `npm run type-check`
2. `npm run lint`
3. `npm test`
4. `npm run build`

All commands run locally after the reliability and telemetry work described above.
