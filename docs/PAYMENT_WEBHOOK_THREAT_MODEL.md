# Payment Webhook Threat Model

Scope: `POST /api/payments/webhook` in `src/routes/payments.ts`.

## 1. Assets and Security Objectives

Assets protected:
- Booking payment state (`trip_participants.payment_status`)
- Payment intent linkage (`trip_participants.payment_intent_id`)
- User trip/payment notifications
- Audit trail integrity

Objectives:
- Accept only authentic Stripe-origin events.
- Prevent replay and duplicate side effects.
- Prevent metadata spoofing from mutating unrelated bookings.
- Preserve monotonic payment state transitions.

## 2. Threats and Controls

### T1: Forged webhook requests
Threat:
- Attacker posts arbitrary payloads to webhook endpoint.

Controls:
- Requires `stripe-signature` header.
- In production, requires configured `STRIPE_WEBHOOK_SECRET`.
- Signature verification via Stripe SDK when secret is configured.

Evidence:
- Route checks in `src/routes/payments.ts`.
- Contract tests in `tests/integration/security-hardening.test.ts`.

### T2: Replay of previously valid events
Threat:
- Valid event replayed to trigger repeated mutations/notifications.

Controls:
- KV-backed event replay guard keyed by Stripe `event.id` with 7-day TTL.
- Replay short-circuits processing and returns `{ replay: true }`.

Evidence:
- `isReplayEvent` in `src/routes/payments.ts`.
- Replay contract tests in `tests/integration/security-hardening.test.ts`.

### T3: Metadata trust abuse (booking/user/trip spoofing)
Threat:
- Event metadata references different booking/user/trip to hijack transitions.

Controls:
- Canonical booking lookup by `bookingId`.
- Booking must exist and contain matching `payment_intent_id`.
- Success flow enforces metadata consistency against canonical booking context.
- Status updates bind on both booking id and payment intent id.

Evidence:
- Canonical binding logic in `src/routes/payments.ts`.
- Abuse-path tests for metadata mismatch and intent mismatch in `tests/integration/security-hardening.test.ts`.

### T4: Terminal-state downgrade / invalid transitions
Threat:
- Failed/canceled events downgrade already-finalized paid bookings.

Controls:
- Transition guards only permit allowed current-state updates.
- Zero-row updates skip side effects.

Evidence:
- Conditional `UPDATE ... WHERE` transition constraints in `src/routes/payments.ts`.
- Transition guard tests in `tests/integration/security-hardening.test.ts`.

### T5: Notification/audit side-effect inflation
Threat:
- Duplicate or invalid events trigger repeated side effects.

Controls:
- Side effects occur only after successful guarded state transition.
- Replay and zero-row transition paths do not emit business side effects.

Evidence:
- Ordering of update vs side effects in webhook handlers.
- Integration tests for idempotent side effects in `tests/integration/security-hardening.test.ts`.

## 3. Residual Risk

- If Stripe credentials are compromised, forged signed events remain possible.
  - Mitigation: rotate webhook secrets and monitor anomalous payment event patterns.
- In non-production environments without webhook secret, signature verification may be skipped.
  - Mitigation: strict requirement in production, and explicit warning logs in non-production.

## 4. Monitoring and Alerting Guidance

High-priority signals:
- Spike in warnings for `mismatched payment intent` or `metadata mismatch`.
- Increase in `CONFIGURATION_ERROR` for webhook secret issues.
- Unexpected increase in replayed event counts.

Operational actions:
- Correlate `event.id`, `paymentIntentId`, and `bookingId` in logs.
- Validate booking/payment state directly in D1 during incident triage.
- Follow incident procedures in `docs/OPERATIONS_RUNBOOK.md`.

## 5. Verification Matrix

Required CI gates:
- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build`

Security regression suites:
- `tests/integration/security-hardening.test.ts`
- `tests/integration/audit-taxonomy-contracts.test.ts`
- `tests/integration/notification-preferences-enforcement.test.ts`

