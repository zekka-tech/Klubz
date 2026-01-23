import { Context, Next } from 'hono'
import { Bindings } from '../index'

export const errorHandler = () => {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    try {
      await next()
    } catch (err: any) {
      console.error('Error:', err)
      
      const status = err.status || 500
      const message = err.message || 'Internal server error'
      const code = err.code || 'INTERNAL_ERROR'
      
      return c.json({
        error: {
          code,
          message,
          status,
          timestamp: new Date().toISOString(),
          requestId: c.req.header('x-request-id') || crypto.randomUUID()
        }
      }, status)
    }
  }
}

export class AppError extends Error {
  status: number
  code: string
  
  constructor(message: string, status = 500, code = 'INTERNAL_ERROR') {
    super(message)
    this.status = status
    this.code = code
    this.name = 'AppError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR')
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR')
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'AUTHORIZATION_ERROR')
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND')
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED')
  }
}