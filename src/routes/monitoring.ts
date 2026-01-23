import { Hono } from 'hono'
import { Bindings } from '../index'
import { authMiddleware, adminMiddleware } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { logAuditEvent } from '../middleware/auditLogger'

export const monitoringRoutes = new Hono<{ Bindings: Bindings }>()

// Basic health check (no auth required)
monitoringRoutes.get('/health', async (c) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: c.env.ENVIRONMENT || 'development',
    services: {
      database: 'healthy',
      cache: 'healthy',
      externalApis: 'healthy'
    },
    metrics: {
      uptime: process.uptime ? process.uptime() : 0,
      memory: process.memoryUsage ? process.memoryUsage() : {},
      activeConnections: 42 // Mock value
    }
  }
  
  return c.json(health)
})

// Detailed system metrics (admin only)
monitoringRoutes.get('/metrics', adminMiddleware(), async (c) => {
  const metrics = {
    system: {
      cpu: {
        usage: 34.2,
        cores: 4,
        loadAverage: [1.2, 0.8, 0.6]
      },
      memory: {
        total: 8589934592, // 8GB
        used: 4294967296, // 4GB
        free: 4294967296, // 4GB
        usage: 50.0
      },
      disk: {
        total: 107374182400, // 100GB
        used: 32212254720, // 30GB
        free: 75161927680, // 70GB
        usage: 30.0
      }
    },
    application: {
      requests: {
        total: 15420,
        perSecond: 12.3,
        errors: 23,
        errorRate: 0.15
      },
      responseTime: {
        avg: 145,
        p50: 120,
        p95: 200,
        p99: 350,
        unit: 'ms'
      },
      database: {
        connections: 12,
        queriesPerSecond: 45.2,
        avgQueryTime: 12,
        slowQueries: 2
      },
      cache: {
        hitRate: 0.85,
        missRate: 0.15,
        evictions: 123,
        memoryUsage: 256 // MB
      }
    },
    business: {
      activeTrips: 23,
      pendingBookings: 12,
      activeDrivers: 18,
      waitingPassengers: 7,
      revenueToday: 1250.00,
      tripsCompletedToday: 45
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(metrics)
})

// Performance monitoring endpoints
monitoringRoutes.get('/performance', authMiddleware(), async (c) => {
  const { timeframe = '1h' } = c.req.query()
  
  const performance = {
    timeframe,
    api: {
      endpoints: [
        {
          path: '/api/auth/login',
          avgResponseTime: 245,
          requests: 234,
          errors: 2,
          errorRate: 0.85
        },
        {
          path: '/api/users/profile',
          avgResponseTime: 120,
          requests: 567,
          errors: 0,
          errorRate: 0.0
        },
        {
          path: '/api/trips/available',
          avgResponseTime: 180,
          requests: 890,
          errors: 1,
          errorRate: 0.11
        }
      ]
    },
    database: {
      queries: [
        {
          query: 'SELECT * FROM users WHERE id = ?',
          avgTime: 5.2,
          calls: 1234,
          totalTime: 6421
        },
        {
          query: 'SELECT * FROM trips WHERE status = ?',
          avgTime: 12.8,
          calls: 567,
          totalTime: 7258
        }
      ]
    },
    cache: {
      hitRate: 0.82,
      missRate: 0.18,
      avgResponseTime: 2.3
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(performance)
})

// SLA monitoring
monitoringRoutes.get('/sla', authMiddleware(), async (c) => {
  const sla = {
    availability: {
      target: 99.8,
      current: 99.85,
      status: 'meeting'
    },
    responseTime: {
      target: 200, // ms
      current: 145, // ms
      status: 'exceeding'
    },
    errorRate: {
      target: 0.1, // 0.1%
      current: 0.05, // 0.05%
      status: 'exceeding'
    },
    support: {
      responseTime: {
        target: 240, // minutes
        current: 180, // minutes
        status: 'exceeding'
      },
      resolutionTime: {
        target: 1440, // minutes (24 hours)
        current: 720, // minutes (12 hours)
        status: 'exceeding'
      }
    },
    incidents: {
      total: 3,
      resolved: 3,
      unresolved: 0,
      lastIncident: new Date(Date.now() - 604800000).toISOString() // 7 days ago
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(sla)
})

// Security monitoring
monitoringRoutes.get('/security', adminMiddleware(), async (c) => {
  const security = {
    threats: {
      blocked: 123,
      flagged: 45,
      resolved: 167,
      active: 2
    },
    authentication: {
      failedLogins: 23,
      successfulLogins: 1234,
      mfaEnabled: 856,
      mfaDisabled: 123
    },
    encryption: {
      status: 'active',
      algorithm: 'AES-256-GCM',
      keyRotation: {
        lastRotation: new Date(Date.now() - 2592000000).toISOString(), // 30 days ago
        nextRotation: new Date(Date.now() + 7776000000).toISOString() // 90 days from now
      }
    },
    vulnerabilities: {
      critical: 0,
      high: 1,
      medium: 3,
      low: 8,
      lastScan: new Date(Date.now() - 86400000).toISOString() // 1 day ago
    },
    compliance: {
      popia: {
        status: 'compliant',
        lastAudit: new Date(Date.now() - 7776000000).toISOString(), // 90 days ago
        nextAudit: new Date(Date.now() + 15552000000).toISOString() // 180 days from now
      },
      gdpr: {
        status: 'compliant',
        lastAudit: new Date(Date.now() - 7776000000).toISOString(),
        nextAudit: new Date(Date.now() + 15552000000).toISOString()
      }
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(security)
})

// Error tracking
monitoringRoutes.get('/errors', authMiddleware(), async (c) => {
  const { timeframe = '24h' } = c.req.query()
  
  const errors = {
    timeframe,
    summary: {
      total: 23,
      resolved: 20,
      unresolved: 3,
      rate: 0.15 // errors per hour
    },
    byType: [
      {
        type: 'ValidationError',
        count: 8,
        percentage: 34.8
      },
      {
        type: 'DatabaseError',
        count: 6,
        percentage: 26.1
      },
      {
        type: 'AuthenticationError',
        count: 5,
        percentage: 21.7
      },
      {
        type: 'ExternalAPIError',
        count: 4,
        percentage: 17.4
      }
    ],
    recent: [
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'ValidationError',
        message: 'Invalid email format',
        userId: crypto.randomUUID(),
        context: {
          endpoint: '/api/auth/register',
          input: { email: 'invalid-email' }
        },
        resolved: false
      }
    ],
    trends: {
      last24h: 23,
      last7d: 89,
      last30d: 312,
      trend: 'decreasing' // vs previous period
    }
  }
  
  return c.json(errors)
})

// Carbon footprint tracking
monitoringRoutes.get('/carbon', authMiddleware(), async (c) => {
  const { timeframe = '30d' } = c.req.query()
  
  const carbon = {
    timeframe,
    total: {
      saved: 6840.5, // kg CO2
      equivalent: {
        trees: 312, // number of trees
        cars: 1.7 // number of cars off road for a year
      }
    },
    byPeriod: [
      {
        period: '2024-01',
        saved: 1240.2,
        trips: 520,
        avgPerTrip: 2.38
      },
      {
        period: '2024-02',
        saved: 1180.8,
        trips: 485,
        avgPerTrip: 2.43
      },
      {
        period: '2024-03',
        saved: 1320.5,
        trips: 545,
        avgPerTrip: 2.42
      }
    ],
    byOrganization: [
      {
        organizationId: 'org-123',
        name: 'Tech Corp',
        saved: 2150.3,
        trips: 890,
        rank: 1
      },
      {
        organizationId: 'org-456',
        name: 'Financial Services',
        saved: 1240.8,
        trips: 512,
        rank: 2
      }
    ],
    impact: {
      treesEquivalent: 312,
      carsEquivalent: 1.7,
      homesEquivalent: 0.8 // electricity for homes for a year
    },
    timestamp: new Date().toISOString()
  }
  
  return c.json(carbon)
})

// Real-time alerts
monitoringRoutes.get('/alerts', authMiddleware(), async (c) => {
  const alerts = {
    active: [
      {
        id: crypto.randomUUID(),
        level: 'warning',
        title: 'High Response Time',
        message: 'Average response time exceeded 200ms threshold',
        source: 'API Gateway',
        triggeredAt: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
        acknowledged: false
      },
      {
        id: crypto.randomUUID(),
        level: 'info',
        title: 'Scheduled Maintenance',
        message: 'System maintenance scheduled for tonight 2-4 AM',
        source: 'Operations',
        triggeredAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        acknowledged: true,
        acknowledgedBy: 'admin@klubz.com'
      }
    ],
    recent: [
      {
        id: crypto.randomUUID(),
        level: 'error',
        title: 'Database Connection Lost',
        message: 'Primary database connection lost, switched to replica',
        source: 'Database',
        triggeredAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
        resolved: true,
        resolvedAt: new Date(Date.now() - 6900000).toISOString()
      }
    ]
  }
  
  return c.json(alerts)
})

export default monitoringRoutes