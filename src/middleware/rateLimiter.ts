import { Context } from 'hono'
import { Bindings } from '../index'

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  skipSuccessfulRequests: boolean
  skipFailedRequests: boolean
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>()

const defaultConfig: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100,
  skipSuccessfulRequests: false,
  skipFailedRequests: false
}

export const rateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const finalConfig = { ...defaultConfig, ...config }
  
  return async (c: Context<{ Bindings: Bindings }>, next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
    const key = `rate_limit:${ip}`
    const now = Date.now()
    
    let entry = rateLimitMap.get(key)
    
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + finalConfig.windowMs }
      rateLimitMap.set(key, entry)
    }
    
    entry.count++
    
    // Clean up old entries
    for (const [k, v] of rateLimitMap.entries()) {
      if (now > v.resetTime) {
        rateLimitMap.delete(k)
      }
    }
    
    if (entry.count > finalConfig.maxRequests) {
      c.header('X-RateLimit-Limit', finalConfig.maxRequests.toString())
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', new Date(entry.resetTime).toISOString())
      c.header('Retry-After', Math.ceil((entry.resetTime - now) / 1000).toString())
      
      return c.json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
          retryAfter: Math.ceil((entry.resetTime - now) / 1000)
        }
      }, 429)
    }
    
    c.header('X-RateLimit-Limit', finalConfig.maxRequests.toString())
    c.header('X-RateLimit-Remaining', (finalConfig.maxRequests - entry.count).toString())
    c.header('X-RateLimit-Reset', new Date(entry.resetTime).toISOString())
    
    await next()
  }
}

export const authRateLimiter = () => {
  return rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5, // 5 login attempts per 15 minutes
    skipSuccessfulRequests: true
  })
}

export const apiRateLimiter = () => {
  return rateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60 // 60 requests per minute
  })
}