import { Hono } from 'hono'
import { Bindings } from '../index'
import { authMiddleware, adminMiddleware } from '../middleware/auth'
import { AppError, ValidationError, NotFoundError } from '../middleware/errorHandler'
import { logAuditEvent } from '../middleware/auditLogger'
import crypto from 'crypto'

export const adminRoutes = new Hono<{ Bindings: Bindings }>()

// Apply auth middleware to all admin routes
adminRoutes.use('*', authMiddleware(['admin']))

// Get system statistics
define('GET', '/stats', async (c) => {
  const stats = {
    totalUsers: 1250,
    activeUsers: 892,
    totalTrips: 3420,
    completedTrips: 2890,
    cancelledTrips: 530,
    totalDrivers: 156,
    activeDrivers: 98,
    totalOrganizations: 12,
    revenue: {
      total: 125000.00,
      currency: 'ZAR',
      thisMonth: 28500.00,
      lastMonth: 31200.00
    },
    carbonSaved: {
      total: 6840.5, // kg CO2
      thisMonth: 1560.2,
      trips: 3420
    },
    sla: {
      uptime: 99.8,
      avgResponseTime: 145,
      compliance: 'excellent'
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(stats)
})

// Get all users with filtering and pagination
adminRoutes.get('/users', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')
  const search = c.req.query('search') || ''
  const role = c.req.query('role')
  const status = c.req.query('status')
  const organizationId = c.req.query('organizationId')
  
  // Mock users data
  const mockUsers = [
    {
      id: crypto.randomUUID(),
      email: 'admin@company.com',
      name: 'Admin User',
      role: 'admin',
      organizationId: 'org-123',
      phone: '+27 81 555 0001',
      status: 'active',
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 864000000).toISOString(), // 10 days ago
      stats: {
        totalTrips: 0,
        avgRating: null
      }
    },
    {
      id: crypto.randomUUID(),
      email: 'driver@company.com',
      name: 'John Driver',
      role: 'driver',
      organizationId: 'org-123',
      phone: '+27 82 555 0002',
      status: 'active',
      lastLoginAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      createdAt: new Date(Date.now() - 432000000).toISOString(), // 5 days ago
      stats: {
        totalTrips: 156,
        avgRating: 4.7
      }
    },
    {
      id: crypto.randomUUID(),
      email: 'passenger@company.com',
      name: 'Jane Passenger',
      role: 'passenger',
      organizationId: 'org-123',
      phone: '+27 83 555 0003',
      status: 'active',
      lastLoginAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      createdAt: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
      stats: {
        totalTrips: 23,
        avgRating: 4.9
      }
    }
  ]
  
  // Apply filters
  let filteredUsers = mockUsers
  
  if (search) {
    filteredUsers = filteredUsers.filter(user =>
      user.name.toLowerCase().includes(search.toLowerCase()) ||
      user.email.toLowerCase().includes(search.toLowerCase())
    )
  }
  
  if (role) {
    filteredUsers = filteredUsers.filter(user => user.role === role)
  }
  
  if (status) {
    filteredUsers = filteredUsers.filter(user => user.status === status)
  }
  
  if (organizationId) {
    filteredUsers = filteredUsers.filter(user => user.organizationId === organizationId)
  }
  
  // Pagination
  const startIndex = (page - 1) * limit
  const endIndex = startIndex + limit
  const paginatedUsers = filteredUsers.slice(startIndex, endIndex)
  
  return c.json({
    users: paginatedUsers,
    pagination: {
      page,
      limit,
      total: filteredUsers.length,
      totalPages: Math.ceil(filteredUsers.length / limit)
    }
  })
})

// Get user details
adminRoutes.get('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  
  // Mock user details
  const userDetails = {
    id: userId,
    email: 'user@company.com',
    name: 'John User',
    role: 'passenger',
    organizationId: 'org-123',
    phone: '+27 81 555 1234',
    avatar: null,
    status: 'active',
    lastLoginAt: new Date().toISOString(),
    createdAt: new Date(Date.now() - 864000000).toISOString(),
    profile: {
      bio: 'Software developer who cares about the environment',
      interests: ['technology', 'environment', 'carpooling'],
      languages: ['English', 'Afrikaans'],
      accessibility: {
        wheelchairAccessible: false,
        visualImpairment: false
      }
    },
    stats: {
      totalTrips: 45,
      completedTrips: 42,
      cancelledTrips: 3,
      totalDistance: 850.5,
      carbonSaved: 17.2,
      avgRating: 4.8,
      ratingsReceived: 23,
      ratingsGiven: 41
    },
    preferences: {
      notifications: {
        tripReminders: true,
        tripUpdates: true,
        marketingEmails: false
      },
      privacy: {
        shareLocation: true,
        allowDriverContact: true
      },
      language: 'en'
    },
    compliance: {
      dataRetention: {
        policy: 'standard',
        expiryDate: new Date(Date.now() + 7776000000).toISOString() // 90 days from now
      },
      consent: {
        marketing: false,
        dataProcessing: true,
        lastUpdated: new Date(Date.now() - 259200000).toISOString() // 3 days ago
      }
    }
  }
  
  return c.json(userDetails)
})

// Update user (admin action)
adminRoutes.put('/users/:userId', async (c) => {
  const admin = c.get('user')
  const userId = c.req.param('userId')
  const body = await c.req.json()
  
  // Validate input
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw new ValidationError('Invalid email format')
  }
  
  if (body.role && !['admin', 'driver', 'passenger'].includes(body.role)) {
    throw new ValidationError('Invalid role')
  }
  
  if (body.status && !['active', 'inactive', 'suspended'].includes(body.status)) {
    throw new ValidationError('Invalid status')
  }
  
  // In a real implementation, this would:
  // 1. Verify user exists
  // 2. Apply updates
  // 3. Handle special cases (role changes, status changes)
  // 4. Send notifications if needed
  
  const updatedUser = {
    id: userId,
    email: body.email || 'user@company.com',
    name: body.name || 'John User',
    role: body.role || 'passenger',
    status: body.status || 'active',
    phone: body.phone || '+27 81 555 1234',
    updatedAt: new Date().toISOString(),
    updatedBy: admin.id
  }
  
  // Log user update
  await logAuditEvent(c, {
    userId: admin.id,
    action: 'USER_UPDATE_ADMIN',
    resourceType: 'user',
    resourceId: userId,
    success: true,
    metadata: {
      updatedFields: Object.keys(body),
      targetUserId: userId
    }
  })
  
  return c.json({
    message: 'User updated successfully',
    user: updatedUser
  })
})

// Get all organizations
adminRoutes.get('/organizations', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const search = c.req.query('search') || ''
  const status = c.req.query('status')
  
  // Mock organizations data
  const mockOrganizations = [
    {
      id: 'org-123',
      name: 'Tech Corp South Africa',
      domain: 'techcorp.co.za',
      status: 'active',
      plan: 'enterprise',
      createdAt: new Date(Date.now() - 31536000000).toISOString(), // 1 year ago
      settings: {
        branding: {
          primaryColor: '#2563eb',
          logo: 'https://example.com/logo.png'
        },
        features: {
          whiteLabel: true,
          customDomain: true,
          advancedAnalytics: true,
          apiAccess: true
        },
        compliance: {
          dataResidency: 'ZA',
          retentionDays: 2555 // 7 years
        }
      },
      stats: {
        totalUsers: 450,
        activeUsers: 380,
        totalTrips: 2150,
        thisMonthTrips: 185,
        carbonSaved: 4300.5
      }
    },
    {
      id: 'org-456',
      name: 'Financial Services Ltd',
      domain: 'finservices.co.za',
      status: 'active',
      plan: 'business',
      createdAt: new Date(Date.now() - 15768000000).toISOString(), // 6 months ago
      settings: {
        branding: {
          primaryColor: '#059669',
          logo: null
        },
        features: {
          whiteLabel: false,
          customDomain: false,
          advancedAnalytics: true,
          apiAccess: false
        },
        compliance: {
          dataResidency: 'ZA',
          retentionDays: 1825 // 5 years
        }
      },
      stats: {
        totalUsers: 125,
        activeUsers: 98,
        totalTrips: 567,
        thisMonthTrips: 45,
        carbonSaved: 1134.0
      }
    }
  ]
  
  // Apply filters
  let filteredOrgs = mockOrganizations
  
  if (search) {
    filteredOrgs = filteredOrgs.filter(org =>
      org.name.toLowerCase().includes(search.toLowerCase()) ||
      org.domain.toLowerCase().includes(search.toLowerCase())
    )
  }
  
  if (status) {
    filteredOrgs = filteredOrgs.filter(org => org.status === status)
  }
  
  // Pagination
  const startIndex = (page - 1) * limit
  const endIndex = startIndex + limit
  const paginatedOrgs = filteredOrgs.slice(startIndex, endIndex)
  
  return c.json({
    organizations: paginatedOrgs,
    pagination: {
      page,
      limit,
      total: filteredOrgs.length,
      totalPages: Math.ceil(filteredOrgs.length / limit)
    }
  })
})

// Get system logs
adminRoutes.get('/logs', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')
  const level = c.req.query('level') || 'info'
  const startDate = c.req.query('startDate')
  const endDate = c.req.query('endDate')
  
  // Mock logs data
  const mockLogs = [
    {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'User login successful',
      userId: crypto.randomUUID(),
      action: 'USER_LOGIN',
      metadata: {
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0...'
      }
    },
    {
      id: crypto.randomUUID(),
      timestamp: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
      level: 'warn',
      message: 'High number of failed login attempts',
      userId: null,
      action: 'SECURITY_ALERT',
      metadata: {
        ip: '10.0.0.50',
        attempts: 15,
        timeframe: '5m'
      }
    },
    {
      id: crypto.randomUUID(),
      timestamp: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
      level: 'error',
      message: 'Database connection timeout',
      userId: null,
      action: 'SYSTEM_ERROR',
      metadata: {
        error: 'ConnectionTimeout',
        database: 'primary',
        retryCount: 3
      }
    }
  ]
  
  // Filter by level
  let filteredLogs = level === 'all' ? mockLogs : mockLogs.filter(log => log.level === level)
  
  // Filter by date range if provided
  if (startDate || endDate) {
    const start = startDate ? new Date(startDate).getTime() : 0
    const end = endDate ? new Date(endDate).getTime() : Date.now()
    
    filteredLogs = filteredLogs.filter(log => {
      const logTime = new Date(log.timestamp).getTime()
      return logTime >= start && logTime <= end
    })
  }
  
  // Pagination
  const startIndex = (page - 1) * limit
  const endIndex = startIndex + limit
  const paginatedLogs = filteredLogs.slice(startIndex, endIndex)
  
  return c.json({
    logs: paginatedLogs,
    pagination: {
      page,
      limit,
      total: filteredLogs.length,
      totalPages: Math.ceil(filteredLogs.length / limit)
    }
  })
})

// Export user data (GDPR/POPIA compliance)
adminRoutes.post('/users/:userId/export', async (c) => {
  const admin = c.get('user')
  const userId = c.req.param('userId')
  
  // In a real implementation, this would:
  // 1. Verify admin has permission to export user data
  // 2. Gather all user data (profile, trips, preferences, etc.)
  // 3. Package data in a machine-readable format (JSON)
  // 4. Create secure download link
  // 5. Log the export for audit purposes
  
  const exportData = {
    exportId: crypto.randomUUID(),
    userId,
    exportedAt: new Date().toISOString(),
    exportedBy: admin.id,
    data: {
      profile: {
        name: 'John User',
        email: 'user@company.com',
        phone: '+27 81 555 1234',
        createdAt: new Date(Date.now() - 864000000).toISOString()
      },
      trips: [
        {
          id: crypto.randomUUID(),
          pickupLocation: { address: '123 Main St, Johannesburg' },
          dropoffLocation: { address: '456 Office Park, Sandton' },
          scheduledTime: new Date(Date.now() - 86400000).toISOString(),
          status: 'completed',
          createdAt: new Date(Date.now() - 86400000).toISOString()
        }
      ],
      preferences: {
        notifications: { tripReminders: true, tripUpdates: true },
        privacy: { shareLocation: true, allowDriverContact: true }
      }
    }
  }
  
  // Log data export
  await logAuditEvent(c, {
    userId: admin.id,
    action: 'USER_DATA_EXPORT',
    resourceType: 'user',
    resourceId: userId,
    success: true,
    metadata: {
      exportedBy: admin.id,
      exportId: exportData.exportId
    }
  })
  
  return c.json({
    message: 'User data export initiated',
    export: exportData
  })
})

export default adminRoutes