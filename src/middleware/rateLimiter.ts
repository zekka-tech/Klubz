/**
 * Klubz - Rate Limiter Middleware
 *
 * Hybrid rate limiter with:
 * 1. In-memory store with proper TTL-based eviction (for edge/Workers)
 * 2. Optional KV-backed distributed limiting (for production multi-instance)
 *
 * TTL entries are lazily evicted on access + periodic sweep to prevent memory leaks.
 */

import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  useKV: boolean; // If true, tries c.env.RATE_LIMIT_KV first
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// ---------------------------------------------------------------------------
// In-Memory Store with TTL Eviction
// ---------------------------------------------------------------------------

class TTLMap {
  private store = new Map<string, RateLimitEntry>();
  private maxSize: number;
  private lastSweep = 0;
  private sweepIntervalMs = 30_000; // Sweep expired entries every 30s

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(key: string): RateLimitEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Lazy TTL: if expired, delete and return undefined
    if (Date.now() > entry.resetTime) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, entry: RateLimitEntry) {
    this.store.set(key, entry);
    this.maybeSweep();
  }

  get size() {
    return this.store.size;
  }

  /**
   * Periodically sweep expired entries to prevent unbounded growth.
   * Runs at most once per sweepIntervalMs.
   */
  private maybeSweep() {
    const now = Date.now();
    if (now - this.lastSweep < this.sweepIntervalMs && this.store.size <= this.maxSize) {
      return;
    }

    this.lastSweep = now;
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.resetTime) {
        this.store.delete(key);
        evicted++;
      }
      // If we've shrunk enough, stop scanning
      if (evicted > 2000 || (this.store.size <= this.maxSize * 0.75 && evicted > 0)) {
        break;
      }
    }
  }
}

const inMemoryStore = new TTLMap(10_000);

// ---------------------------------------------------------------------------
// KV-backed rate limiting
// ---------------------------------------------------------------------------

async function getFromKV(
  kv: any, // KVNamespace
  key: string,
): Promise<RateLimitEntry | null> {
  try {
    const raw = await kv.get(key, { type: 'json' });
    if (!raw) return null;
    const entry = raw as RateLimitEntry;
    if (Date.now() > entry.resetTime) return null;
    return entry;
  } catch {
    return null;
  }
}

async function putToKV(
  kv: any,
  key: string,
  entry: RateLimitEntry,
  windowMs: number,
): Promise<void> {
  try {
    // TTL in seconds, rounded up
    const ttlSeconds = Math.ceil(windowMs / 1000) + 5; // +5s buffer
    await kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

const defaultConfig: RateLimitConfig = {
  windowMs: 60_000, // 1 minute
  maxRequests: 120,
  keyPrefix: 'rl',
  useKV: false,
};

export const rateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const cfg = { ...defaultConfig, ...config };

  return async (c: Context<AppEnv>, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP')
      || c.req.header('x-forwarded-for')
      || c.req.header('x-real-ip')
      || 'unknown';
    const key = `${cfg.keyPrefix}:${ip}`;
    const now = Date.now();

    let entry: RateLimitEntry | null | undefined = null;

    // Try KV first in production (distributed)
    const kv = cfg.useKV ? c.env?.RATE_LIMIT_KV : null;
    if (kv) {
      entry = await getFromKV(kv, key);
    }

    // Fall back to in-memory
    if (!entry) {
      entry = inMemoryStore.get(key) ?? null;
    }

    // Create new window if none exists
    if (!entry) {
      entry = { count: 0, resetTime: now + cfg.windowMs };
    }

    entry.count++;

    // Persist updated count
    if (kv) {
      await putToKV(kv, key, entry, cfg.windowMs);
    }
    inMemoryStore.set(key, entry);

    // Set rate-limit response headers
    c.header('X-RateLimit-Limit', cfg.maxRequests.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, cfg.maxRequests - entry.count).toString());
    c.header('X-RateLimit-Reset', new Date(entry.resetTime).toISOString());

    if (entry.count > cfg.maxRequests) {
      c.header('Retry-After', Math.ceil((entry.resetTime - now) / 1000).toString());
      return c.json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
          retryAfter: Math.ceil((entry.resetTime - now) / 1000),
        },
      }, 429);
    }

    await next();
  };
};

// ---------------------------------------------------------------------------
// Pre-configured rate limiters
// ---------------------------------------------------------------------------

/** Strict limiter for auth endpoints (5 req / 15 min per IP). */
export const authRateLimiter = () =>
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
    keyPrefix: 'rl:auth',
    useKV: true, // Use KV when available for cross-isolate consistency
  });

/** Standard API limiter (60 req / 1 min per IP). */
export const apiRateLimiter = () =>
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:api',
  });
