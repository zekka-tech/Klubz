# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Klubz** is a POPIA/GDPR-compliant enterprise carpooling platform built on **Cloudflare Pages + Workers** using the **Hono** framework. It uses Cloudflare D1 (SQLite) for persistence, three KV namespaces (CACHE, RATE_LIMIT_KV, SESSIONS), and integrates Stripe, SendGrid, Twilio, and Mapbox.

## Common Commands

```bash
# Development
npm run dev:cloudflare       # Wrangler Pages dev server (localhost:3000)

# Quality gates (run before any commit)
npm run type-check           # TypeScript strict check
npm run lint                 # ESLint
npm run lint:fix             # Auto-fix lint issues
npm test                     # All unit + integration tests (Vitest)
npm run verify               # Full local gate: type-check + lint + test + build

# Run a single test file
npx vitest run tests/unit/encryption.test.ts

# Testing
npm run test:unit            # Unit tests only
npm run test:integration     # Integration contracts only
npm run test:e2e             # Playwright end-to-end
npm run test:all             # Full suite including load + security

# Database
npm run db:check-migrations  # Validate migration numbering/order
npm run db:migrate:local     # Apply migrations to local D1
npm run db:reset             # Nuke and rebuild local DB
npm run db:seed              # Load sample data

# Deployment
npm run deploy:staging       # Build + deploy to klubz-staging
npm run deploy:prod          # Build + deploy to klubz-production
```

## Architecture

```
src/
├── index.tsx          # App entry: Hono setup, middleware stack, route mounting
├── types.ts           # Central type registry (Bindings, AuthUser, DB rows, API types)
├── renderer.tsx       # HTML renderer for PWA shell
├── routes/            # Route modules (auth, users, trips, matching, payments, admin, monitoring, notifications)
├── middleware/        # auth, rateLimiter, auditLogger, errorHandler, security
├── lib/               # Core utilities: db, cache, encryption, errors, eventBus, matching/
└── integrations/      # Stripe, SendGrid/Twilio, Mapbox (Workers-compatible REST clients, no Node SDKs)
```

### Request Lifecycle

Requests flow through: CORS → Security Headers → Request Logger → Rate Limiter → JWT Auth → Route Handler → Error Handler

- Rate limits: 120 req/60s per IP (API), 5 req/15min (auth endpoints)
- JWT uses Web Crypto HMAC-SHA256 (no external library); access tokens expire in 1hr, refresh tokens in 30 days
- Production fails closed if `JWT_SECRET` (<32 chars), `ENCRYPTION_KEY` (not 64-char hex), or `APP_URL` is missing

### Database & Migrations

Migrations live in `/migrations/` and must be sequentially numbered with no gaps or duplicates. Run `npm run db:check-migrations` to validate the current sequence and next version before deploying. Use prepared statements via `getDB(c)` from `src/lib/db.ts`.

### Encryption

PII fields (names, phone, addresses, vehicle details) are encrypted with AES-256-GCM via Web Crypto. Encrypted format: `{ ct: base64, iv: base64, v: 1 }`. Always pass `userId` as Additional Authenticated Data (AAD) where applicable. The `ENCRYPTION_KEY` is a 64-char hex string stored as a Cloudflare secret.

### Auth & Authorization

- Three roles: `user`, `admin`, `super_admin`
- Middleware factories: `authMiddleware(roles?)`, `adminMiddleware()`, `anyAuthMiddleware()`
- Ownership checks are done inline in route handlers (trip driver check, booking requester check)
- Passwords hashed with bcryptjs (10 rounds); MFA uses TOTP via speakeasy
- See `docs/ROUTE_AUTHZ_MATRIX.md` for the full per-endpoint authorization matrix

### Smart Matching

Multi-phase pipeline in `src/lib/matching/`: hard filters (availability/time) → geometric proximity (haversine detour) → weighted scoring (detour %, carbon savings, rating bias). Results are deterministic and include a score breakdown.

### KV Namespaces

| Binding | Purpose |
|---|---|
| `CACHE` | General response caching (admin stats, etc.) |
| `RATE_LIMIT_KV` | Cross-isolate rate limit counters |
| `SESSIONS` | Session token storage |

### Audit Logging

All security/business events (USER_LOGIN, DATA_EXPORT, PAYMENT_*, MATCH_*, etc.) are written to the `audit_logs` table via `src/middleware/auditLogger.ts`. Sensitive fields are AES-encrypted before insert.

### Real-Time Events

SSE endpoint at `/api/events` uses the in-memory `EventBus` (`src/lib/eventBus.ts`). Emit events from routes; the SSE handler filters visibility per user.

## Key Conventions

- **Route pattern**: Create a `new Hono<AppEnv>()`, apply middleware, export named; mount in `src/index.tsx`
- **DB queries**: Always use `getDB(c).prepare(...).bind(...).first<T>()` or `.all<T>()`
- **Errors**: Throw `AppError` from `src/lib/errors.ts`; the global handler formats the response
- **Validation**: Use Zod schemas from `src/lib/validation.ts` for all request bodies and query params
- **No Node.js-only packages**: All code runs on Cloudflare Workers; use Web APIs and Workers-compatible libraries
- **codex.md**: Project continuity ledger — update after significant changes (completed work, remaining priorities)

## Testing Conventions

Integration tests in `tests/integration/` are *contract tests* — they verify security boundaries, authorization rules, and audit schemas rather than full DB integration. Unit tests cover pure utilities. Always run `npm run verify` before pushing.

## CI/CD Gates

CI runs in order: migration smoke → type-check → lint → test → build. All gates must pass before merging. See `.github/workflows/ci.yml`.

## Key Docs

- `docs/ROUTE_AUTHZ_MATRIX.md` — Authorization boundaries per endpoint
- `docs/PAYMENT_WEBHOOK_THREAT_MODEL.md` — Webhook security threat model
- `docs/OPERATIONS_RUNBOOK.md` — Incident response (SEV-1 to SEV-4)
- `docs/ENVIRONMENT.md` — All environment variable definitions
- `DEPLOYMENT.md` — Full staging → production deployment procedure
- `MIGRATION_GUIDE.md` — How to create and apply DB migrations
