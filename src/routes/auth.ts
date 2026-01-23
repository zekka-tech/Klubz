import { Hono } from 'hono'
import { Bindings } from '../index'
import { z } from 'zod'
import { createToken, verifyToken } from '../middleware/auth'
import { authRateLimiter } from '../middleware/rateLimiter'
import { AppError, ValidationError, AuthenticationError } from '../middleware/errorHandler'
import { logAuditEvent } from '../middleware/auditLogger'
import crypto from 'crypto'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  rememberMe: z.boolean().optional()
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  phone: z.string().optional(),
  role: z.enum(['passenger', 'driver']).default('passenger'),
  organizationId: z.string().optional()
})

const mfaSchema = z.object({
  token: z.string().length(6),
  backupCode: z.string().optional()
})

export const authRoutes = new Hono<{ Bindings: Bindings }>()

// Apply rate limiting to auth routes
authRoutes.use('*', authRateLimiter())

// Login endpoint
authRoutes.post('/login', async (c) => {
  const body = await c.req.json()
  
  try {
    const data = loginSchema.parse(body)
    
    // In a real implementation, this would verify against a database
    // For now, we'll create a mock user
    const mockUser = {
      id: crypto.randomUUID(),
      email: data.email,
      name: 'Test User',
      role: 'passenger' as const,
      organizationId: 'org-123',
      mfaEnabled: false,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
    
    // Generate tokens
    const accessToken = await createToken(mockUser, c.env.JWT_SECRET)
    const refreshToken = await createToken(mockUser, c.env.JWT_SECRET, '30d')
    
    // Log successful login
    await logAuditEvent(c, {
      userId: mockUser.id,
      action: 'USER_LOGIN',
      resourceType: 'user',
      resourceId: mockUser.id,
      success: true
    })
    
    return c.json({
      accessToken,
      refreshToken,
      user: {
        id: mockUser.id,
        email: mockUser.email,
        name: mockUser.name,
        role: mockUser.role,
        organizationId: mockUser.organizationId,
        mfaEnabled: mockUser.mfaEnabled
      }
    })
    
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid input: ' + error.errors.map(e => e.message).join(', '))
    }
    throw error
  }
})

// Registration endpoint
authRoutes.post('/register', async (c) => {
  const body = await c.req.json()
  
  try {
    const data = registerSchema.parse(body)
    
    // In a real implementation, this would:
    // 1. Check if email already exists
    // 2. Hash the password
    // 3. Create user in database
    // 4. Send verification email
    
    const hashedPassword = await hashPassword(data.password)
    const userId = crypto.randomUUID()
    
    // Mock user creation
    const newUser = {
      id: userId,
      email: data.email,
      name: data.name,
      phone: data.phone,
      role: data.role,
      organizationId: data.organizationId || 'org-123',
      passwordHash: hashedPassword,
      mfaEnabled: false,
      createdAt: new Date().toISOString()
    }
    
    // Log successful registration
    await logAuditEvent(c, {
      userId: userId,
      action: 'USER_REGISTER',
      resourceType: 'user',
      resourceId: userId,
      success: true,
      metadata: { role: data.role, organizationId: data.organizationId }
    })
    
    return c.json({
      message: 'Registration successful',
      userId: userId
    })
    
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid input: ' + error.errors.map(e => e.message).join(', '))
    }
    throw error
  }
})

// MFA verification
authRoutes.post('/mfa/verify', async (c) => {
  const body = await c.req.json()
  
  try {
    const data = mfaSchema.parse(body)
    
    // In a real implementation, this would verify the MFA token
    const isValid = data.token === '123456' // Mock verification
    
    if (!isValid) {
      throw new AuthenticationError('Invalid MFA token')
    }
    
    return c.json({
      verified: true,
      message: 'MFA verification successful'
    })
    
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid input: ' + error.errors.map(e => e.message).join(', '))
    }
    throw error
  }
})

// Token refresh
authRoutes.post('/refresh', async (c) => {
  const body = await c.req.json()
  const { refreshToken } = body
  
  if (!refreshToken) {
    throw new AuthenticationError('Refresh token required')
  }
  
  try {
    const payload = await verifyToken(refreshToken, c.env.JWT_SECRET)
    
    // Generate new access token
    const accessToken = await createToken(
      {
        id: payload.sub,
        email: payload.email,
        name: 'Test User',
        role: payload.role as any,
        organizationId: payload.organizationId,
        mfaEnabled: false,
        lastLoginAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      },
      c.env.JWT_SECRET
    )
    
    return c.json({
      accessToken
    })
    
  } catch (error) {
    throw new AuthenticationError('Invalid refresh token')
  }
})

// Logout
authRoutes.post('/logout', async (c) => {
  const authHeader = c.req.header('Authorization')
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    
    try {
      const payload = await verifyToken(token, c.env.JWT_SECRET)
      
      // Log logout event
      await logAuditEvent(c, {
        userId: payload.sub,
        action: 'USER_LOGOUT',
        resourceType: 'user',
        resourceId: payload.sub,
        success: true
      })
    } catch (error) {
      // Token might be expired, but we still allow logout
      console.warn('Token verification failed during logout:', error)
    }
  }
  
  return c.json({
    message: 'Logout successful'
  })
})

// Helper function to hash password
async function hashPassword(password: string): Promise<string> {
  // In a real implementation, use bcrypt or similar
  return crypto.createHash('sha256').update(password).digest('hex')
}

export default authRoutes