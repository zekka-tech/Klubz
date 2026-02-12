import type { Context } from 'hono';
import { anonymizeIP } from './privacy';

/**
 * Extract client IP address from request headers
 * Checks Cloudflare-specific headers first, then fallbacks
 *
 * NOTE: Returns full IP. For logging, use getAnonymizedIP() for GDPR/POPIA compliance.
 */
export function getIP(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

/**
 * Get anonymized IP address for logging (GDPR/POPIA compliant)
 *
 * Use this for logging and analytics.
 * Use getIP() for rate limiting and security checks that require full IP.
 */
export function getAnonymizedIP(c: Context): string {
  return anonymizeIP(getIP(c));
}

/**
 * Extract user agent from request headers
 * Truncates to 255 characters to prevent DB overflow
 */
export function getUserAgent(c: Context): string {
  return c.req.header('User-Agent')?.slice(0, 255) || 'unknown';
}

/**
 * Parse JSON body with error handling
 * Returns null if parsing fails instead of throwing
 */
export async function parseJSONBody<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/**
 * Standard error response format
 */
export function errorResponse(
  c: Context,
  code: string,
  message: string,
  status: number = 400
) {
  return c.json(
    {
      error: {
        code,
        message,
        status,
        requestId: c.get('requestId'),
        timestamp: new Date().toISOString(),
      },
    },
    status as any // Type assertion for Hono status codes
  );
}

/**
 * Standard success response format
 */
export function successResponse<T>(c: Context, data: T, status: number = 200) {
  return c.json(data, status as any); // Type assertion for Hono status codes
}
