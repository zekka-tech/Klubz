# Klubz Operations Runbook

This runbook defines production-ready operating procedures for deployment, verification, and incident response.

## 1. Production Readiness Baseline

Minimum merge gate:
- `npm run db:check-migrations`
- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build`

Local deep verification (when local D1 permissions are available):
- `npm run db:smoke`

Deployment prerequisites:
- Cloudflare Pages projects configured (`klubz-production`, `klubz-staging`)
- D1 database created and bound in Wrangler config
- Runtime secrets configured in Pages project secrets
- Route authz matrix and integration contracts passing

## 2. Environment and Secrets

Required runtime secrets:
- `JWT_SECRET`
- `ENCRYPTION_KEY`

Conditionally required:
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `SENDGRID_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

Rules:
- Never commit secrets to git
- Rotate secrets after incident response involving credentials
- Do not log raw secrets or full token values

## 3. Standard Release Procedure

1. Ensure clean branch and synced main:
   - `git checkout main`
   - `git pull`
2. Run gates:
   - `npm run db:check-migrations`
   - `npm run type-check && npm run lint && npm test && npm run build`
3. Deploy staging:
   - `npm run deploy:staging`
4. Verify staging:
   - `curl https://klubz-staging.pages.dev/health`
   - Validate core auth/trip/payment paths
5. Deploy production:
   - `npm run deploy:prod`
6. Post-deploy verification:
   - `curl https://klubz-production.pages.dev/health`
   - Validate monitoring endpoints with admin auth

## 4. Observability and Triage Signals

Primary telemetry sources:
- Structured app logs (`type: request|response|handled|unhandled`)
- Monitoring endpoints:
  - `GET /api/monitoring/metrics` (admin)
  - `GET /api/monitoring/security` (admin)
  - `GET /api/monitoring/sla` (authenticated)

High-signal failure indicators:
- Sustained `type=unhandled` logs
- Spike in `AUTHENTICATION_ERROR` or `AUTHORIZATION_ERROR`
- Payment webhook failures (`PAYMENT_FAILED`, configuration errors)

## 5. Incident Severity Model

- `SEV-1`: Complete outage, data-loss risk, auth bypass, payment integrity failure
- `SEV-2`: Major degraded functionality impacting core trip/payment workflows
- `SEV-3`: Partial degradation, non-critical feature failure, noisy observability
- `SEV-4`: Minor defect, no meaningful customer impact

## 6. Incident Response Checklist

1. Declare severity and open incident channel.
2. Freeze risky deployments.
3. Capture scope:
   - first seen timestamp
   - impacted endpoints
   - affected tenant/user segment
4. Mitigate blast radius.
5. Validate recovery with explicit checks.
6. Record timeline, root cause, and prevention actions.

## 7. Scenario Runbooks

### 7.1 Elevated 5xx / Unhandled Errors
1. Query logs for `"type":"unhandled"` and group by endpoint/code.
2. Check latest deployment and rollback if regression is clear.
3. Validate with:
   - `/health`
   - representative failing endpoint
4. Add/expand integration coverage for the failing contract before closing.

### 7.2 Payment Webhook Degradation
1. Verify `STRIPE_WEBHOOK_SECRET` is configured in production.
2. Confirm webhook signature failures vs business failures.
3. Check idempotency/replay behavior via event ID logs.
4. Validate transition safety in `trip_participants.payment_status`.
5. Validate booking-intent binding and metadata trust constraints against `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md`.
6. If needed, pause downstream side effects and recover state with audited replay.

### 7.3 Migration Failure During Deploy
1. Stop rollout.
2. Run:
   - `npm run db:check-migrations`
   - `npm run db:smoke` (or CI equivalent)
3. Identify migration causing failure and fix forward with next migration version.
4. Avoid destructive rollback unless explicitly approved and backed up.

### 7.4 Authz Boundary Regression
1. Run integration authz suites.
2. Validate critical routes against `docs/ROUTE_AUTHZ_MATRIX.md`.
3. Block release until role and organization-scope contracts are green.

## 8. Post-Incident Requirements

Mandatory before closure:
- root cause documented
- test coverage added for regression class
- ledger update in `codex.md`
- prevention task tracked with owner

## 9. Operational Ownership

- Engineering on-call: incident commander and mitigation lead
- Security owner: authz/secrets/privacy incidents
- Data owner: migration and persistence integrity incidents

## 10. Related Documents

- `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md`
- `DEPLOYMENT.md`
- `MIGRATION_GUIDE.md`
- `docs/ROUTE_AUTHZ_MATRIX.md`
