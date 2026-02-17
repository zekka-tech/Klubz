/**
 * Klubz - JWT Authentication Middleware (Production)
 *
 * Uses Web Crypto HMAC-SHA256 for JWT signing/verification.
 * No external JWT library — fully Workers-compatible.
 */

import type { Context, Next } from 'hono';
import type { AppEnv, AuthUser, JWTPayload } from '../types';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// JWT Implementation (Web Crypto)
// ---------------------------------------------------------------------------

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Create a JWT token.
 */
export async function createToken(payload: JWTPayload, secret: string): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;

  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify and decode a JWT token.
 */
export async function verifyToken(token: string, secret: string): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed token');

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]);

  const key = await getSigningKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as unknown as BufferSource,
    new TextEncoder().encode(signingInput) as unknown as BufferSource,
  );
  if (!valid) throw new AuthError('Invalid token signature');

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as JWTPayload;

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('Token expired');
  }

  return payload;
}

/**
 * Issue an access + refresh token pair for a user.
 */
export async function issueTokenPair(
  user: { id: number; email: string; name: string; role: string; organizationId?: string },
  secret: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const now = Math.floor(Date.now() / 1000);

  const accessPayload: JWTPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    orgId: user.organizationId,
    iat: now,
    exp: now + 3600,       // 1 hour
    type: 'access',
  };

  const refreshPayload: JWTPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    orgId: user.organizationId,
    iat: now,
    exp: now + 2592000,    // 30 days
    type: 'refresh',
  };

  const [accessToken, refreshToken] = await Promise.all([
    createToken(accessPayload, secret),
    createToken(refreshPayload, secret),
  ]);

  return { accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// Auth Error
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 401, code = 'AUTHENTICATION_ERROR') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * JWT authentication middleware.
 * Extracts Bearer token, verifies it, and sets `c.set('user', ...)`.
 *
 * @param roles - Optional role whitelist. If provided, user.role must be in the list.
 */
export function authMiddleware(roles?: string[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const secret = c.env?.JWT_SECRET;

    if (!secret) {
      logger.fatal('JWT_SECRET not configured - application cannot start securely');
      throw new AuthError('JWT_SECRET environment variable is required', 500, 'CONFIGURATION_ERROR');
    }

    try {
      const payload = await verifyToken(token, secret);

      if (payload.type !== 'access') {
        throw new AuthError('Invalid token type');
      }

      if (roles && !roles.includes(payload.role)) {
        throw new AuthError('Insufficient permissions', 403, 'AUTHORIZATION_ERROR');
      }

      const user: AuthUser = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role as AuthUser['role'],
        organizationId: payload.orgId,
      };

      c.set('user', user);
      await next();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Invalid token');
    }
  };
}

/** Convenience: admin-only middleware. */
export const adminMiddleware = () => authMiddleware(['admin', 'super_admin']);

/** Convenience: driver or admin. */
export const driverMiddleware = () => authMiddleware(['user', 'admin', 'super_admin']);

/** Convenience: any authenticated user. */
export const anyAuthMiddleware = () => authMiddleware();
