import { Hono } from 'hono'
import { Bindings } from '../index'
import { authMiddleware } from '../middleware/auth'
import { AppError, ValidationError } from '../middleware/errorHandler'
import { logAuditEvent } from '../middleware/auditLogger'
import crypto from 'crypto'

export const tripRoutes = new Hono<{ Bindings: Bindings }>()

// Apply auth middleware to all trip routes
tripRoutes.use('*', authMiddleware())

// Get available trips
// Get available trips (for passengers to find rides)
tripRoutes.get('/available', async (c) => {
  const user = c.get('user')
  const { 
    pickupLat, 
    pickupLng, 
    dropoffLat, 
    dropoffLng, 
    date,
    time,
    radius = 5 // 5km radius
  } = c.req.query()
  
  // Validate required query parameters
  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    throw new ValidationError('Pickup and dropoff coordinates are required')
  }
  
  // Mock available trips (in a real app, this would query the database)
  const availableTrips = [
    {
      id: crypto.randomUUID(),
      driverId: crypto.randomUUID(),
      driverName: 'John Smith',
      driverRating: 4.8,
      driverPhone: '+27 81 555 1234',
      driverPhoto: null,
      vehicle: {
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Silver',
        licensePlate: 'ABC 123 GP',
        capacity: 4,
        currentOccupancy: 1
      },
      pickupLocation: {
        lat: parseFloat(pickupLat) - 0.001,
        lng: parseFloat(pickupLng) - 0.001,
        address: 'Nearby pickup location',
        distance: 0.5 // km
      },
      dropoffLocation: {
        lat: parseFloat(dropoffLat) + 0.001,
        lng: parseFloat(dropoffLng) + 0.001,
        address: 'Nearby dropoff location',
        distance: 0.3 // km
      },
      scheduledTime: date && time ? `${date}T${time}:00` : new Date(Date.now() + 3600000).toISOString(),
      estimatedDuration: 25,
      price: 45.00,
      currency: 'ZAR',
      availableSeats: 3,
      carbonSaved: 2.1,
      routeMatchScore: 0.85 // 85% route match
    },
    {
      id: crypto.randomUUID(),
      driverId: crypto.randomUUID(),
      driverName: 'Sarah Johnson',
      driverRating: 4.9,
      driverPhone: '+27 82 555 5678',
      driverPhoto: null,
      vehicle: {
        make: 'Volkswagen',
        model: 'Polo',
        year: 2021,
        color: 'Blue',
        licensePlate: 'DEF 456 GP',
        capacity: 4,
        currentOccupancy: 2
      },
      pickupLocation: {
        lat: parseFloat(pickupLat) + 0.002,
        lng: parseFloat(pickupLng) + 0.002,
        address: 'Alternative pickup location',
        distance: 0.8 // km
      },
      dropoffLocation: {
        lat: parseFloat(dropoffLat) - 0.001,
        lng: parseFloat(dropoffLng) - 0.001,
        address: 'Alternative dropoff location',
        distance: 0.6 // km
      },
      scheduledTime: date && time ? `${date}T${time}:30` : new Date(Date.now() + 3900000).toISOString(),
      estimatedDuration: 22,
      price: 42.00,
      currency: 'ZAR',
      availableSeats: 2,
      carbonSaved: 1.8,
      routeMatchScore: 0.78 // 78% route match
    }
  ].filter(trip => trip.routeMatchScore >= 0.7) // Only show trips with >70% route match
  
  return c.json({
    trips: availableTrips,
    searchCriteria: {
      pickupLocation: { lat: parseFloat(pickupLat), lng: parseFloat(pickupLng) },
      dropoffLocation: { lat: parseFloat(dropoffLat), lng: parseFloat(dropoffLng) },
      radius: parseFloat(radius.toString()),
      date,
      time
    },
    totalResults: availableTrips.length
  })
})

// Book a trip (passenger requests to join a trip)
tripRoutes.post('/:tripId/book', async (c) => {
  const user = c.get('user')
  const tripId = c.req.param('tripId')
  const body = await c.req.json()
  
  const { pickupLocation, dropoffLocation, passengers = 1, notes } = body
  
  // Validate input
  if (!pickupLocation || !dropoffLocation) {
    throw new ValidationError('Pickup and dropoff locations are required')
  }
  
  if (passengers < 1 || passengers > 4) {
    throw new ValidationError('Passenger count must be between 1 and 4')
  }
  
  // In a real implementation, this would:
  // 1. Verify trip exists and has available seats
  // 2. Check if user is not already booked on this trip
  // 3. Create booking request
  // 4. Notify driver
  // 5. Update trip occupancy
  
  const bookingId = crypto.randomUUID()
  const booking = {
    id: bookingId,
    tripId,
    passengerId: user.id,
    passengerName: user.name,
    passengerPhone: '+27 83 555 9999', // Mock phone
    pickupLocation,
    dropoffLocation,
    passengers,
    status: 'pending',
    price: 25.00, // Mock price calculation
    currency: 'ZAR',
    notes: notes || null,
    createdAt: new Date().toISOString()
  }
  
  // Log booking request
  await logAuditEvent(c, {
    userId: user.id,
    action: 'TRIP_BOOKING_REQUEST',
    resourceType: 'trip',
    resourceId: tripId,
    success: true,
    metadata: {
      bookingId,
      passengers,
      pickupAddress: pickupLocation.address,
      dropoffAddress: dropoffLocation.address
    }
  })
  
  return c.json({
    message: 'Booking request submitted successfully',
    booking
  })
})

// Driver creates a new trip offer
tripRoutes.post('/offer', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  
  // Only drivers can offer trips
  if (user.role !== 'driver') {
    return c.json({ error: 'Only drivers can offer trips' }, 403)
  }
  
  const { 
    pickupLocation, 
    dropoffLocation, 
    scheduledTime, 
    availableSeats = 3,
    price,
    vehicleInfo,
    notes
  } = body
  
  // Validate required fields
  if (!pickupLocation || !dropoffLocation || !scheduledTime) {
    throw new ValidationError('Pickup location, dropoff location, and scheduled time are required')
  }
  
  // Validate seat count
  if (availableSeats < 1 || availableSeats > 6) {
    throw new ValidationError('Available seats must be between 1 and 6')
  }
  
  // Validate scheduled time (must be in the future)
  const tripTime = new Date(scheduledTime)
  if (tripTime <= new Date()) {
    throw new ValidationError('Scheduled time must be in the future')
  }
  
  // Validate vehicle info
  if (!vehicleInfo || !vehicleInfo.make || !vehicleInfo.model || !vehicleInfo.licensePlate) {
    throw new ValidationError('Vehicle information is required')
  }
  
  // In a real implementation, this would:
  // 1. Verify driver is approved and active
  // 2. Calculate route and estimated duration
  // 3. Create trip offer in database
  // 4. Make trip searchable by passengers
  
  const tripId = crypto.randomUUID()
  const tripOffer = {
    id: tripId,
    driverId: user.id,
    driverName: user.name,
    pickupLocation,
    dropoffLocation,
    scheduledTime,
    availableSeats,
    price: price || 35.00, // Default price if not provided
    currency: 'ZAR',
    vehicle: {
      make: vehicleInfo.make,
      model: vehicleInfo.model,
      year: vehicleInfo.year || new Date().getFullYear(),
      color: vehicleInfo.color || 'Unknown',
      licensePlate: vehicleInfo.licensePlate,
      capacity: availableSeats + 1, // Including driver
      currentOccupancy: 1 // Driver only initially
    },
    route: {
      distance: 18.5, // Mock calculation
      estimatedDuration: 32, // Mock calculation
      polyline: 'mock_polyline_data' // Would be real route polyline
    },
    status: 'offered',
    carbonSaved: 3.2, // Mock calculation
    notes: notes || null,
    createdAt: new Date().toISOString()
  }
  
  // Log trip offer creation
  await logAuditEvent(c, {
    userId: user.id,
    action: 'TRIP_OFFER_CREATE',
    resourceType: 'trip',
    resourceId: tripId,
    success: true,
    metadata: {
      pickupAddress: pickupLocation.address,
      dropoffAddress: dropoffLocation.address,
      availableSeats,
      scheduledTime
    }
  })
  
  return c.json({
    message: 'Trip offer created successfully',
    trip: tripOffer
  })
})

// Driver accepts a booking request
tripRoutes.post('/:tripId/bookings/:bookingId/accept', async (c) => {
  const user = c.get('user')
  const tripId = c.req.param('tripId')
  const bookingId = c.req.param('bookingId')
  
  // Only drivers can accept bookings
  if (user.role !== 'driver') {
    return c.json({ error: 'Only drivers can accept bookings' }, 403)
  }
  
  // In a real implementation, this would:
  // 1. Verify driver owns the trip
  // 2. Verify booking exists and is pending
  // 3. Check if trip has available seats
  // 4. Accept the booking
  // 5. Notify passenger
  // 6. Update trip occupancy
  
  const acceptedBooking = {
    id: bookingId,
    tripId,
    status: 'accepted',
    acceptedAt: new Date().toISOString()
  }
  
  // Log booking acceptance
  await logAuditEvent(c, {
    userId: user.id,
    action: 'BOOKING_ACCEPT',
    resourceType: 'booking',
    resourceId: bookingId,
    success: true,
    metadata: {
      tripId,
      driverId: user.id
    }
  })
  
  return c.json({
    message: 'Booking accepted successfully',
    booking: acceptedBooking
  })
})

// Driver rejects a booking request
tripRoutes.post('/:tripId/bookings/:bookingId/reject', async (c) => {
  const user = c.get('user')
  const tripId = c.req.param('tripId')
  const bookingId = c.req.param('bookingId')
  const body = await c.req.json()
  
  const { reason } = body
  
  // Only drivers can reject bookings
  if (user.role !== 'driver') {
    return c.json({ error: 'Only drivers can reject bookings' }, 403)
  }
  
  // In a real implementation, this would:
  // 1. Verify driver owns the trip
  // 2. Verify booking exists and is pending
  // 3. Reject the booking with reason
  // 4. Notify passenger
  
  const rejectedBooking = {
    id: bookingId,
    tripId,
    status: 'rejected',
    rejectionReason: reason || 'Driver unavailable',
    rejectedAt: new Date().toISOString()
  }
  
  // Log booking rejection
  await logAuditEvent(c, {
    userId: user.id,
    action: 'BOOKING_REJECT',
    resourceType: 'booking',
    resourceId: bookingId,
    success: true,
    metadata: {
      tripId,
      driverId: user.id,
      reason
    }
  })
  
  return c.json({
    message: 'Booking rejected',
    booking: rejectedBooking
  })
})

// Cancel a trip (by driver or passenger)
tripRoutes.post('/:tripId/cancel', async (c) => {
  const user = c.get('user')
  const tripId = c.req.param('tripId')
  const body = await c.req.json()
  
  const { reason } = body
  
  // In a real implementation, this would:
  // 1. Verify user has permission to cancel trip
  // 2. Check trip status (can only cancel scheduled/offered trips)
  // 3. Process cancellation
  // 4. Notify all affected parties
  // 5. Handle refunds if applicable
  
  const cancelledTrip = {
    id: tripId,
    status: 'cancelled',
    cancellationReason: reason || 'User cancelled',
    cancelledBy: user.id,
    cancelledAt: new Date().toISOString()
  }
  
  // Log trip cancellation
  await logAuditEvent(c, {
    userId: user.id,
    action: 'TRIP_CANCEL',
    resourceType: 'trip',
    resourceId: tripId,
    success: true,
    metadata: {
      cancelledBy: user.id,
      reason
    }
  })
  
  return c.json({
    message: 'Trip cancelled successfully',
    trip: cancelledTrip
  })
})

// Rate a completed trip
tripRoutes.post('/:tripId/rate', async (c) => {
  const user = c.get('user')
  const tripId = c.req.param('tripId')
  const body = await c.req.json()
  
  const { rating, comment } = body
  
  // Validate rating
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    throw new ValidationError('Rating must be a number between 1 and 5')
  }
  
  if (comment && comment.length > 500) {
    throw new ValidationError('Comment must be less than 500 characters')
  }
  
  // In a real implementation, this would:
  // 1. Verify trip exists and is completed
  // 2. Verify user participated in this trip
  // 3. Check if user has already rated this trip
  // 4. Create rating
  // 5. Update driver rating average
  
  const tripRating = {
    id: crypto.randomUUID(),
    tripId,
    userId: user.id,
    userName: user.name,
    rating,
    comment: comment || null,
    createdAt: new Date().toISOString()
  }
  
  // Log rating submission
  await logAuditEvent(c, {
    userId: user.id,
    action: 'TRIP_RATE',
    resourceType: 'trip',
    resourceId: tripId,
    success: true,
    metadata: {
      rating,
      hasComment: !!comment
    }
  })
  
  return c.json({
    message: 'Rating submitted successfully',
    rating: tripRating
  })
})

export default tripRoutes