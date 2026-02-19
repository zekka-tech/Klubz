/**
 * Klubz - Audit Logger Middleware
 *
 * Logs audit events to D1 when available, falls back to console.
 * Uses AppEnv type from shared types.
 */

import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';
import { getAnonymizedIP, getUserAgent } from '../lib/http';

export interface AuditLog {
  id: string
  userId: string | number
  action: string
  resourceType: string
  resourceId: string | number
  timestamp: string
  ipAddress: string
  userAgent: string
  success: boolean
  error?: string
  metadata?: Record<string, unknown>
}

export const auditLogger = () => {
  return async (c: Context<AppEnv>, next: Next) => {
    const requestId = c.req.header('X-Request-ID') || crypto.randomUUID()

    c.header('X-Request-ID', requestId)

    await next()
  }
}

/**
 * Log an audit event. Writes to D1 if available, else console.
 */
export const logAuditEvent = async (
  c: Context<AppEnv>,
  event: {
    userId: string | number
    action: string
    resourceType: string
    resourceId: string | number
    success: boolean
    error?: string
    metadata?: Record<string, unknown>
  }
) => {
  const ip = getAnonymizedIP(c);
  const ua = getUserAgent(c);

  // Try D1 first
  const db = c.env?.DB
  if (db) {
    try {
      await db
        .prepare(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(event.userId, event.action, event.resourceType, event.resourceId, ip, ua)
        .run()
      return
    } catch {
      // Fall through to console
    }
  }

  // Fallback: structured console log
  console.log(JSON.stringify({
    level: 'info',
    type: 'audit',
    ...event,
    ipAddress: ip,
    userAgent: ua,
    timestamp: new Date().toISOString(),
  }))
}
