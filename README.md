# Klubz

Enterprise carpooling platform built on Hono + Cloudflare, with production hardening for authz boundaries, payment/webhook integrity, and operational observability.

## Current Engineering Status

- Type-check, lint, test, and build gates are enforced in CI.
- Integration contracts cover security-critical route authz and payment transition behavior.
- Structured handled/unhandled telemetry contracts are tested.
- Migration order/policy checks are automated.

## Quick Start

```bash
npm install
npm run dev
```

Build and run gates:

```bash
npm run type-check
npm run lint
npm test
npm run build
```

## Scripts

Core development:
- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run type-check`
- `npm test`

Database:
- `npm run db:check-migrations`
- `npm run db:migrate:local`
- `npm run db:smoke`

Deploy:
- `npm run deploy:staging`
- `npm run deploy:prod`

## Operations and Deployment Docs

- `DEPLOYMENT.md`
- `MIGRATION_GUIDE.md`
- `docs/OPERATIONS_RUNBOOK.md`
- `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md`
- `docs/ROUTE_AUTHZ_MATRIX.md`
- `codex.md`

## Tech Stack

- API framework: Hono
- Runtime/deploy: Cloudflare Pages + Workers
- Database: Cloudflare D1
- Cache/kv: Cloudflare KV
- Validation: Zod
- Testing: Vitest

## Security and Compliance

- JWT auth with role-based + organization-scoped authorization
- Encryption and privacy controls for sensitive fields
- Audit logging for critical security/business transitions
- POPIA/GDPR user-data workflows (export/delete)
