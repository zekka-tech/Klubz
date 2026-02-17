/**
 * Klubz - Error Handler Middleware
 *
 * Consistent error classes and error handling middleware.
 * Uses AppEnv type from shared types.
 */

import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';

export const errorHandler = () => {
  return async (c: Context<AppEnv>, next: Next) => {
    try {
      await next()
    } catch (err: unknown) {
      // Log error with context
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;

      logger.error('Request error', {
        error: errorMessage,
        stack: errorStack,
        requestId: c.get('requestId'),
        path: c.req.path,
        method: c.req.method,
      });

      // Handle AppError instances
      if (err instanceof AppError) {
        return c.json({
          error: {
            code: err.code,
            message: err.message,
            status: err.status,
            details: err.details,
            requestId: c.get('requestId'),
            timestamp: new Date().toISOString(),
          }
        }, err.status as any);
      }

      // Handle unknown errors - don't expose internals
      return c.json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          status: 500,
          requestId: c.get('requestId'),
          timestamp: new Date().toISOString(),
        }
      }, 500);
    }
  }
}
