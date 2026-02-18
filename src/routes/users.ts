/**
 * Klubz - User Routes (Production D1)
 *
 * Real D1 queries for user profile, trips, and preferences.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';
import { eventBus } from '../lib/eventBus';
import { getDB } from '../lib/db';
import { getIP, getUserAgent } from '../lib/http';
import { decrypt, hashForLookup } from '../lib/encryption';
import { AppError, ValidationError } from '../lib/errors';
import { getCacheService } from '../lib/cache';
import { DEFAULT_USER_PREFERENCES, getUserPreferences, upsertUserPreferences } from '../lib/userPreferences';

export const userRoutes = new Hono<AppEnv>();

// All user routes require auth
userRoutes.use('*', authMiddleware());

interface UserProfileRow {
  id: number;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  phone_encrypted: string | null;
  avatar_url: string | null;
  role: string;
  email_verified: number;
  mfa_enabled: number;
  created_at: string;
  last_login_at: string | null;
  total_trips: number;
  completed_trips: number;
  avg_rating: number | null;
}

interface UpdateProfileBody {
  name?: string;
  phone?: string;
  avatar?: string | null;
}

interface UserTripRow {
  id: number;
  title: string | null;
  description: string | null;
  origin: string;
  destination: string;
  departure_time: string;
  status: string;
  participant_role: string;
  participant_status: string;
  pickup_location_encrypted: string | null;
  dropoff_location_encrypted: string | null;
  price_per_seat: number;
  currency: string | null;
  available_seats: number;
  total_seats: number;
  vehicle_type: string;
  rating: number | null;
  driver_first_name: string | null;
  driver_last_name: string | null;
  driver_avatar: string | null;
  created_at: string;
}

interface PreferencesBody {
  notifications?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
  accessibility?: Record<string, unknown>;
  language?: string;
  timezone?: string;
  currency?: string;
}

interface ExportUserRow {
  id: number;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  phone_encrypted: string | null;
  role: string;
  email_verified: number;
  phone_verified: number;
  mfa_enabled: number;
  created_at: string;
  last_login_at: string | null;
  created_ip: string | null;
}

interface CountRow {
  count: number;
}

const userTripStatusFilters = new Set(['scheduled', 'active', 'completed', 'cancelled']);

const createTripSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  pickupLocation: z.object({
    address: z.string().trim().min(1).optional(),
  }).passthrough(),
  dropoffLocation: z.object({
    address: z.string().trim().min(1).optional(),
  }).passthrough(),
  scheduledTime: z.string().min(1),
  availableSeats: z.number().int().min(1).max(6).optional(),
  totalSeats: z.number().int().min(1).max(8).optional(),
  price: z.number().min(0).max(10000).optional(),
});

function parseQueryInteger(
  value: string | undefined,
  defaultValue: number,
  options: { min: number; max: number },
): number | null {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== value.trim()) {
    return null;
  }
  if (parsed < options.min || parsed > options.max) {
    return null;
  }
  return parsed;
}

function parseError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// GET /profile
// ---------------------------------------------------------------------------

userRoutes.get('/profile', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDB(c);
  const cache = getCacheService(c);

  const cacheKey = `user:profile:${user.id}`;

  // Try cache first
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      logger.debug('User profile cache hit', { userId: user.id });
      return c.json(cached);
    }
  }

  try {
    const row = await db
      .prepare(
        `SELECT u.id, u.email, u.first_name_encrypted, u.last_name_encrypted, u.phone_encrypted,
                u.avatar_url, u.role, u.is_active, u.email_verified, u.mfa_enabled,
                u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM trip_participants tp WHERE tp.user_id = u.id) as total_trips,
                (SELECT COALESCE(SUM(CASE WHEN tp.status = 'completed' THEN 1 ELSE 0 END), 0) FROM trip_participants tp WHERE tp.user_id = u.id) as completed_trips,
                (SELECT COALESCE(AVG(tp.rating), 0) FROM trip_participants tp WHERE tp.user_id = u.id AND tp.rating IS NOT NULL) as avg_rating
         FROM users u WHERE u.id = ? AND u.deleted_at IS NULL`
      )
      .bind(user.id)
      .first<UserProfileRow>();

    if (!row) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
    }

    const profile = {
      id: row.id,
      email: row.email,
      name: [row.first_name_encrypted, row.last_name_encrypted].filter(Boolean).join(' ') || user.name,
      role: row.role,
      phone: row.phone_encrypted || null,
      avatar: row.avatar_url || null,
      emailVerified: !!row.email_verified,
      mfaEnabled: !!row.mfa_enabled,
      stats: {
        totalTrips: row.total_trips ?? 0,
        completedTrips: row.completed_trips ?? 0,
        totalDistance: 0, // computed from trips if needed
        carbonSaved: (row.completed_trips ?? 0) * 2.1, // estimate
        rating: row.avg_rating ? parseFloat(Number(row.avg_rating).toFixed(1)) : 0,
      },
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };

    // Cache for 10 minutes
    if (cache) {
      await cache.set(cacheKey, profile, 600);
    }

    return c.json(profile);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Profile DB error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load profile' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /profile
// ---------------------------------------------------------------------------

userRoutes.put('/profile', async (c) => {
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const payload = body as UpdateProfileBody;

  if (payload.name && payload.name.length < 2) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Name must be at least 2 characters' } }, 400);
  }
  if (payload.phone && !/^\+?[\d\s\-()]+$/.test(payload.phone)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid phone number format' } }, 400);
  }

  const db = getDB(c);
  try {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (payload.name) {
      const [first, ...rest] = payload.name.split(' ');
      parts.push('first_name_encrypted = ?', 'last_name_encrypted = ?');
      values.push(first, rest.join(' ') || null);
    }
    if (payload.phone !== undefined) { parts.push('phone_encrypted = ?'); values.push(payload.phone || null); }
    if (payload.avatar !== undefined) { parts.push('avatar_url = ?'); values.push(payload.avatar || null); }

    parts.push('updated_at = CURRENT_TIMESTAMP');
    values.push(user.id);

    await db.prepare(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`).bind(...values).run();

    // Invalidate profile cache
    const cache = getCacheService(c);
    if (cache) {
      await cache.delete(`user:profile:${user.id}`);
    }

    return c.json({ message: 'Profile updated', updatedAt: new Date().toISOString() });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Profile update error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update profile' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /trips
// ---------------------------------------------------------------------------

userRoutes.get('/trips', async (c) => {
  const user = c.get('user') as AuthUser;
  const page = parseQueryInteger(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }
  const limit = parseQueryInteger(c.req.query('limit'), 10, { min: 1, max: 50 });
  if (limit === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
  }
  const status = c.req.query('status');
  if (status && !userTripStatusFilters.has(status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } }, 400);
  }
  const db = getDB(c);

  try {
    let countSql = 'SELECT COUNT(*) as total FROM trip_participants tp JOIN trips t ON tp.trip_id = t.id WHERE tp.user_id = ?';
    let dataSql = `
        SELECT t.id, t.title, t.description, t.origin, t.destination, t.departure_time,
               t.arrival_time, t.available_seats, t.total_seats, t.price_per_seat,
               t.currency, t.status, t.vehicle_type, t.created_at,
               tp.role as participant_role, tp.status as participant_status,
               tp.pickup_location_encrypted, tp.dropoff_location_encrypted,
               tp.rating,
               u.first_name_encrypted as driver_first_name,
               u.last_name_encrypted as driver_last_name,
               u.avatar_url as driver_avatar
        FROM trip_participants tp
        JOIN trips t ON tp.trip_id = t.id
        LEFT JOIN users u ON t.driver_id = u.id
        WHERE tp.user_id = ?`;

    const params: unknown[] = [user.id];

    if (status) {
      countSql += ' AND t.status = ?';
      dataSql += ' AND t.status = ?';
      params.push(status);
    }

    dataSql += ' ORDER BY t.departure_time DESC LIMIT ? OFFSET ?';

    const countResult = await db.prepare(countSql).bind(...params).first<{ total: number }>();
    const total = countResult?.total ?? 0;

    const dataParams = [...params, limit, (page - 1) * limit];
    const { results } = await db.prepare(dataSql).bind(...dataParams).all<UserTripRow>();

    const trips = (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      pickupLocation: r.pickup_location_encrypted ? { address: r.pickup_location_encrypted } : { address: r.origin },
      dropoffLocation: r.dropoff_location_encrypted ? { address: r.dropoff_location_encrypted } : { address: r.destination },
      scheduledTime: r.departure_time,
      status: r.status,
      participantRole: r.participant_role,
      participantStatus: r.participant_status,
      price: r.price_per_seat,
      currency: r.currency || 'ZAR',
      availableSeats: r.available_seats,
      totalSeats: r.total_seats,
      vehicleType: r.vehicle_type,
      rating: r.rating,
      carbonSaved: 2.1, // estimate per trip
      driver: {
        name: [r.driver_first_name, r.driver_last_name].filter(Boolean).join(' ') || 'Driver',
        avatar: r.driver_avatar || null,
      },
      createdAt: r.created_at,
    }));

    return c.json({
      trips,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('User trips DB error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load trips' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /trips  (create)
// ---------------------------------------------------------------------------

userRoutes.post('/trips', async (c) => {
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const parsed = createTripSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => i.message).join(', ') } }, 400);
  }
  const payload = parsed.data;

  const scheduledTime = new Date(payload.scheduledTime);
  if (Number.isNaN(scheduledTime.getTime()) || scheduledTime <= new Date()) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Scheduled time must be in the future' } }, 400);
  }
  const totalSeats = payload.totalSeats ?? 4;
  const availableSeats = payload.availableSeats ?? 3;
  if (availableSeats > totalSeats) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Available seats cannot exceed total seats' } }, 400);
  }

  const db = getDB(c);
  try {
    const result = await db
      .prepare(
        `INSERT INTO trips (title, description, origin, destination, origin_hash, destination_hash, departure_time, available_seats, total_seats, price_per_seat, currency, status, vehicle_type, driver_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 'sedan', ?)`
      )
      .bind(
        payload.title || 'Trip',
        payload.notes || null,
        payload.pickupLocation.address || JSON.stringify(payload.pickupLocation),
        payload.dropoffLocation.address || JSON.stringify(payload.dropoffLocation),
        'hash_' + Date.now(),
        'hash_' + (Date.now() + 1),
        payload.scheduledTime,
        availableSeats,
        totalSeats,
        payload.price || 35.00,
        'ZAR',
        user.id,
      )
      .run();

    const tripId = result?.meta?.last_row_id ?? 0;

    // Emit real-time event
    eventBus.emit('trip:created', {
      tripId,
      driverId: user.id,
      title: payload.title || 'Trip',
      scheduledTime: payload.scheduledTime,
    }, user.id);

    return c.json({ message: 'Trip created successfully', trip: { id: tripId, status: 'scheduled', createdAt: new Date().toISOString() } });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Trip create error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create trip' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /preferences
// ---------------------------------------------------------------------------

userRoutes.get('/preferences', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDB(c);

  try {
    const prefs = await getUserPreferences(db, user.id);
    return c.json(prefs);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.warn('Failed to fetch user preferences, falling back to defaults', {
      userId: user.id,
      error: parsed.message,
    });
    return c.json(DEFAULT_USER_PREFERENCES);
  }
});

// ---------------------------------------------------------------------------
// PUT /preferences
// ---------------------------------------------------------------------------

userRoutes.put('/preferences', async (c) => {
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const payload = body as PreferencesBody;
  const db = getDB(c);

  if (payload.notifications !== undefined && typeof payload.notifications !== 'object') {
    throw new ValidationError('notifications must be an object');
  }
  if (payload.privacy !== undefined && typeof payload.privacy !== 'object') {
    throw new ValidationError('privacy must be an object');
  }
  if (payload.accessibility !== undefined && typeof payload.accessibility !== 'object') {
    throw new ValidationError('accessibility must be an object');
  }

  const updated = await upsertUserPreferences(db, user.id, {
    notifications: payload.notifications as unknown as typeof DEFAULT_USER_PREFERENCES.notifications,
    privacy: payload.privacy as unknown as typeof DEFAULT_USER_PREFERENCES.privacy,
    accessibility: payload.accessibility as unknown as typeof DEFAULT_USER_PREFERENCES.accessibility,
    language: payload.language,
    timezone: payload.timezone,
    currency: payload.currency,
  });

  return c.json(updated);
});

// ---------------------------------------------------------------------------
// GET /export - GDPR Data Export (Article 15 - Right of Access)
// ---------------------------------------------------------------------------

userRoutes.get('/export', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDB(c);

  try {
    // Fetch all user data in parallel
    const [userData, trips, auditLogs, participants] = await db.batch([
      db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id),
      db.prepare(`
        SELECT t.* FROM trips t
        WHERE t.driver_id = ?
        ORDER BY t.created_at DESC
      `).bind(user.id),
      db.prepare(`
        SELECT * FROM audit_logs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1000
      `).bind(user.id),
      db.prepare(`
        SELECT tp.*, t.title, t.origin, t.destination
        FROM trip_participants tp
        JOIN trips t ON tp.trip_id = t.id
        WHERE tp.user_id = ?
        ORDER BY tp.created_at DESC
      `).bind(user.id),
    ]);

    const userRecord = (userData.results ?? [])[0] as ExportUserRow | undefined;

    if (!userRecord) {
      throw new AppError('User not found', 'NOT_FOUND', 404);
    }

    // Decrypt PII for export
    const encryptionKey = c.env?.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new AppError('Encryption key not configured', 'CONFIGURATION_ERROR', 500);
    }

    const decryptedData = {
      profile: {
        id: userRecord.id,
        email: userRecord.email,
        firstName: userRecord.first_name_encrypted ?
          await decrypt(JSON.parse(userRecord.first_name_encrypted), encryptionKey, user.id.toString()).catch(() => null) : null,
        lastName: userRecord.last_name_encrypted ?
          await decrypt(JSON.parse(userRecord.last_name_encrypted), encryptionKey, user.id.toString()).catch(() => null) : null,
        phone: userRecord.phone_encrypted ?
          await decrypt(JSON.parse(userRecord.phone_encrypted), encryptionKey, user.id.toString()).catch(() => null) : null,
        role: userRecord.role,
        emailVerified: userRecord.email_verified,
        phoneVerified: userRecord.phone_verified,
        mfaEnabled: userRecord.mfa_enabled,
        createdAt: userRecord.created_at,
        lastLoginAt: userRecord.last_login_at,
        createdIP: userRecord.created_ip,
      },
      trips: {
        asDriver: trips.results ?? [],
        asPassenger: participants.results ?? [],
      },
      auditLogs: auditLogs.results ?? [],
    };

    // Log export request
    try {
      await db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, created_at)
        VALUES (?, 'DATA_EXPORT', 'user', ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(user.id, user.id, getIP(c), getUserAgent(c)).run();
    } catch (err: unknown) {
      logger.warn('Audit log insert failed (non-critical)', {
        error: err instanceof Error ? err.message : String(err),
        action: 'DATA_EXPORT',
      });
    }

    logger.info('User data exported', { userId: user.id });

    return c.json({
      exportedAt: new Date().toISOString(),
      userId: user.id,
      data: decryptedData,
      meta: {
        tripsCount: (trips.results ?? []).length,
        participationsCount: (participants.results ?? []).length,
        auditLogsCount: (auditLogs.results ?? []).length,
      }
    });
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    logger.error('Data export failed', {
      error: err instanceof Error ? err.message : String(err),
      userId: user.id
    });
    throw new AppError('Failed to export user data', 'EXPORT_FAILED', 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /account - GDPR Data Deletion (Article 17 - Right to be Forgotten)
// ---------------------------------------------------------------------------

userRoutes.delete('/account', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDB(c);

  try {
    // Check for active trips as participant
    const activeTrips = await db.prepare(`
      SELECT COUNT(*) as count
      FROM trip_participants
      WHERE user_id = ?
      AND status IN ('requested', 'accepted')
    `).bind(user.id).first<CountRow>();

    if (activeTrips && activeTrips.count > 0) {
      throw new ValidationError(
        'Cannot delete account with active trips. Please cancel them first.',
        { activeTripsCount: activeTrips.count }
      );
    }

    // Check for active trips as driver
    const activeDriverTrips = await db.prepare(`
      SELECT COUNT(*) as count
      FROM trips
      WHERE driver_id = ?
      AND status IN ('scheduled', 'active')
    `).bind(user.id).first<CountRow>();

    if (activeDriverTrips && activeDriverTrips.count > 0) {
      throw new ValidationError(
        'Cannot delete account while driving active trips. Please cancel your trips first.',
        { activeDriverTripsCount: activeDriverTrips.count }
      );
    }

    // Soft delete with data anonymization
    const deletedEmail = `deleted_${user.id}_${Date.now()}@klubz.deleted`;
    const deletedEmailHash = await hashForLookup(deletedEmail);

    await db.prepare(`
      UPDATE users
      SET
        deleted_at = CURRENT_TIMESTAMP,
        email = ?,
        email_hash = ?,
        first_name_encrypted = NULL,
        last_name_encrypted = NULL,
        phone_encrypted = NULL,
        avatar_url = NULL,
        mfa_secret_encrypted = NULL,
        backup_codes_encrypted = NULL,
        is_active = 0
      WHERE id = ?
    `).bind(deletedEmail, deletedEmailHash, user.id).run();

    // Anonymize trip participant data
    await db.prepare(`
      UPDATE trip_participants
      SET
        pickup_location_encrypted = NULL,
        dropoff_location_encrypted = NULL,
        review_encrypted = NULL
      WHERE user_id = ?
    `).bind(user.id).run();

    // Log deletion request
    try {
      await db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, created_at)
        VALUES (?, 'ACCOUNT_DELETED', 'user', ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(user.id, user.id, getIP(c), getUserAgent(c)).run();
    } catch (err: unknown) {
      logger.warn('Audit log insert failed (non-critical)', {
        error: err instanceof Error ? err.message : String(err),
        action: 'ACCOUNT_DELETED',
      });
    }

    logger.info('User account deleted', { userId: user.id });

    const deletedAt = new Date();
    const permanentDeletionDate = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    return c.json({
      message: 'Account deleted successfully. Personal data anonymized. Account will be permanently removed in 30 days as per GDPR/POPIA requirements.',
      deletedAt: deletedAt.toISOString(),
      permanentDeletionDate: permanentDeletionDate.toISOString(),
    });
  } catch (err: unknown) {
    if (err instanceof ValidationError || err instanceof AppError) throw err;
    logger.error('Account deletion failed', {
      error: err instanceof Error ? err.message : String(err),
      userId: user.id
    });
    throw new AppError('Failed to delete account', 'DELETION_FAILED', 500);
  }
});

export default userRoutes;
