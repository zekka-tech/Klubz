# Route Authorization Matrix

Last updated: 2026-02-18

This matrix defines expected authorization boundaries for API route groups and the contract tests that enforce them.

| Route Group | Example Endpoints | Access Policy | Contract Coverage |
| --- | --- | --- | --- |
| Public health/info | `GET /health`, `GET /api/hello` | Public (no JWT) | `tests/integration/route-authz-contracts.test.ts` |
| Auth | `/api/auth/*` | Public for login/register/refresh; route-specific controls | Existing auth route tests |
| User | `/api/users/*` | Authenticated user required | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/user-preferences.test.ts` |
| Trips | `/api/trips/*` | Authenticated user required; owner checks for write transitions | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/security-hardening.test.ts` |
| Payments | `POST /api/payments/intent` | Authenticated user required | `tests/integration/security-hardening.test.ts` |
| Payments webhook | `POST /api/payments/webhook` | Public callback endpoint (Stripe signature validated) | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/security-hardening.test.ts` |
| Notifications | `/api/notifications/*` | Authenticated user required | `tests/integration/notifications-routes.test.ts` |
| Matching | `/api/matching/*` | Authenticated required; owner/admin checks on protected resources; admin-only for batch/config-write/stats | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/security-hardening.test.ts` |
| Monitoring | `/api/monitoring/sla`, `/performance`, `/errors`, `/carbon`, `/alerts` | Authenticated user required | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/security-hardening.test.ts` |
| Monitoring admin | `/api/monitoring/security`, `/metrics` | Admin or super_admin only | `tests/integration/route-authz-contracts.test.ts`, `tests/integration/security-hardening.test.ts` |
| Admin | `/api/admin/*` | Admin or super_admin only | `tests/integration/route-authz-contracts.test.ts` |

## Enforcement Notes

- Every authz hardening change must include test coverage updates in at least one integration contract suite.
- New route groups must be added to this matrix in the same pull request that introduces them.
- Contract tests focus on access boundaries (`200/400` vs `401/403`) and avoid business-logic coupling.
