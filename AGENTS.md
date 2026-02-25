# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`:
- `src/routes/` for HTTP route handlers
- `src/middleware/` for cross-cutting request logic (auth, guards)
- `src/lib/` for shared domain/services (e.g., pricing, db, matching)
- `src/integrations/` for external providers (Stripe, notifications)

Tests are in `tests/` (`unit/`, `integration/`) and repo checks like `tests/security-audit.js` and `tests/performance-test.js`.  
Database migrations are in `migrations/`.  
Operational docs are in `docs/` and root runbooks such as `DEPLOYMENT.md`.

## Build, Test, and Development Commands
- `npm run dev` - start local Vite dev server.
- `npm run build` - production build to `dist/`.
- `npm run lint` - run ESLint over TypeScript in `src/`.
- `npm run type-check` - strict TypeScript check without emit.
- `npm test` - run Vitest unit + integration tests.
- `npm run test:coverage` - run tests with coverage thresholds.
- `npm run verify` - full local gate (`type-check`, `lint`, `test`, `build`).
- `npm run verify:ci` - CI gate including migration/order smoke checks.
- `npm run db:check-migrations && npm run db:smoke` - required before DB-related merges.

## Coding Style & Naming Conventions
Use TypeScript (ES modules) with strict typing (`tsconfig.json` has `"strict": true`).  
Follow existing style: 2-space indentation, semicolons, single quotes, and `camelCase` for variables/functions.  
Use `PascalCase` for types/interfaces and keep files domain-focused (for example `src/routes/trips.ts`, `src/lib/matching/engine.ts`).  
Prefer small, single-purpose functions and error handling.

## Testing Guidelines
Primary framework is Vitest (`vitest.config.ts`) with coverage thresholds set to 70% for lines/functions/branches/statements.  
Name tests `*.test.ts` and place them under `tests/unit/` or `tests/integration/`.  
Run targeted suites during development: `npm run test:unit`, `npm run test:integration`.  
Before PR submission, run `npm run verify`.

## Workflow (Zekka-Aligned)
Use branch prefixes aligned with Zekka conventions: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`.  
Keep PRs small and focused; rebase on `main` before opening.

## Commit & Pull Request Guidelines
Use Conventional Commits (optionally scoped), e.g. `feat(trips): add monthly fare calculation`, `fix(auth): harden token validation`.  
Prefer types used in history: `feat`, `fix`, `chore`, `refactor`, `security`, `docs`, `test`.  
Keep commits atomic; include tightly coupled migration/config changes.  
PRs should include:
- concise problem/solution summary
- linked issue/ticket (if available)
- test evidence (`npm run verify` or `npm run verify:ci`)
- docs updates when behavior/contracts change
- screenshots or request/response examples for UI/API behavior changes

## Security & Configuration Tips
Never commit secrets; use `.dev.vars` locally and keep `.env.example` as the required-variable contract.  
For data-layer changes, run migration order and smoke checks before merge.
