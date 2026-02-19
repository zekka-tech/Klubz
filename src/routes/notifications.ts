import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDB } from '../lib/db';
import { ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { parseQueryInteger } from '../lib/validation';

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.use('*', authMiddleware());

type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'read';
const allowedStatuses = new Set<NotificationStatus>(['pending', 'sent', 'delivered', 'failed', 'read']);

interface NotificationRow {
  id: number;
  user_id: number;
  trip_id: number | null;
  notification_type: string;
  channel: string;
  status: NotificationStatus;
  subject: string | null;
  message: string;
  metadata: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
}

interface CountRow {
  total: number;
}

function parseNotificationMetadata(value: string | null, notificationId: number): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    logger.warn('Ignoring malformed notification metadata payload', { notificationId });
    return null;
  }
}

notificationRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const limit = parseQueryInteger(c.req.query('limit'), 20, { min: 1, max: 100 });
  if (limit === null) {
    throw new ValidationError('Invalid limit query parameter');
  }

  const offset = parseQueryInteger(c.req.query('offset'), 0, { min: 0, max: 100000 });
  if (offset === null) {
    throw new ValidationError('Invalid offset query parameter');
  }

  const status = c.req.query('status') as NotificationStatus | undefined;

  if (status && !allowedStatuses.has(status)) {
    throw new ValidationError('Invalid status filter');
  }

  const db = getDB(c);

  const where = status ? 'WHERE user_id = ? AND status = ?' : 'WHERE user_id = ?';
  const params: unknown[] = status ? [user.id, status] : [user.id];

  const countQuery = `SELECT COUNT(*) as total FROM notifications ${where}`;
  const countRow = await db.prepare(countQuery).bind(...params).first<CountRow>();
  const total = countRow?.total ?? 0;

  const rowsQuery = `
    SELECT id, user_id, trip_id, notification_type, channel, status, subject, message, metadata,
           sent_at, delivered_at, read_at, created_at
    FROM notifications
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const { results } = await db.prepare(rowsQuery).bind(...params, limit, offset).all<NotificationRow>();

  return c.json({
    data: (results ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      tripId: row.trip_id,
      type: row.notification_type,
      channel: row.channel,
      status: row.status,
      subject: row.subject,
      message: row.message,
      metadata: parseNotificationMetadata(row.metadata, row.id),
      sentAt: row.sent_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + limit < total,
    },
  });
});

notificationRoutes.patch('/:notificationId/read', async (c) => {
  const user = c.get('user') as AuthUser;
  const notificationId = Number.parseInt(c.req.param('notificationId'), 10);

  if (!Number.isFinite(notificationId) || notificationId <= 0) {
    throw new ValidationError('Invalid notification id');
  }

  const db = getDB(c);
  const existing = await db
    .prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?')
    .bind(notificationId, user.id)
    .first<{ id: number }>();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Notification not found' } }, 404);
  }

  await db
    .prepare(`
      UPDATE notifications
      SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `)
    .bind(notificationId, user.id)
    .run();

  return c.json({ message: 'Notification marked as read', notificationId });
});

notificationRoutes.post('/read-all', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDB(c);

  const count = await db
    .prepare("SELECT COUNT(*) as total FROM notifications WHERE user_id = ? AND status != 'read'")
    .bind(user.id)
    .first<CountRow>();

  await db
    .prepare(`
      UPDATE notifications
      SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status != 'read'
    `)
    .bind(user.id)
    .run();

  return c.json({ message: 'Notifications marked as read', updated: count?.total ?? 0 });
});

export default notificationRoutes;
