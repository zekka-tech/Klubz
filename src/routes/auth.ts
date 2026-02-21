/**
 * Klubz - Auth Routes (Production D1)
 *
 * Real D1 queries for login, register, refresh, logout.
 * Uses bcrypt password hashing (Workers-compatible via encryption.ts).
 * JWT issued via auth middleware helpers.
 *
 * Security:
 *   - Refresh tokens are tracked in the sessions table (SHA-256 hash)
 *     and rotated on every use (prevents replay / stolen token reuse)
 *   - Email verification is enforced before login is permitted
 *   - Password reset uses short-lived KV tokens (1h TTL)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { createToken, verifyToken, issueTokenPair } from '../middleware/auth';
import { hashPassword, verifyPassword, hashForLookup, isLegacyHash, encryptPII, safeDecryptPII } from '../lib/encryption';
import { logger } from '../lib/logger';
import { getDBOptional } from '../lib/db';
import { getAnonymizedIP, getUserAgent } from '../lib/http';
import { withRequestContext } from '../lib/observability';
import { NotificationService } from '../integrations/notifications';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  rememberMe: z.boolean().optional(),
}).strict();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  phone: z.string().optional(),
  organizationId: z.string().optional(),
  role: z.enum(['passenger', 'driver']).optional(),
}).strict();

const forgotPasswordSchema = z.object({
  email: z.string().email(),
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().min(32),
  newPassword: z.string().min(8),
}).strict();


interface LoginUserRow {
  id: number;
  email: string;
  password_hash: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  role: string;
  is_active: number;
  email_verified: number;
  mfa_enabled: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the error is a "table not found" D1 error — signals dev mode without migrations */
function isTableMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return msg.includes('no such table') || msg.includes('SQLITE_ERROR');
}

function getJWTSecret(c: { env?: { JWT_SECRET?: string } }): string {
  const secret = c.env?.JWT_SECRET;
  if (!secret) {
    logger.fatal('JWT_SECRET not configured - application cannot start securely');
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

/**
 * SHA-256 hash a token string → lowercase hex.
 * Used to store refresh/reset/verification tokens safely in DB or KV.
 */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a cryptographically random URL-safe hex token (32 bytes = 256 bits).
 */
function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** SESSIONS KV prefix for email verification tokens */
const KV_EMAIL_VERIFY_PREFIX = 'ev:';
/** SESSIONS KV prefix for password reset tokens */
const KV_PWD_RESET_PREFIX = 'pr:';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const authRoutes = new Hono<AppEnv>();

// ── Login ──────────────────────────────────────────────────────────────────

authRoutes.post('/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid credentials' } }, 400);
  }

  const { email, password } = parsed.data;
  const db = getDBOptional(c);
  const secret = getJWTSecret(c);

  // ── Real D1 path ──
  if (db) {
    try {
      const emailHash = await hashForLookup(email);

      const user = await db
        .prepare('SELECT id, email, password_hash, first_name_encrypted, last_name_encrypted, role, is_active, email_verified, mfa_enabled FROM users WHERE email_hash = ? AND deleted_at IS NULL')
        .bind(emailHash)
        .first<LoginUserRow>();

      if (!user) {
        return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid email or password' } }, 401);
      }

      if (!user.is_active) {
        return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Account is deactivated' } }, 401);
      }

      // Verify password (bcrypt, with legacy PBKDF2 fallback)
      const passwordValid = await verifyPassword(password, user.password_hash as string);
      if (!passwordValid) {
        return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid email or password' } }, 401);
      }

      // Enforce email verification
      if (!user.email_verified) {
        return c.json({
          error: {
            code: 'EMAIL_UNVERIFIED',
            message: 'Please verify your email address before logging in. Check your inbox for a verification link.',
          },
        }, 403);
      }

      // Re-hash legacy PBKDF2 passwords to bcrypt on successful login
      if (isLegacyHash(user.password_hash as string)) {
        try {
          const newHash = await hashPassword(password);
          await db
            .prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .bind(newHash, user.id)
            .run();
          logger.info('Migrated legacy PBKDF2 hash to bcrypt', withRequestContext(c, { userId: user.id }));
        } catch { /* best-effort re-hash */ }
      }

      // Update last login
      await db
        .prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(user.id)
        .run();

      const encKey = c.env?.ENCRYPTION_KEY;
      const decryptedFirst = await safeDecryptPII(user.first_name_encrypted, encKey, user.id);
      const decryptedLast = await safeDecryptPII(user.last_name_encrypted, encKey, user.id);
      const userName = [decryptedFirst, decryptedLast].filter(Boolean).join(' ') || email.split('@')[0];

      const { accessToken, refreshToken } = await issueTokenPair(
        {
          id: user.id as number,
          email: user.email as string,
          name: userName,
          role: user.role as string,
          organizationId: undefined,
        },
        secret,
      );

      // Store refresh token hash in sessions table for rotation tracking
      try {
        const tokenHash = await hashToken(refreshToken);
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
        await db
          .prepare(`INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(sessionId, user.id, tokenHash, getAnonymizedIP(c), getUserAgent(c), expiresAt)
          .run();
      } catch { /* session tracking is best-effort; auth still succeeds */ }

      // Log audit
      try {
        await db
          .prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(
            user.id,
            'USER_LOGIN',
            'user',
            user.id,
            getAnonymizedIP(c),
            getUserAgent(c),
          )
          .run();
      } catch { /* audit log is best-effort */ }

      return c.json({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: userName,
          role: user.role,
          mfaEnabled: !!user.mfa_enabled,
        },
      });
    } catch (err: unknown) {
      if (!isTableMissing(err)) {
        logger.error('Login DB error', err instanceof Error ? err : undefined, {
          ...withRequestContext(c),
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Login failed' } }, 500);
      }
      logger.error('Login denied because auth tables are unavailable', err instanceof Error ? err : undefined, {
        ...withRequestContext(c),
        environment: c.env?.ENVIRONMENT || 'unknown',
      });
      return c.json(
        { error: { code: 'CONFIGURATION_ERROR', message: 'Authentication service unavailable' } },
        500,
      );
    }
  }

  logger.error('Login denied because DB is unavailable', undefined, {
    ...withRequestContext(c),
    environment: c.env?.ENVIRONMENT || 'unknown',
  });
  return c.json(
    { error: { code: 'CONFIGURATION_ERROR', message: 'Authentication service unavailable' } },
    500,
  );
});

// ── Register ───────────────────────────────────────────────────────────────

authRoutes.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Missing required fields' } }, 400);
  }

  const { email, password, name, phone } = parsed.data;
  const db = getDBOptional(c);

  // ── Real D1 path ──
  if (db) {
    try {
      const emailHash = await hashForLookup(email);

      // Check if email already exists
      const existing = await db
        .prepare('SELECT id FROM users WHERE email_hash = ? AND deleted_at IS NULL')
        .bind(emailHash)
        .first<{ id: number }>();

      if (existing) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Email already registered' } }, 409);
      }

      // Hash password with bcrypt (12 rounds)
      const passwordHash = await hashPassword(password);
      const [firstName, ...lastParts] = name.split(' ');
      const lastName = lastParts.join(' ') || null;
      const ip = getAnonymizedIP(c);

      const result = await db
        .prepare(
          `INSERT INTO users (email, email_hash, password_hash, first_name_encrypted, last_name_encrypted, phone_encrypted, role, is_active, email_verified, created_ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, FALSE, ?)`
        )
        .bind(email, emailHash, passwordHash, firstName, lastName, phone || null, 'user', ip)
        .run();

      const userId = Number(result?.meta?.last_row_id ?? 0);

      // Encrypt PII now that we have the userId (best-effort; non-fatal if key is absent)
      const encKey = c.env?.ENCRYPTION_KEY;
      if (encKey && userId > 0) {
        try {
          const encFirst = firstName ? await encryptPII(firstName, encKey, userId) : null;
          const encLast = lastName ? await encryptPII(lastName, encKey, userId) : null;
          const encPhone = phone ? await encryptPII(phone, encKey, userId) : null;
          await db
            .prepare('UPDATE users SET first_name_encrypted = ?, last_name_encrypted = ?, phone_encrypted = ? WHERE id = ?')
            .bind(encFirst, encLast, encPhone, userId)
            .run();
        } catch { /* best-effort — account created, PII encryption non-fatal */ }
      }

      // Send email verification (best-effort; registration succeeds regardless)
      try {
        const verifyToken = generateSecureToken();
        const tokenHash = await hashToken(verifyToken);
        const kv = c.env?.SESSIONS;
        if (kv) {
          await kv.put(
            `${KV_EMAIL_VERIFY_PREFIX}${tokenHash}`,
            JSON.stringify({ userId, email }),
            { expirationTtl: 86400 }, // 24 hours
          );

          const appUrl = c.env?.APP_URL || 'https://klubz.com';
          const notif = new NotificationService(c.env);
          const sg = notif.getSendGrid();
          if (sg) {
            await sg.sendVerificationEmail(
              email,
              firstName,
              `${appUrl}/api/auth/verify-email?token=${verifyToken}`,
            );
          }
        }
      } catch { /* non-fatal */ }

      // Log audit
      try {
        await db
          .prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(userId, 'USER_REGISTER', 'user', userId, ip, getUserAgent(c))
          .run();
      } catch { /* best-effort */ }

      return c.json({
        message: 'Registration successful. Please check your email to verify your account.',
        userId,
      });
    } catch (err: unknown) {
      if (!isTableMissing(err)) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Registration DB error', err instanceof Error ? err : undefined, {
          ...withRequestContext(c),
          error: message,
        });
        if (message.includes('UNIQUE')) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Email already registered' } }, 409);
        }
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } }, 500);
      }
      logger.error('Registration denied because auth tables are unavailable', err instanceof Error ? err : undefined, {
        ...withRequestContext(c),
        environment: c.env?.ENVIRONMENT || 'unknown',
      });
      return c.json(
        { error: { code: 'CONFIGURATION_ERROR', message: 'Authentication service unavailable' } },
        500,
      );
    }
  }

  logger.error('Registration denied because DB is unavailable', undefined, {
    ...withRequestContext(c),
    environment: c.env?.ENVIRONMENT || 'unknown',
  });
  return c.json(
    { error: { code: 'CONFIGURATION_ERROR', message: 'Authentication service unavailable' } },
    500,
  );
});

// ── Email Verification ─────────────────────────────────────────────────────

authRoutes.get('/verify-email', async (c) => {
  const token = c.req.query('token');
  if (!token || token.length < 32) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid verification token' } }, 400);
  }

  const kv = c.env?.SESSIONS;
  if (!kv) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Verification service unavailable' } }, 500);
  }

  try {
    const tokenHash = await hashToken(token);
    const raw = await kv.get(`${KV_EMAIL_VERIFY_PREFIX}${tokenHash}`);
    if (!raw) {
      return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Verification link is invalid or has expired' } }, 400);
    }

    const { userId } = JSON.parse(raw) as { userId: number; email: string };
    const db = getDBOptional(c);
    if (db) {
      await db
        .prepare('UPDATE users SET email_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(userId)
        .run();
    }

    // Invalidate token immediately after use
    await kv.delete(`${KV_EMAIL_VERIFY_PREFIX}${tokenHash}`);

    // Redirect to login page with success flag (works for both PWA and browser)
    const appUrl = c.env?.APP_URL || 'https://klubz.com';
    return c.redirect(`${appUrl}/?verified=1#login`, 302);
  } catch (err) {
    logger.error('Email verification error', err instanceof Error ? err : undefined, withRequestContext(c));
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Verification failed' } }, 500);
  }
});

// ── Forgot Password ─────────────────────────────────────────────────────────

authRoutes.post('/forgot-password', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Valid email is required' } }, 400);
  }

  const { email } = parsed.data;

  // Always return success to prevent user enumeration
  const genericResponse = c.json({
    message: 'If that email is registered, you will receive a password reset link shortly.',
  });

  const db = getDBOptional(c);
  const kv = c.env?.SESSIONS;

  if (!db || !kv) return genericResponse;

  try {
    const emailHash = await hashForLookup(email);
    const user = await db
      .prepare('SELECT id FROM users WHERE email_hash = ? AND deleted_at IS NULL AND is_active = TRUE')
      .bind(emailHash)
      .first<{ id: number }>();

    if (!user) return genericResponse;

    const resetToken = generateSecureToken();
    const tokenHash = await hashToken(resetToken);
    await kv.put(
      `${KV_PWD_RESET_PREFIX}${tokenHash}`,
      JSON.stringify({ userId: user.id }),
      { expirationTtl: 3600 }, // 1 hour
    );

    const appUrl = c.env?.APP_URL || 'https://klubz.com';
    const notif = new NotificationService(c.env);
    const sg = notif.getSendGrid();
    if (sg) {
      await sg.sendEmail({
        to: email,
        subject: 'Reset your Klubz password',
        html: `
          <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px">
            <h1 style="color:#3B82F6">Password Reset</h1>
            <p>We received a request to reset your Klubz password.</p>
            <a href="${appUrl}/?token=${resetToken}#reset-password"
               style="display:inline-block;background:#3B82F6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
              Reset Password
            </a>
            <p style="color:#6B7280;font-size:0.875rem;margin-top:20px">
              This link expires in 1 hour. If you didn't request a reset, please ignore this email.
            </p>
          </div>
        `,
        text: `Reset your Klubz password: ${appUrl}/?token=${resetToken}#reset-password (expires in 1 hour)`,
      });
    }
  } catch (err) {
    logger.error('Forgot-password error', err instanceof Error ? err : undefined, withRequestContext(c));
  }

  return genericResponse;
});

// ── Reset Password ──────────────────────────────────────────────────────────

authRoutes.post('/reset-password', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Token and new password (min 8 chars) are required' } }, 400);
  }

  const { token, newPassword } = parsed.data;
  const kv = c.env?.SESSIONS;
  const db = getDBOptional(c);

  if (!kv || !db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Password reset service unavailable' } }, 500);
  }

  try {
    const tokenHash = await hashToken(token);
    const raw = await kv.get(`${KV_PWD_RESET_PREFIX}${tokenHash}`);
    if (!raw) {
      return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Reset link is invalid or has expired' } }, 400);
    }

    const { userId } = JSON.parse(raw) as { userId: number };

    // Invalidate token immediately (single-use)
    await kv.delete(`${KV_PWD_RESET_PREFIX}${tokenHash}`);

    const newHash = await hashPassword(newPassword);
    await db
      .prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(newHash, userId)
      .run();

    // Invalidate all existing sessions for this user
    await db
      .prepare('UPDATE sessions SET is_active = FALSE WHERE user_id = ?')
      .bind(userId)
      .run();

    // Log audit
    try {
      await db
        .prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, 'PASSWORD_RESET', 'user', userId, getAnonymizedIP(c), getUserAgent(c))
        .run();
    } catch { /* best-effort */ }

    return c.json({ message: 'Password reset successful. Please log in with your new password.' });
  } catch (err) {
    logger.error('Reset-password error', err instanceof Error ? err : undefined, withRequestContext(c));
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Password reset failed' } }, 500);
  }
});

// ── MFA Verify ─────────────────────────────────────────────────────────────

authRoutes.post('/mfa/verify', async (c) => {
  // MFA is not yet fully implemented. Use password authentication only.
  // To implement: Use speakeasy.totp.verify() with user's mfa_secret_encrypted
  return c.json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'MFA verification is not yet implemented. Please use password authentication.',
      status: 501
    }
  }, 501);
});

// ── Token Refresh ──────────────────────────────────────────────────────────

authRoutes.post('/refresh', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const refreshToken =
    typeof body === 'object' && body !== null && 'refreshToken' in body
      ? (body as { refreshToken?: string }).refreshToken
      : undefined;
  if (!refreshToken) {
    return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Refresh token required' } }, 401);
  }

  const secret = getJWTSecret(c);

  try {
    const payload = await verifyToken(refreshToken, secret);

    if (payload.type !== 'refresh') {
      return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid token type' } }, 401);
    }

    // Validate refresh token is still active in sessions table (rotation check)
    const db = getDBOptional(c);
    const tokenHash = await hashToken(refreshToken);

    if (db) {
      const session = await db
        .prepare(`SELECT id FROM sessions WHERE user_id = ? AND token_hash = ? AND is_active = TRUE AND expires_at > datetime('now')`)
        .bind(payload.sub, tokenHash)
        .first<{ id: string }>();

      if (!session) {
        // Token not found or already rotated — possible replay attack
        logger.warn('Refresh token not found in sessions (possible replay)', { userId: payload.sub });
        return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Refresh token has been revoked or expired' } }, 401);
      }

      // Issue new token pair
      const { accessToken: newAccess, refreshToken: newRefresh } = await issueTokenPair(
        {
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          role: payload.role,
          organizationId: payload.orgId,
        },
        secret,
      );

      // Rotate: update session with new token hash
      const newTokenHash = await hashToken(newRefresh);
      const newExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      await db
        .prepare(`UPDATE sessions SET token_hash = ?, last_accessed_at = CURRENT_TIMESTAMP, expires_at = ? WHERE id = ?`)
        .bind(newTokenHash, newExpires, session.id)
        .run();

      return c.json({ accessToken: newAccess, refreshToken: newRefresh });
    }

    // No DB available — fallback to stateless (issue new access token only)
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await createToken(
      {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        orgId: payload.orgId,
        iat: now,
        exp: now + 3600,
        type: 'access',
      },
      secret,
    );

    return c.json({ accessToken });
  } catch {
    return c.json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid refresh token' } }, 401);
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────

authRoutes.post('/logout', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }

  const refreshToken =
    typeof body === 'object' && body !== null && 'refreshToken' in body
      ? (body as { refreshToken?: string }).refreshToken
      : undefined;

  const authHeader = c.req.header('Authorization');
  const db = getDBOptional(c);
  const secret = getJWTSecret(c);

  if (authHeader?.startsWith('Bearer ') && db) {
    try {
      const token = authHeader.substring(7);
      const payload = await verifyToken(token, secret);

      // Invalidate the specific session if refresh token was provided
      if (refreshToken) {
        const rtHash = await hashToken(refreshToken);
        await db
          .prepare('UPDATE sessions SET is_active = FALSE WHERE user_id = ? AND token_hash = ?')
          .bind(payload.sub, rtHash)
          .run();
      }

      await db
        .prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(
          payload.sub,
          'USER_LOGOUT',
          'user',
          payload.sub,
          getAnonymizedIP(c),
          getUserAgent(c),
        )
        .run();
    } catch { /* best-effort */ }
  }

  return c.json({ message: 'Logout successful' });
});

export default authRoutes;
