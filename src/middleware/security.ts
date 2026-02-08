/**
 * Klubz Advanced Security Middleware
 * Production-grade security for Cloudflare Workers
 */

import { Context, Next } from 'hono'

// ═══ CSRF Protection ═══
export function csrfProtection() {
  return async (c: Context, next: Next) => {
    // Skip for safe methods and API auth endpoints
    const method = c.req.method
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      await next()
      return
    }

    const path = new URL(c.req.url).pathname

    // Skip CSRF for API endpoints that use Bearer auth
    if (path.startsWith('/api/')) {
      await next()
      return
    }

    // Validate CSRF token for form submissions
    const csrfToken = c.req.header('X-CSRF-Token') || ''
    const cookieToken = getCookieValue(c.req.header('Cookie') || '', 'csrf_token')

    if (csrfToken && cookieToken && csrfToken === cookieToken) {
      await next()
      return
    }

    // Check Origin/Referer for same-origin
    const origin = c.req.header('Origin') || ''
    const referer = c.req.header('Referer') || ''
    const host = c.req.header('Host') || ''

    if (origin) {
      const originHost = new URL(origin).host
      if (originHost !== host) {
        return c.json({ error: { code: 'CSRF_ERROR', message: 'Cross-origin request blocked' } }, 403)
      }
    }

    await next()
  }
}

// ═══ Request Sanitization ═══
export function sanitizeInput() {
  return async (c: Context, next: Next) => {
    // Check for common injection patterns in URL
    const url = c.req.url
    const dangerousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /\.\.\//,
      /\0/,
      /%00/,
      /eval\s*\(/i,
      /exec\s*\(/i,
    ]

    const decodedUrl = decodeURIComponent(url)
    for (const pattern of dangerousPatterns) {
      if (pattern.test(decodedUrl)) {
        console.warn(`Security: Blocked suspicious request: ${url}`)
        return c.json({ error: { code: 'SECURITY_ERROR', message: 'Request blocked' } }, 400)
      }
    }

    // Limit body size (1MB)
    const contentLength = parseInt(c.req.header('Content-Length') || '0')
    if (contentLength > 1_048_576) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }, 413)
    }

    await next()
  }
}

// ═══ IP-based Brute Force Protection ═══
const bruteForceStore = new Map<string, { attempts: number; lockUntil: number }>()

export function bruteForceProtection(opts: { maxAttempts?: number; lockDurationMs?: number; windowMs?: number } = {}) {
  const maxAttempts = opts.maxAttempts || 10
  const lockDuration = opts.lockDurationMs || 15 * 60 * 1000 // 15 min
  const window = opts.windowMs || 5 * 60 * 1000 // 5 min

  return async (c: Context, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || 'unknown'
    const key = `bf:${ip}`
    const now = Date.now()

    const entry = bruteForceStore.get(key)

    // Check if locked
    if (entry && entry.lockUntil > now) {
      const retryAfter = Math.ceil((entry.lockUntil - now) / 1000)
      c.header('Retry-After', retryAfter.toString())
      return c.json({
        error: {
          code: 'ACCOUNT_LOCKED',
          message: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
          retryAfter,
        }
      }, 429)
    }

    await next()

    // Track failed auth attempts
    const status = c.res.status
    if (status === 401 || status === 403) {
      if (!entry || (now - (entry.lockUntil - lockDuration)) > window) {
        bruteForceStore.set(key, { attempts: 1, lockUntil: 0 })
      } else {
        entry.attempts++
        if (entry.attempts >= maxAttempts) {
          entry.lockUntil = now + lockDuration
        }
      }
    } else if (status >= 200 && status < 300) {
      // Reset on success
      bruteForceStore.delete(key)
    }

    // Cleanup
    if (bruteForceStore.size > 10000) {
      for (const [k, v] of bruteForceStore) {
        if (v.lockUntil < now && v.attempts === 0) bruteForceStore.delete(k)
      }
    }
  }
}

// ═══ Request ID Tracking ═══
export function requestId() {
  return async (c: Context, next: Next) => {
    const id = c.req.header('X-Request-ID') || crypto.randomUUID()
    c.header('X-Request-ID', id)
    await next()
  }
}

// ═══ Security Event Logger ═══
export function logSecurityEvent(event: {
  type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  ip?: string
  userId?: string
  details?: string
}) {
  console.log(JSON.stringify({
    level: event.severity === 'critical' ? 'error' : event.severity === 'high' ? 'warn' : 'info',
    type: 'security_event',
    event: event.type,
    severity: event.severity,
    ip: event.ip,
    userId: event.userId,
    details: event.details,
    ts: new Date().toISOString(),
  }))
}

// ═══ Cookie Utilities ═══
function getCookieValue(cookieStr: string, name: string): string {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : ''
}

// ═══ Generate CSRF Token ═══
export function generateCSRFToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
