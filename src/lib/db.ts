import type { Context } from 'hono';
import type { AppEnv } from '../types';

/**
 * Get database instance from context
 * @throws {Error} If database is not configured
 */
export function getDB(c: Context<AppEnv>) {
  const db = c.env?.DB;
  if (!db) {
    throw new Error('Database not configured');
  }
  return db;
}

/**
 * Get database instance from context (returns null if not available)
 * Use this for optional database operations that should gracefully degrade
 */
export function getDBOptional(c: Context<AppEnv>) {
  return c.env?.DB ?? null;
}
