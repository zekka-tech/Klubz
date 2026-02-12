# Klubz Deployment Guide

## Pre-Deployment Checklist

### ✅ Completed (Ready for Deployment)
- [x] All 6 CRITICAL security vulnerabilities eliminated
- [x] Hardcoded secrets removed
- [x] GDPR/POPIA compliance implemented
- [x] Smart matching engine integrated
- [x] Stripe payment processing implemented
- [x] Email/SMS notifications wired up
- [x] Performance optimizations (caching, indexes, query optimization)
- [x] IP anonymization for privacy compliance
- [x] Real monitoring metrics
- [x] 22 unit tests passing
- [x] TypeScript type checking enabled

### ⚠️ Known Issues (Non-Blocking)
- ESLint warnings for `any` types (96 warnings) - Technical debt, not runtime issues
- Moderate severity esbuild vulnerability in **dev dependencies only** (vitest)
- Old test files (api.test.js, comprehensive.test.js) need cleanup

## Environment Setup

### 1. Generate Secrets

```bash
# Generate JWT secret (64 hex characters)
openssl rand -hex 32

# Generate encryption key (64 hex characters)
openssl rand -hex 32
```

### 2. Configure Local Development

Create `.dev.vars` (already exists):
```bash
JWT_SECRET="<generated-jwt-secret>"
ENCRYPTION_KEY="<generated-encryption-key>"
NODE_ENV="development"
LOG_LEVEL="debug"

# Optional: Payment processing
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# Optional: Notifications
SENDGRID_API_KEY="SG...."
TWILIO_ACCOUNT_SID="AC...."
TWILIO_AUTH_TOKEN="..."
TWILIO_PHONE_NUMBER="+1..."
```

### 3. Configure Cloudflare Pages Secrets

```bash
# Production
wrangler pages secret put JWT_SECRET --project-name=klubz-production
wrangler pages secret put ENCRYPTION_KEY --project-name=klubz-production

# Optional: Add payment/notification secrets
wrangler pages secret put STRIPE_SECRET_KEY --project-name=klubz-production
wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name=klubz-production
wrangler pages secret put SENDGRID_API_KEY --project-name=klubz-production
wrangler pages secret put TWILIO_ACCOUNT_SID --project-name=klubz-production
wrangler pages secret put TWILIO_AUTH_TOKEN --project-name=klubz-production
wrangler pages secret put TWILIO_PHONE_NUMBER --project-name=klubz-production

# Staging (same commands with --project-name=klubz-staging)
wrangler pages secret put JWT_SECRET --project-name=klubz-staging
wrangler pages secret put ENCRYPTION_KEY --project-name=klubz-staging
```

## Database Migrations

### Local Development
```bash
# Apply migrations to local D1
wrangler d1 migrations apply klubz-db-prod --local

# Verify
wrangler d1 execute klubz-db-prod --local --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### Production
```bash
# List pending migrations
wrangler d1 migrations list klubz-db-prod --remote

# Apply migrations
wrangler d1 migrations apply klubz-db-prod --remote

# Verify migrations
wrangler d1 execute klubz-db-prod --remote --command "SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' LIMIT 10"
```

## Build & Deploy

### Staging Deployment
```bash
# Build
npm run build

# Deploy to staging
npm run deploy:staging

# Verify health
curl https://klubz-staging.pages.dev/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-12T...",
  "version": "3.0.0",
  "environment": "staging",
  "features": {
    "matching": true,
    "realtime": true,
    "pwa": true,
    "encryption": true,
    "mfa": true
  }
}
```

### Production Deployment
```bash
# Final verification
npm run test              # 22 tests should pass
npm audit                 # Only dev dependencies should show issues
npm run type-check        # Should pass

# Build for production
npm run build:prod

# Deploy
npm run deploy:prod

# Verify
curl https://klubz-production.pages.dev/health
```

## Post-Deployment Verification

### 1. Critical Path Testing

```bash
# Test authentication
curl -X POST https://klubz-production.pages.dev/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!",
    "name": "Test User"
  }'

# Test login
curl -X POST https://klubz-production.pages.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!"
  }'
```

### 2. Admin Dashboard
- Access https://klubz-production.pages.dev/admin
- Login with admin credentials
- Verify metrics endpoint shows real data

### 3. Monitoring (First 24 Hours)
```bash
# Monitor logs
wrangler pages deployment tail --project-name=klubz-production

# Check error rates
# Access: https://klubz-production.pages.dev/api/monitoring/metrics
# (Requires admin authentication)
```

## Rollback Procedure

### If Issues Occur:
```bash
# List recent deployments
wrangler pages deployment list --project-name=klubz-production

# Rollback to previous deployment
wrangler pages deployment tail <PREVIOUS_DEPLOYMENT_ID>
```

### Database Rollback:
```bash
# Rollback specific migration (if needed)
wrangler d1 migrations apply klubz-db-prod --remote --down

# WARNING: This may cause data loss. Backup first!
```

## Performance Targets

- **Availability**: > 99.8%
- **Response Time (p95)**: < 500ms
- **Error Rate**: < 0.1%
- **Rate Limit**: 120 requests/minute per IP

## Security Checklist

- [x] No hardcoded secrets in code
- [x] JWT_SECRET and ENCRYPTION_KEY configured
- [x] HTTPS enforced (Cloudflare automatic)
- [x] CORS restricted to whitelisted origins
- [x] CSP headers with nonce (no unsafe-inline)
- [x] Rate limiting active (120 req/min)
- [x] IP addresses anonymized in logs
- [x] MFA endpoint disabled until properly implemented
- [x] Admin routes require admin role

## GDPR/POPIA Compliance

- [x] Data export endpoint: GET /api/users/export
- [x] Account deletion endpoint: DELETE /api/users/account
- [x] IP anonymization (last octet zeroed)
- [x] 30-day retention period for deleted data
- [x] Audit logging for all data access

## Support & Monitoring

### Logs
- Cloudflare Dashboard: https://dash.cloudflare.com/
- Wrangler CLI: `wrangler pages deployment tail`

### Metrics
- Admin dashboard: https://klubz-production.pages.dev/admin
- Metrics API: GET /api/monitoring/metrics (admin only)
- Security dashboard: GET /api/monitoring/security (admin only)

### Alerts
Configure Cloudflare alerts for:
- Error rate > 1%
- Response time > 1000ms
- Failed login attempts > 100/hour

## Contact

- Development Team: dev@klubz.com
- Security Issues: security@klubz.com
- GitHub: https://github.com/zekka-tech/Klubz
