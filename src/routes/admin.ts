/**
 * Klubz - Admin Routes (Production D1)
 *
 * Real D1 queries for admin stats, user management, logs, exports.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';
import { getDB } from '../lib/db';
import { getIP, getUserAgent } from '../lib/http';

export const adminRoutes = new Hono<AppEnv>();

interface CountRow {
  count: number;
}

interface TotalRow {
  total: number;
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

interface PaginationQueryOptions {
  min: number;
  max: number;
}

function parseIntegerQueryParam(
  value: string | undefined,
  defaultValue: number,
  options: PaginationQueryOptions,
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
  const db = getDB(c);

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

    await writeAdminAudit(c, 'ADMIN_STATS_VIEWED', 'admin_dashboard');

    return c.json({
      totalUsers,
      activeUsers,
      totalTrips,
      completedTrips,
      activeDrivers,
      revenue: { total: revenue, currency: 'ZAR' },
      carbonSaved: { total: (completedTrips as number) * 2.1, unit: 'kg CO2' },
      sla: { uptime: 99.85, avgResponseTime: 145 },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const parsed = parseError(err);
    logger.error('Admin stats DB error', err instanceof Error ? err : undefined, { error: parsed.message });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load admin statistics' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /users - Paginated user list
// ---------------------------------------------------------------------------

adminRoutes.get('/users', async (c) => {
  const page = parseIntegerQueryParam(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }

  const limit = parseIntegerQueryParam(c.req.query('limit'), 20, { min: 1, max: 100 });
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
  await writeAdminAudit(c, 'ADMIN_ORGANIZATIONS_VIEWED', 'organization');
  // Organizations not in current schema - return placeholder
  return c.json({
    organizations: [],
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
  });
});

// ---------------------------------------------------------------------------
// GET /logs - Audit logs from D1
// ---------------------------------------------------------------------------

adminRoutes.get('/logs', async (c) => {
  const page = parseIntegerQueryParam(c.req.query('page'), 1, { min: 1, max: 100000 });
  if (page === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page query parameter' } }, 400);
  }

  const limit = parseIntegerQueryParam(c.req.query('limit'), 50, { min: 1, max: 200 });
  if (limit === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid limit query parameter' } }, 400);
  }

  const level = c.req.query('level') || 'all';
  if (!/^[a-z_]{1,32}$/i.test(level)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid level filter' } }, 400);
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

export default adminRoutes;
