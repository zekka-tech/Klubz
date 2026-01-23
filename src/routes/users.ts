import { Hono } from 'hono'
import { Bindings } from '../index'
import { authMiddleware } from '../middleware/auth'
import { AppError, NotFoundError, ValidationError } from '../middleware/errorHandler'
import { logAuditEvent } from '../middleware/auditLogger'
import crypto from 'crypto'

export const userRoutes = new Hono<{ Bindings: Bindings }>()

// Apply auth middleware to all user routes
userRoutes.use('*', authMiddleware())

// Get current user profile
userRoutes.get('/profile', async (c) => {
  const user = c.get('user')
  
  // In a real implementation, this would fetch from database
  const userProfile = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organizationId: user.organizationId,
    phone: '+1234567890',
    avatar: null,
    preferences: {
      notifications: true,
      emailUpdates: true,
      language: 'en'
    },
    stats: {
      totalTrips: 42,
      totalDistance: 1250.5,
      carbonSaved: 25.1,
      rating: 4.8
    },
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  }
  
  return c.json(userProfile)
})

// Update user profile
userRoutes.put('/profile', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  
  // Validate input
  if (!body.name || body.name.length < 2) {
    throw new ValidationError('Name must be at least 2 characters')
  }
  
  if (body.phone && !/^\+?[\d\s\-\(\)]+$/.test(body.phone)) {
    throw new ValidationError('Invalid phone number format')
  }
  
  // In a real implementation, this would update the database
  const updatedProfile = {
    id: user.id,
    email: user.email,
    name: body.name || user.name,
    role: user.role,
    organizationId: user.organizationId,
    phone: body.phone || '+1234567890',
    avatar: body.avatar || null,
    preferences: {
      notifications: body.preferences?.notifications ?? true,
      emailUpdates: body.preferences?.emailUpdates ?? true,
      language: body.preferences?.language || 'en'
    },
    updatedAt: new Date().toISOString()
  }
  
  // Log profile update
  await logAuditEvent(c, {
    userId: user.id,
    action: 'USER_PROFILE_UPDATE',
    resourceType: 'user',
    resourceId: user.id,
    success: true,
    metadata: { updatedFields: Object.keys(body) }
  })
  
  return c.json(updatedProfile)
})

// Get user trips
userRoutes.get('/trips', async (c) => {
  const user = c.get('user')
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const status = c.req.query('status')
  
  // Mock trips data
  const mockTrips = [
    {
      id: crypto.randomUUID(),
      userId: user.id,
      driverId: crypto.randomUUID(),
      organizationId: user.organizationId,
      pickupLocation: { lat: -26.2041, lng: 28.0473, address: '123 Main St, Johannesburg' },
      dropoffLocation: { lat: -26.1076, lng: 28.0567, address: '456 Office Park, Sandton' },
      scheduledTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      status: 'scheduled',
      distance: 15.2,
      estimatedDuration: 25,
      price: 45.00,
      currency: 'ZAR',
      carbonSaved: 2.1,
      createdAt: new Date().toISOString()
    },
    {
      id: crypto.randomUUID(),
      userId: user.id,
      driverId: crypto.randomUUID(),
      organizationId: user.organizationId,
      pickupLocation: { lat: -26.2041, lng: 28.0473, address: '789 Business Rd, Rosebank' },
      dropoffLocation: { lat: -26.1076, lng: 28.0567, address: '321 Corporate Ave, Sandton' },
      scheduledTime: new Date(Date.now() - 86400000).toISOString(), // Yesterday
      status: 'completed',
      distance: 12.8,
      actualDuration: 22,
      price: 38.50,
      currency: 'ZAR',
      carbonSaved: 1.8,
      completedAt: new Date(Date.now() - 85000000).toISOString(),
      createdAt: new Date(Date.now() - 90000000).toISOString()
    }
  ]
  
  // Filter by status if provided
  let filteredTrips = status ? mockTrips.filter(trip => trip.status === status) : mockTrips
  
  // Pagination
  const startIndex = (page - 1) * limit
  const endIndex = startIndex + limit
  const paginatedTrips = filteredTrips.slice(startIndex, endIndex)
  
  return c.json({
    trips: paginatedTrips,
    pagination: {
      page,
      limit,
      total: filteredTrips.length,
      totalPages: Math.ceil(filteredTrips.length / limit)
    }
  })
})

// Create a new trip
userRoutes.post('/trips', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  
  // Validate required fields
  if (!body.pickupLocation || !body.dropoffLocation || !body.scheduledTime) {
    throw new ValidationError('Pickup location, dropoff location, and scheduled time are required')
  }
  
  // Validate location format
  if (!body.pickupLocation.lat || !body.pickupLocation.lng || !body.pickupLocation.address) {
    throw new ValidationError('Invalid pickup location format')
  }
  
  if (!body.dropoffLocation.lat || !body.dropoffLocation.lng || !body.dropoffLocation.address) {
    throw new ValidationError('Invalid dropoff location format')
  }
  
  // Validate scheduled time (must be in the future)
  const scheduledTime = new Date(body.scheduledTime)
  if (scheduledTime <= new Date()) {
    throw new ValidationError('Scheduled time must be in the future')
  }
  
  // In a real implementation, this would:
  // 1. Calculate distance and estimated duration
  // 2. Find available drivers
  // 3. Calculate price
  // 4. Create trip in database
  
  const newTrip = {
    id: crypto.randomUUID(),
    userId: user.id,
    driverId: null, // Will be assigned when driver accepts
    organizationId: user.organizationId,
    pickupLocation: body.pickupLocation,
    dropoffLocation: body.dropoffLocation,
    scheduledTime: body.scheduledTime,
    status: 'pending',
    distance: 12.5, // Mock calculation
    estimatedDuration: 20, // Mock calculation
    price: 35.00, // Mock calculation
    currency: 'ZAR',
    carbonSaved: 1.5, // Mock calculation
    notes: body.notes || null,
    createdAt: new Date().toISOString()
  }
  
  // Log trip creation
  await logAuditEvent(c, {
    userId: user.id,
    action: 'TRIP_CREATE',
    resourceType: 'trip',
    resourceId: newTrip.id,
    success: true,
    metadata: {
      pickupLocation: body.pickupLocation.address,
      dropoffLocation: body.dropoffLocation.address,
      scheduledTime: body.scheduledTime
    }
  })
  
  return c.json({
    message: 'Trip created successfully',
    trip: newTrip
  })
})

// Get user preferences
userRoutes.get('/preferences', async (c) => {
  const user = c.get('user')
  
  // Mock preferences
  const preferences = {
    notifications: {
      tripReminders: true,
      tripUpdates: true,
      marketingEmails: false,
      smsNotifications: true
    },
    privacy: {
      shareLocation: true,
      allowDriverContact: true,
      showInDirectory: false
    },
    accessibility: {
      wheelchairAccessible: false,
      visualImpairment: false,
      hearingImpairment: false
    },
    language: 'en',
    timezone: 'Africa/Johannesburg',
    currency: 'ZAR'
  }
  
  return c.json(preferences)
})

// Update user preferences
userRoutes.put('/preferences', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  
  // Validate preferences structure
  if (body.notifications) {
    if (typeof body.notifications.tripReminders !== 'boolean' ||
        typeof body.notifications.tripUpdates !== 'boolean' ||
        typeof body.notifications.marketingEmails !== 'boolean' ||
        typeof body.notifications.smsNotifications !== 'boolean') {
      throw new ValidationError('Invalid notification preferences')
    }
  }
  
  if (body.privacy) {
    if (typeof body.privacy.shareLocation !== 'boolean' ||
        typeof body.privacy.allowDriverContact !== 'boolean' ||
        typeof body.privacy.showInDirectory !== 'boolean') {
      throw new ValidationError('Invalid privacy preferences')
    }
  }
  
  // In a real implementation, this would update the database
  const updatedPreferences = {
    notifications: {
      tripReminders: body.notifications?.tripReminders ?? true,
      tripUpdates: body.notifications?.tripUpdates ?? true,
      marketingEmails: body.notifications?.marketingEmails ?? false,
      smsNotifications: body.notifications?.smsNotifications ?? true
    },
    privacy: {
      shareLocation: body.privacy?.shareLocation ?? true,
      allowDriverContact: body.privacy?.allowDriverContact ?? true,
      showInDirectory: body.privacy?.showInDirectory ?? false
    },
    accessibility: {
      wheelchairAccessible: body.accessibility?.wheelchairAccessible ?? false,
      visualImpairment: body.accessibility?.visualImpairment ?? false,
      hearingImpairment: body.accessibility?.hearingImpairment ?? false
    },
    language: body.language || 'en',
    timezone: body.timezone || 'Africa/Johannesburg',
    currency: body.currency || 'ZAR'
  }
  
  // Log preference update
  await logAuditEvent(c, {
    userId: user.id,
    action: 'USER_PREFERENCES_UPDATE',
    resourceType: 'user',
    resourceId: user.id,
    success: true,
    metadata: { updatedSections: Object.keys(body) }
  })
  
  return c.json(updatedPreferences)
})

export default userRoutes