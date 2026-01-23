import { Context, Next } from 'hono'
import { Bindings } from '../index'
import { sign, verify } from 'hono/jwt'
import { AppError, AuthenticationError, AuthorizationError } from './errorHandler'

export interface User {
  id: string
  email: string
  name: string
  role: 'admin' | 'driver' | 'passenger'
  organizationId: string
  mfaEnabled: boolean
  lastLoginAt: string
  createdAt: string
}

export interface JWTPayload {
  sub: string
  email: string
  role: string
  organizationId: string
  iat: number
  exp: number
}

export const createToken = async (user: User, secret: string, expiresIn = '1h'): Promise<string> => {
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
  }
  
  return await sign(payload, secret)
}

export const verifyToken = async (token: string, secret: string): Promise<JWTPayload> => {
  try {
    return await verify(token, secret) as JWTPayload
  } catch (error) {
    throw new AuthenticationError('Invalid or expired token')
  }
}

export const authMiddleware = (roles?: string[]) => {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const authHeader = c.req.header('Authorization')
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing or invalid authorization header')
    }
    
    const token = authHeader.substring(7)
    
    try {
      const payload = await verifyToken(token, c.env.JWT_SECRET)
      
      if (roles && !roles.includes(payload.role)) {
        throw new AuthorizationError('Insufficient permissions')
      }
      
      // Set user in context
      c.set('user', {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        organizationId: payload.organizationId
      } as User)
      
      await next()
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      throw new AuthenticationError('Invalid token')
    }
  }
}

export const adminMiddleware = () => authMiddleware(['admin'])
export const driverMiddleware = () => authMiddleware(['driver', 'admin'])
export const passengerMiddleware = () => authMiddleware(['passenger', 'driver', 'admin'])