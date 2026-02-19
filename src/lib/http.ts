import type { Context } from 'hono';
import { anonymizeIP } from './privacy';
type JsonResponseInit = Parameters<Context['json']>[1];

const MAX_IP_VALUE_LENGTH = 64;

function readHeader(c: Context, name: string): string | undefined {
  return c.req.header(name) || c.req.header(name.toLowerCase()) || undefined;
}

function normalizeIPValue(value: string | undefined): string | undefined {
  if (!value) return undefined;

  let candidate = value.split(',')[0]?.trim();
  if (!candidate) return undefined;

  if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1).trim();
  }

  // Handle bracketed IPv6 with optional port: [2001:db8::1]:443
  if (candidate.startsWith('[')) {
    const bracketEnd = candidate.indexOf(']');
    if (bracketEnd > 1) {
      candidate = candidate.slice(1, bracketEnd);
    }
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(candidate)) {
    // Handle IPv4 with port: 203.0.113.10:443
    candidate = candidate.split(':')[0] ?? candidate;
  }

  if (!candidate || candidate.length > MAX_IP_VALUE_LENGTH) {
    return undefined;
  }

  return candidate;
}

/**
 * Extract client IP address from request headers
 * Checks Cloudflare-specific headers first, then fallbacks
 *
 * NOTE: Returns full IP. For logging, use getAnonymizedIP() for GDPR/POPIA compliance.
 */
export function getIP(c: Context): string {
  const cfIp = normalizeIPValue(readHeader(c, 'CF-Connecting-IP'));
  if (cfIp) return cfIp;

  const forwardedIp = normalizeIPValue(readHeader(c, 'X-Forwarded-For'));
  if (forwardedIp) return forwardedIp;

  const realIp = normalizeIPValue(readHeader(c, 'X-Real-IP'));
  if (realIp) return realIp;

  return 'unknown';
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
  return (readHeader(c, 'User-Agent') || 'unknown').slice(0, 255);
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
    status as JsonResponseInit
  );
}

/**
 * Standard success response format
 */
export function successResponse<T>(c: Context, data: T, status: number = 200) {
  return c.json(data, status as JsonResponseInit);
}
