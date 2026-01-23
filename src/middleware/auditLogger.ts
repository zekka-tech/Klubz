import { Context, Next } from 'hono'
import { Bindings } from '../index'
import crypto from 'crypto'

export interface AuditLog {
  id: string
  userId: string
  action: string
  resourceType: string
  resourceId: string
  timestamp: string
  ipAddress: string
  userAgent: string
  success: boolean
  error?: string
  metadata?: Record<string, any>
}

export const auditLogger = () => {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const startTime = Date.now()
    const requestId = crypto.randomUUID()
    
    // Add request ID to headers
    c.header('X-Request-ID', requestId)
    
    // Log incoming request
    console.log({
      type: 'request',
      requestId,
      method: c.req.method,
      url: c.req.url,
      headers: Object.fromEntries(c.req.headers.entries()),
      timestamp: new Date().toISOString()
    })
    
    try {
      await next()
      
      const duration = Date.now() - startTime
      
      // Log successful response
      console.log({
        type: 'response',
        requestId,
        status: c.res.status,
        duration,
        timestamp: new Date().toISOString()
      })
      
    } catch (error: any) {
      const duration = Date.now() - startTime
      
      // Log error response
      console.error({
        type: 'error',
        requestId,
        error: error.message,
        stack: error.stack,
        duration,
        timestamp: new Date().toISOString()
      })
      
      throw error
    }
  }
}

export const logAuditEvent = async (
  c: Context<{ Bindings: Bindings }>,
  event: Omit<AuditLog, 'id' | 'timestamp' | 'ipAddress' | 'userAgent'>
) => {
  const auditLog: AuditLog = {
    id: crypto.randomUUID(),
    ...event,
    timestamp: new Date().toISOString(),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
    userAgent: c.req.header('user-agent') || 'unknown'
  }
  
  // In production, this would be stored in a database
  console.log('AUDIT:', auditLog)
  
  return auditLog
}