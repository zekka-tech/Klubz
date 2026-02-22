# Environment Variables Configuration

This document describes all environment variables required and optional for the Klubz application.

## Required Variables

### JWT_SECRET
- **Type**: String (64 hex characters)
- **Description**: Secret key for signing JWT tokens (access and refresh tokens)
- **Generation**: `openssl rand -hex 32`
- **Security**: CRITICAL - Must be unique per environment, never commit to git
- **Example**: `8aaf4a5c68badd52531455df8d01767bfa5dc81c3d737e6c125f8c556b984586`

### ENCRYPTION_KEY
- **Type**: String (64 hex characters)
- **Description**: AES-256-GCM encryption key for PII (names, phones, locations)
- **Generation**: `openssl rand -hex 32`
- **Security**: CRITICAL - Loss of this key = cannot decrypt existing data
- **Example**: `5b05c13ef1d704917c4fa0f4cfa56fc04a33658617491d5de13e31739a73550e`

## Optional Service Variables

### Stripe Payment Processing
- `STRIPE_SECRET_KEY` - Stripe secret key (sk_test_... for test, sk_live_... for production)
- `STRIPE_WEBHOOK_SECRET` - Webhook signing secret (whsec_...)
- **Required for**: Payment processing
- **Setup**: https://dashboard.stripe.com/apikeys

### SendGrid Email
- `SENDGRID_API_KEY` - SendGrid API key (SG....)
- **Required for**: Email notifications (booking confirmations, trip reminders)
- **Setup**: https://app.sendgrid.com/settings/api_keys

### Twilio SMS
- `TWILIO_ACCOUNT_SID` - Twilio account SID (AC...)
- `TWILIO_AUTH_TOKEN` - Twilio auth token
- `TWILIO_PHONE_NUMBER` - Twilio phone number (E.164 format: +1...)
- **Required for**: SMS notifications
- **Setup**: https://console.twilio.com/

### Google OAuth (Sign in with Google)
- `GOOGLE_CLIENT_ID` - OAuth 2.0 Client ID (ends in `.apps.googleusercontent.com`)
- `GOOGLE_CLIENT_SECRET` - OAuth 2.0 Client Secret
- **Required for**: "Continue with Google" sign-in on the login screen
- **Setup**:
  1. Go to https://console.cloud.google.com/apis/credentials
  2. Create an **OAuth 2.0 Client ID** (application type: Web application)
  3. Add **Authorised JavaScript origins**: `https://klubz-production.pages.dev`
  4. Add **Authorised redirect URIs**: `https://klubz-production.pages.dev/api/auth/google/callback`
  5. For staging: also add `https://klubz-staging.pages.dev/api/auth/google/callback`
- **Secrets setup**:
  ```bash
  wrangler pages secret put GOOGLE_CLIENT_ID --project-name=klubz-production
  wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=klubz-production
  ```
- **Note**: If not configured, the Google button returns a 503 and users fall back to email/password login.

## Environment-Specific Variables

### NODE_ENV
- **Values**: `development`, `staging`, `production`
- **Default**: `development`
- **Description**: Controls logging level and error verbosity

### LOG_LEVEL
- **Values**: `debug`, `info`, `warn`, `error`, `fatal`
- **Default**: `info` (production), `debug` (development)
- **Description**: Minimum log level to output

## Configuration by Environment

### Local Development (.dev.vars)

```bash
JWT_SECRET="<generated-secret>"
ENCRYPTION_KEY="<generated-key>"
NODE_ENV="development"
LOG_LEVEL="debug"

# Optional: Add if testing payments/notifications
# STRIPE_SECRET_KEY="sk_test_..."
# SENDGRID_API_KEY="SG...."
```

### Cloudflare Pages (Staging)

```bash
# Configure via Cloudflare dashboard or CLI
wrangler pages secret put JWT_SECRET --project-name=klubz-staging
wrangler pages secret put ENCRYPTION_KEY --project-name=klubz-staging

# Optional services
wrangler pages secret put STRIPE_SECRET_KEY --project-name=klubz-staging
wrangler pages secret put SENDGRID_API_KEY --project-name=klubz-staging
```

### Cloudflare Pages (Production)

```bash
# CRITICAL: Use different secrets than staging!
wrangler pages secret put JWT_SECRET --project-name=klubz-production
wrangler pages secret put ENCRYPTION_KEY --project-name=klubz-production

# Production services (use live keys)
wrangler pages secret put STRIPE_SECRET_KEY --project-name=klubz-production  # sk_live_...
wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name=klubz-production
wrangler pages secret put SENDGRID_API_KEY --project-name=klubz-production
wrangler pages secret put TWILIO_ACCOUNT_SID --project-name=klubz-production
wrangler pages secret put TWILIO_AUTH_TOKEN --project-name=klubz-production
wrangler pages secret put TWILIO_PHONE_NUMBER --project-name=klubz-production
```

## Security Best Practices

1. **Never commit secrets to git** - `.dev.vars` is already in `.gitignore`
2. **Use different secrets per environment** - Staging and production must have unique JWT_SECRET and ENCRYPTION_KEY
3. **Rotate secrets periodically** - Especially after team member departures
4. **Key backup** - Store ENCRYPTION_KEY securely - losing it means losing all encrypted data
5. **Test mode first** - Use Stripe test keys (sk_test_...) before production
6. **Environment variable validation** - Application now fails fast if JWT_SECRET is missing

## Troubleshooting

### Error: "JWT_SECRET environment variable is required"
- **Cause**: JWT_SECRET not configured
- **Fix**: Add JWT_SECRET to `.dev.vars` (local) or Cloudflare Pages secrets (staging/production)

### Error: "Database not configured"
- **Cause**: DB binding missing in wrangler.toml
- **Fix**: Ensure `[[d1_databases]]` binding exists and database is created

### Encrypted fields showing null
- **Cause**: Wrong ENCRYPTION_KEY or data encrypted with different key
- **Fix**: Verify ENCRYPTION_KEY matches the one used to encrypt data (cannot recover if lost)

## Migration Notes

### Changing ENCRYPTION_KEY
**WARNING**: Changing ENCRYPTION_KEY requires re-encrypting ALL existing encrypted data. DO NOT change in production without migration plan:

1. Read all encrypted records with old key
2. Decrypt with old key
3. Re-encrypt with new key
4. Update records
5. Deploy with new ENCRYPTION_KEY

See `migrations/reencrypt-data.ts` for automated migration script (create if needed).

### Changing JWT_SECRET
- Invalidates all existing JWT tokens
- Users will need to log in again
- Safe to change, but causes session disruption
- Recommended: Change during maintenance window

## Checklist

Before deploying to production:
- [ ] JWT_SECRET generated (64 hex chars, unique per environment)
- [ ] ENCRYPTION_KEY generated (64 hex chars, unique per environment)
- [ ] ENCRYPTION_KEY backed up securely (password manager, vault)
- [ ] Stripe keys configured (sk_live_... for production)
- [ ] SendGrid API key configured and domain verified
- [ ] Twilio credentials configured and phone number verified
- [ ] All secrets different from staging
- [ ] Test with .dev.vars locally before deploying
