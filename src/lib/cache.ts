/**
 * Klubz - KV Cache Service
 *
 * Provides caching layer using Cloudflare KV for improved performance.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { logger } from './logger';

export class CacheService {
  constructor(private kv: KVNamespace) {}

  /**
   * Get a cached value by key
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.kv.get(key, 'text');
      if (!cached) return null;

      const parsed = JSON.parse(cached);
      logger.debug('Cache hit', { key });
      return parsed as T;
    } catch (err) {
      logger.warn('Cache get failed', {
        error: err instanceof Error ? err.message : String(err),
        key
      });
      return null;
    }
  }

  /**
   * Set a cached value with optional TTL (default 5 minutes)
   */
  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    try {
      await this.kv.put(key, JSON.stringify(value), {
        expirationTtl: ttlSeconds
      });
      logger.debug('Cache set', { key, ttlSeconds });
    } catch (err) {
      logger.warn('Cache set failed', {
        error: err instanceof Error ? err.message : String(err),
        key
      });
    }
  }

  /**
   * Delete a specific cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
      logger.debug('Cache deleted', { key });
    } catch (err) {
      logger.warn('Cache delete failed', {
        error: err instanceof Error ? err.message : String(err),
        key
      });
    }
  }

  /**
   * Invalidate all keys matching a prefix pattern
   */
  async invalidatePattern(prefix: string): Promise<void> {
    try {
      const keys = await this.kv.list({ prefix });
      await Promise.all(keys.keys.map(k => this.kv.delete(k.name)));
      logger.debug('Cache pattern invalidated', {
        prefix,
        count: keys.keys.length
      });
    } catch (err) {
      logger.warn('Cache pattern invalidation failed', {
        error: err instanceof Error ? err.message : String(err),
        prefix
      });
    }
  }

  /**
   * Get or compute - returns cached value or computes and caches it
   */
  async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

/**
 * Get cache service from context (gracefully returns null if not configured)
 */
export function getCacheService(c: Context<AppEnv>): CacheService | null {
  if (!c.env?.CACHE) {
    return null;
  }
  return new CacheService(c.env.CACHE);
}
