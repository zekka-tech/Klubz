# Klubz Deployment Guide

This guide is the canonical deployment process for staging and production.

## 1. Prerequisites

- Node.js 18+ and npm 9+
- Cloudflare authentication configured (`wrangler login` or API token)
- Pages projects available:
  - `klubz-staging`
  - `klubz-production`
- D1 database created and bound
- Required secrets configured in Pages settings

Production runtime validation requirements (fail-closed):
- `JWT_SECRET` must be present and at least 32 characters
- `ENCRYPTION_KEY` must be a 64-character hex string
- `APP_URL` must be a valid absolute URL

## 2. Quality Gates (Mandatory)

Run before any deployment:

```bash
npm run db:check-migrations
npm run type-check
npm run lint
npm test
npm run build
```

Optional deep local check (may be sandbox-restricted):

```bash
npm run db:smoke
```

## 3. Staging Deployment

```bash
npm run deploy:staging
curl https://klubz-staging.pages.dev/health
```

Validate core flows on staging:
- auth register/login/logout
- trip offer/book/accept/reject/cancel
- payment intent + webhook transitions
- monitoring endpoints for admin users

## 4. Production Deployment

```bash
npm run deploy:prod
curl https://klubz-production.pages.dev/health
```

Post-deploy checks:
- No sustained `type=unhandled` log spikes
- Metrics and security endpoints return expected shapes
- Payment webhook events process without signature/configuration errors
- `/health` returns `200` (runtime configuration guard passes)

## 5. Rollback and Recovery

Use Cloudflare Pages deployment history to roll back to last healthy release.

After rollback:
- verify `/health`
- verify one representative request per critical module
- record incident timeline and corrective actions

For migration failures, follow `MIGRATION_GUIDE.md` and fix forward with a new migration.

## 6. Security and Compliance Notes

- Keep all secrets in runtime secret storage only.
- Never commit credentials.
- Preserve audit and observability contracts in tests.
- Respect data export/deletion obligations for POPIA/GDPR flows.

## 7. Related Documents

- `docs/OPERATIONS_RUNBOOK.md`
- `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md`
- `MIGRATION_GUIDE.md`
- `docs/ROUTE_AUTHZ_MATRIX.md`
- `codex.md`
