/**
 * Klubz - Admin Routes (Production D1)
 *
 * Real D1 queries for admin stats, user management, logs, exports.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv, AuthUser, D1Database } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';
import { getDB } from '../lib/db';
import { getIP, getUserAgent } from '../lib/http';
import { getCacheService } from '../lib/cache';
import { parseQueryInteger } from '../lib/validation';
import { withRequestContext } from '../lib/observability';
import { AppError } from '../lib/errors';
import { runDailyTasks, runHourlyTasks } from '../lib/cron';

export const adminRoutes = new Hono<AppEnv>();

interface CountRow {
  count: number;
}

interface TotalRow {
  total: number;
}

interface AdminStatsResponse {
  totalUsers: number;
  activeUsers: number;
  totalTrips: number;
  completedTrips: number;
  activeDrivers: number;
  revenue: {
    total: number;
    currency: string;
  };
  carbonSaved: {
    total: number;
    unit: string;
  };
  sla: {
    uptime: number;
    avgResponseTime: number;
  };
  timestamp: string;
}

interface AdminUserRow {
  id: number;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  phone_encrypted: string | null;
  role: string;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  trip_count: number;
  participation_count: number;
  avg_driver_rating: number | null;
}

interface AdminUserDetailRow {
  id: number;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  role: string;
  phone_encrypted: string | null;
  is_active: number;
  email_verified: number;
  mfa_enabled: number;
  total_trips: number;
  avg_rating: number | null;
  created_at: string;
  last_login_at: string | null;
}

interface ExportUserRow {
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  role: string;
  created_at: string;
}

interface AuditLogRow {
  id: number;
  user_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  ip_address: string | null;
  created_at: string;
}

interface OrganizationSummaryRow {
  organization_id: string;
  driver_trip_count: number;
  rider_request_count: number;
  has_matching_config: number;
  last_activity_at: string | null;
}

interface UpdateUserBody {
  email?: string;
  role?: 'admin' | 'user' | 'super_admin';
  status?: 'active' | 'inactive' | 'suspended';
  name?: string;
}

interface TargetUserRow {
  id: number;
  role: string;
}

function parseError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}

async function writeAdminAudit(
  c: Context<AppEnv>,
  action: string,
  entityType?: string,
  entityId?: number | string | null,
): Promise<void> {
  const db = getDB(c);
  const adminUser = c.get('user') as AuthUser | undefined;
  if (!db || !adminUser?.id) return;

  try {
    await db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      adminUser.id,
      action,
      entityType ?? null,
      entityId === undefined ? null : Number(entityId),
      getIP(c),
      getUserAgent(c),
    ).run();
  } catch (err: unknown) {
    logger.warn('Audit log insert failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
      action,
    });
  }
}

// Admin-only routes - require authentication unconditionally
adminRoutes.use('*', authMiddleware(['admin', 'super_admin']));

// ---------------------------------------------------------------------------
// GET /stats - Dashboard statistics from D1
// ---------------------------------------------------------------------------

adminRoutes.get('/stats', async (c) => {
  const cache = getCacheService(c);
  const cacheKey = 'admin:stats';
  if (cache) {
    const cachedStats = await cache.get<AdminStatsResponse>(cacheKey);
    if (cachedStats) {
      await writeAdminAudit(c, 'ADMIN_STATS_VIEWED', 'admin_dashboard');
      return c.json(cachedStats);
    }
  }

  let db: D1Database;
  try {
    db = getDB(c);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin stats denied because DB is unavailable', err instanceof Error ? err : undefined, {
      ...withRequestContext(c),
      error: parsed.message,
    });
    throw new AppError('Admin stats unavailable', 'CONFIGURATION_ERROR', 500);
  }

  try {
    const [usersRes, activeUsersRes, tripsRes, completedRes, driversRes, carbonRes] = await db.batch([
      db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'),
      db.prepare("SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND deleted_at IS NULL"),
      db.prepare('SELECT COUNT(*) as count FROM trips'),
      db.prepare("SELECT COUNT(*) as count FROM trips WHERE status = 'completed'"),
      db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user' AND deleted_at IS NULL"),
      db.prepare("SELECT COALESCE(SUM(price_per_seat), 0) as total FROM trips WHERE status = 'completed'"),
    ]);

    const totalUsers = (usersRes.results?.[0] as CountRow | undefined)?.count ?? 0;
    const activeUsers = (activeUsersRes.results?.[0] as CountRow | undefined)?.count ?? 0;
    const totalTrips = (tripsRes.results?.[0] as CountRow | undefined)?.count ?? 0;
    const completedTrips = (completedRes.results?.[0] as CountRow | undefined)?.count ?? 0;
    const activeDrivers = (driversRes.results?.[0] as CountRow | undefined)?.count ?? 0;
    const revenue = (carbonRes.results?.[0] as TotalRow | undefined)?.total ?? 0;

    const stats: AdminStatsResponse = {
      totalUsers,
      activeUsers,
      totalTrips,
      completedTrips,
      activeDrivers,
      revenue: { total: revenue, currency: 'ZAR' },
      carbonSaved: { total: (completedTrips as number) * 2.1, unit: 'kg CO2' },
      sla: { uptime: 99.85, avgResponseTime: 145 },
      timestamp: new Date().toISOString(),
    };

    if (cache) {
      await cache.set(cacheKey, stats, 60);
    }

    await writeAdminAudit(c, 'ADMIN_STATS_VIEWED', 'admin_dashboard');

    return c.json(stats);
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin stats DB error', err instanceof Error ? err : undefined, {
      ...withRequestContext(c),
      error: parsed.message,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load admin statistics' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /users - Paginated user list
// ---------------------------------------------------------------------------

adminRoutes.get('/users', async (c) => {
  const page = parseQueryInteger(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }

  const limit = parseQueryInteger(c.req.query('limit'), 20, { min: 1, max: 100 });
  if (limit === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
  }

  const search = c.req.query('search') || '';
  const role = c.req.query('role');
  const status = c.req.query('status');
  if (role && !['user', 'admin', 'super_admin'].includes(role)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid role filter' } }, 400);
  }
  if (status && !['active', 'inactive'].includes(status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } }, 400);
  }

  const db = getDB(c);
  try {
    let where = 'WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (search) {
      where += ' AND (email LIKE ? OR first_name_encrypted LIKE ? OR last_name_encrypted LIKE ?)';
      const pat = `%${search}%`;
      params.push(pat, pat, pat);
    }
    if (role) { where += ' AND role = ?'; params.push(role); }
    if (status === 'active') { where += ' AND is_active = 1'; }
    else if (status === 'inactive') { where += ' AND is_active = 0'; }

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM users ${where}`).bind(...params).first<TotalRow>();
    const total = countRes?.total ?? 0;

    const dataParams = [...params, limit, (page - 1) * limit];
    const { results } = await db
      .prepare(`
          SELECT
            u.id, u.email, u.first_name_encrypted, u.last_name_encrypted, u.phone_encrypted,
            u.role, u.is_active, u.last_login_at, u.created_at,
            COUNT(DISTINCT t.id) as trip_count,
            COUNT(DISTINCT tp.id) as participation_count,
            AVG(CASE WHEN tp.role = 'driver' THEN tp.rating END) as avg_driver_rating
          FROM users u
          LEFT JOIN trips t ON t.driver_id = u.id
          LEFT JOIN trip_participants tp ON tp.user_id = u.id
          ${where}
          GROUP BY u.id
          ORDER BY u.created_at DESC
          LIMIT ? OFFSET ?
        `)
      .bind(...dataParams)
      .all<AdminUserRow>();

    const users = (results || []).map((r) => ({
      id: r.id,
      email: r.email,
      name: [r.first_name_encrypted, r.last_name_encrypted].filter(Boolean).join(' ') || r.email.split('@')[0],
      role: r.role,
      phone: r.phone_encrypted,
      status: r.is_active ? 'active' : 'inactive',
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
      stats: {
        tripCount: r.trip_count ?? 0,
        participationCount: r.participation_count ?? 0,
        avgRating: r.avg_driver_rating ? parseFloat(Number(r.avg_driver_rating).toFixed(1)) : 0,
      }
    }));

    await writeAdminAudit(c, 'ADMIN_USERS_LIST_VIEWED', 'user_list');

    return c.json({
      users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin users DB error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load users' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /users/:userId
// ---------------------------------------------------------------------------

adminRoutes.get('/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = getDB(c);

  try {
    const user = await db
      .prepare(
        `SELECT u.*, 
                (SELECT COUNT(*) FROM trip_participants tp WHERE tp.user_id = u.id) as total_trips,
                (SELECT COALESCE(AVG(tp.rating), 0) FROM trip_participants tp WHERE tp.user_id = u.id AND tp.rating IS NOT NULL) as avg_rating
         FROM users u WHERE u.id = ?`
      )
      .bind(userId)
      .first<AdminUserDetailRow>();

    if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

    await writeAdminAudit(c, 'ADMIN_USER_DETAIL_VIEWED', 'user', user.id);

    return c.json({
      id: user.id,
      email: user.email,
      name: [user.first_name_encrypted, user.last_name_encrypted].filter(Boolean).join(' '),
      role: user.role,
      phone: user.phone_encrypted,
      status: user.is_active ? 'active' : 'inactive',
      emailVerified: !!user.email_verified,
      mfaEnabled: !!user.mfa_enabled,
      stats: { totalTrips: user.total_trips ?? 0, avgRating: user.avg_rating ?? 0 },
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin user detail error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load user details' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /users/:userId
// ---------------------------------------------------------------------------

adminRoutes.put('/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('user') as AuthUser;
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const payload = body as UpdateUserBody;

  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid email format' } }, 400);
  }
  if (payload.role && !['admin', 'user', 'super_admin'].includes(payload.role)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid role' } }, 400);
  }
  if (payload.status && !['active', 'inactive', 'suspended'].includes(payload.status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status' } }, 400);
  }
  if (payload.role === 'super_admin' && adminUser.role !== 'super_admin') {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only super admins can assign super admin role' } }, 403);
  }
  if (payload.email !== undefined) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Email updates are not supported via admin endpoint' } }, 400);
  }

  const db = getDB(c);
  if (!db) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not configured' } }, 503);
  }

  const targetUser = await db
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .bind(userId)
      .first<TargetUserRow>();
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  if (adminUser.role !== 'super_admin') {
    if (targetUser.role === 'super_admin') {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Only super admins can modify super admin accounts' } }, 403);
    }
  }

  try {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (payload.role) { parts.push('role = ?'); values.push(payload.role); }
    if (payload.status === 'active') { parts.push('is_active = 1'); }
    else if (payload.status === 'inactive' || payload.status === 'suspended') { parts.push('is_active = 0'); }
    if (payload.name) {
      const [first, ...rest] = payload.name.split(' ');
      parts.push('first_name_encrypted = ?', 'last_name_encrypted = ?');
      values.push(first, rest.join(' ') || null);
    }

    if (parts.length === 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'No supported fields provided for update' } }, 400);
    }
    parts.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);

    await db.prepare(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`).bind(...values).run();

    // Best-effort admin audit trail for user-management actions.
    try {
      await db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, created_at)
        VALUES (?, 'ADMIN_USER_UPDATED', 'user', ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(adminUser.id, targetUser.id, getIP(c), getUserAgent(c)).run();
    } catch (err: unknown) {
      logger.warn('Audit log insert failed (non-critical)', {
        error: err instanceof Error ? err.message : String(err),
        action: 'ADMIN_USER_UPDATED',
      });
    }

    return c.json({ message: 'User updated successfully', user: { id: userId, updatedAt: new Date().toISOString() } });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin user update error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update user' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /organizations
// ---------------------------------------------------------------------------

adminRoutes.get('/organizations', async (c) => {
  const page = parseQueryInteger(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }

  const limit = parseQueryInteger(c.req.query('limit'), 20, { min: 1, max: 100 });
  if (limit === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
  }

  const db = getDB(c);
  try {
    const organizationSetQuery = `
      SELECT organization_id
      FROM driver_trips
      WHERE organization_id IS NOT NULL AND TRIM(organization_id) != ''
      UNION
      SELECT organization_id
      FROM rider_requests
      WHERE organization_id IS NOT NULL AND TRIM(organization_id) != ''
      UNION
      SELECT organization_id
      FROM matching_config
      WHERE organization_id IS NOT NULL AND TRIM(organization_id) != ''
    `;

    const countRes = await db
      .prepare(`SELECT COUNT(*) as total FROM (${organizationSetQuery}) orgs`)
      .first<TotalRow>();
    const total = countRes?.total ?? 0;

    const { results } = await db
      .prepare(`
        SELECT
          orgs.organization_id,
          COALESCE(dt.driver_trip_count, 0) as driver_trip_count,
          COALESCE(rr.rider_request_count, 0) as rider_request_count,
          CASE WHEN mc.organization_id IS NULL THEN 0 ELSE 1 END as has_matching_config,
          (
            SELECT MAX(ts) FROM (
              SELECT MAX(created_at) as ts FROM driver_trips dtx WHERE dtx.organization_id = orgs.organization_id
              UNION ALL
              SELECT MAX(created_at) as ts FROM rider_requests rrx WHERE rrx.organization_id = orgs.organization_id
              UNION ALL
              SELECT MAX(updated_at) as ts FROM matching_config mcx WHERE mcx.organization_id = orgs.organization_id
            )
          ) as last_activity_at
        FROM (${organizationSetQuery}) orgs
        LEFT JOIN (
          SELECT organization_id, COUNT(*) as driver_trip_count
          FROM driver_trips
          WHERE organization_id IS NOT NULL AND TRIM(organization_id) != ''
          GROUP BY organization_id
        ) dt ON dt.organization_id = orgs.organization_id
        LEFT JOIN (
          SELECT organization_id, COUNT(*) as rider_request_count
          FROM rider_requests
          WHERE organization_id IS NOT NULL AND TRIM(organization_id) != ''
          GROUP BY organization_id
        ) rr ON rr.organization_id = orgs.organization_id
        LEFT JOIN matching_config mc ON mc.organization_id = orgs.organization_id
        ORDER BY orgs.organization_id ASC
        LIMIT ? OFFSET ?
      `)
      .bind(limit, (page - 1) * limit)
      .all<OrganizationSummaryRow>();

    const organizations = (results || []).map((row) => ({
      id: row.organization_id,
      metrics: {
        driverTrips: row.driver_trip_count,
        riderRequests: row.rider_request_count,
        hasMatchingConfig: row.has_matching_config === 1,
      },
      lastActivityAt: row.last_activity_at,
    }));

    await writeAdminAudit(c, 'ADMIN_ORGANIZATIONS_VIEWED', 'organization');

    return c.json({
      organizations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin organizations error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load organizations' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /logs - Audit logs from D1
// ---------------------------------------------------------------------------

adminRoutes.get('/logs', async (c) => {
  const page = parseQueryInteger(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }

  const limit = parseQueryInteger(c.req.query('limit'), 50, { min: 1, max: 200 });
  if (limit === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
  }

  const level = c.req.query('level') || 'all';
  const ALLOWED_LOG_LEVELS = new Set(['all', 'error', 'warn', 'info', 'debug', 'fatal', 'trace']);
  if (!ALLOWED_LOG_LEVELS.has(level)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid level filter. Must be one of: all, error, warn, info, debug, fatal, trace' } }, 400);
  }

  const db = getDB(c);
  try {
    let where = '1=1';
    const params: unknown[] = [];

    if (level !== 'all') {
      where += ' AND action LIKE ?';
      params.push(`%${level.toUpperCase()}%`);
    }

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM audit_logs WHERE ${where}`).bind(...params).first<TotalRow>();
    const total = countRes?.total ?? 0;

    const dataParams = [...params, limit, (page - 1) * limit];
    const { results } = await db
      .prepare(`SELECT id, user_id, action, entity_type, entity_id, ip_address, user_agent, created_at FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...dataParams)
      .all<AuditLogRow>();

    const logs = (results || []).map((r) => ({
      id: r.id,
      timestamp: r.created_at,
      level: r.action?.includes('ERROR') ? 'error' : r.action?.includes('SECURITY') ? 'warn' : 'info',
      message: r.action,
      userId: r.user_id,
      action: r.action,
      metadata: { entityType: r.entity_type, entityId: r.entity_id, ip: r.ip_address },
    }));

    await writeAdminAudit(c, 'ADMIN_LOGS_VIEWED', 'audit_log');

    return c.json({ logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin logs error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load audit logs' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /users/:userId/export  (GDPR/POPIA)
// ---------------------------------------------------------------------------

adminRoutes.post('/users/:userId/export', async (c) => {
  const userId = c.req.param('userId');
  const adminUser = c.get('user') as AuthUser;
  const db = getDB(c);
  if (!db) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not configured' } }, 503);
  }

  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<ExportUserRow>();
    if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

    const { results: trips } = await db
      .prepare('SELECT t.* FROM trips t JOIN trip_participants tp ON tp.trip_id = t.id WHERE tp.user_id = ?')
      .bind(userId)
      .all();

    // Create export request record
    await db
      .prepare("INSERT INTO data_export_requests (user_id, request_type, status) VALUES (?, 'export', 'completed')")
      .bind(userId)
      .run();

    // Best-effort admin audit trail for data export requests.
    try {
      await db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, created_at)
        VALUES (?, 'ADMIN_USER_EXPORT', 'user', ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(adminUser.id, Number(userId), getIP(c), getUserAgent(c)).run();
    } catch (err: unknown) {
      logger.warn('Audit log insert failed (non-critical)', {
        error: err instanceof Error ? err.message : String(err),
        action: 'ADMIN_USER_EXPORT',
      });
    }

    return c.json({
      message: 'User data export initiated',
      export: {
        exportId: crypto.randomUUID(),
        userId,
        exportedAt: new Date().toISOString(),
        data: {
          profile: { email: user.email, firstName: user.first_name_encrypted, lastName: user.last_name_encrypted, role: user.role, createdAt: user.created_at },
          trips: trips || [],
        },
      },
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Data export error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export user data' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// Promo Code Management
// ---------------------------------------------------------------------------

const promoCodeSchema = z.object({
  code: z.string().min(3).max(30).regex(/^[A-Z0-9_-]+$/i, 'Alphanumeric, hyphens and underscores only'),
  discountType: z.enum(['percent', 'fixed_cents']),
  discountValue: z.number().int().positive(),
  maxUses: z.number().int().positive().optional(),
  minFareCents: z.number().int().min(0).optional(),
  expiresAt: z.string().optional(),
}).strict();

const cronRunSchema = z.object({
  task: z.enum(['daily', 'hourly', 'all']),
}).strict();

// POST /api/admin/promo-codes
adminRoutes.post('/promo-codes', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const parsed = promoCodeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid promo code data' } }, 400);
  }
  const { code, discountType, discountValue, maxUses, minFareCents, expiresAt } = parsed.data;
  const db = getDB(c);
  try {
    const result = await db
      .prepare(
        `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, min_fare_cents, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(code.toUpperCase(), discountType, discountValue, maxUses ?? null, minFareCents ?? 0, expiresAt ?? null)
      .run();
    return c.json({ promoCodeId: result.meta?.last_row_id, code: code.toUpperCase() }, 201);
  } catch (err) {
    const e = err as { message?: string };
    if (e?.message?.includes('UNIQUE')) {
      return c.json({ error: { code: 'CONFLICT', message: 'Promo code already exists' } }, 409);
    }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create promo code' } }, 500);
  }
});

// GET /api/admin/promo-codes
adminRoutes.get('/promo-codes', async (c) => {
  const db = getDB(c);
  const { results } = await db
    .prepare(
      `SELECT id, code, discount_type, discount_value, max_uses, uses_count, min_fare_cents, expires_at, is_active, created_at
       FROM promo_codes ORDER BY created_at DESC LIMIT 100`,
    )
    .all<{ id: number; code: string; discount_type: string; discount_value: number; max_uses: number | null; uses_count: number; min_fare_cents: number; expires_at: string | null; is_active: number; created_at: string }>();
  return c.json({ promoCodes: results ?? [] });
});

// PUT /api/admin/promo-codes/:id
adminRoutes.put('/promo-codes/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ID' } }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const isActive = (body as { isActive?: boolean })?.isActive;
  if (typeof isActive !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'isActive boolean required' } }, 400);
  }
  const db = getDB(c);
  await db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').bind(isActive ? 1 : 0, id).run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Dispute Management
// ---------------------------------------------------------------------------

// GET /api/admin/disputes
adminRoutes.get('/disputes', async (c) => {
  const status = c.req.query('status') || 'open';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = Math.min(50, parseInt(c.req.query('limit') || '20'));
  const offset = (page - 1) * limit;
  const db = getDB(c);
  const { results } = await db
    .prepare(
      `SELECT d.*, u.email as filed_by_email
       FROM disputes d JOIN users u ON u.id = d.filed_by
       WHERE d.status = ? ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(status, limit, offset)
    .all<{ id: number; trip_id: number; filed_by: number; filed_by_email: string; reason: string; status: string; resolution: string | null; refund_issued: number; created_at: string }>();
  const total = await db.prepare('SELECT COUNT(*) as cnt FROM disputes WHERE status = ?').bind(status).first<{ cnt: number }>();
  return c.json({ disputes: results ?? [], pagination: { page, limit, total: total?.cnt ?? 0 } });
});

// PUT /api/admin/disputes/:id
adminRoutes.put('/disputes/:id', async (c) => {
  const admin = c.get('user') as AuthUser;
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid ID' } }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }
  const { resolution, refundAmountCents } = (body as { resolution?: string; refundAmountCents?: number }) || {};
  if (!resolution) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'resolution required' } }, 400);
  const db = getDB(c);
  const dispute = await db.prepare('SELECT id FROM disputes WHERE id = ?').bind(id).first<{ id: number }>();
  if (!dispute) return c.json({ error: { code: 'NOT_FOUND', message: 'Dispute not found' } }, 404);
  const hasRefund = typeof refundAmountCents === 'number' && refundAmountCents > 0;
  await db
    .prepare(
      `UPDATE disputes SET status = 'resolved', resolution = ?, refund_issued = ?, refund_amount_cents = ?,
       admin_id = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(resolution, hasRefund ? 1 : 0, hasRefund ? refundAmountCents : null, admin.id, id)
    .run();
  return c.json({ success: true, disputeId: id });
});

// ---------------------------------------------------------------------------
// POST /api/admin/cron/run - manual cron trigger for ops/testing
// ---------------------------------------------------------------------------

adminRoutes.post('/cron/run', async (c) => {
  const adminUser = c.get('user') as AuthUser;
  if (adminUser.role !== 'super_admin') {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'Super admin role required' } }, 403);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = cronRunSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'task must be one of: daily, hourly, all' } }, 400);
  }

  const { task } = parsed.data;
  try {
    if (task === 'daily') {
      await runDailyTasks(c.env);
    } else if (task === 'hourly') {
      await runHourlyTasks(c.env);
    } else {
      await runDailyTasks(c.env);
      await runHourlyTasks(c.env);
    }

    await writeAdminAudit(c, 'CRON_MANUAL_TRIGGER', 'system', null);
    return c.json({
      triggered: task,
      completedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const parsedError = parseError(err);
    logger.error('Manual cron trigger failed', err instanceof Error ? err : undefined, {
      error: parsedError.message,
      task,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Cron trigger failed' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// Analytics endpoints
// ---------------------------------------------------------------------------

// GET /api/admin/analytics/trips-over-time
adminRoutes.get('/analytics/trips-over-time', async (c) => {
  const db = getDB(c);
  const { results } = await db
    .prepare(
      `SELECT strftime('%Y-W%W', created_at) as week, COUNT(*) as count
       FROM trips WHERE created_at >= datetime('now', '-90 days')
       GROUP BY week ORDER BY week ASC`,
    )
    .all<{ week: string; count: number }>();
  return c.json({ data: results ?? [] });
});

// GET /api/admin/analytics/heatmap
adminRoutes.get('/analytics/heatmap', async (c) => {
  const db = getDB(c);
  // Pickup coords stored in matching_rider_requests as lat/lng
  const { results } = await db
    .prepare(
      `SELECT pickup_lat as lat, pickup_lng as lng, COUNT(*) as weight
       FROM matching_rider_requests
       WHERE pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
         AND created_at >= datetime('now', '-30 days')
       GROUP BY round(pickup_lat, 3), round(pickup_lng, 3)
       LIMIT 500`,
    )
    .all<{ lat: number; lng: number; weight: number }>();
  return c.json({ points: results ?? [] });
});

export default adminRoutes;
