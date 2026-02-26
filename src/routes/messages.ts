import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { encryptPII, safeDecryptPII } from '../lib/encryption';
import { eventBus } from '../lib/eventBus';
import { logger } from '../lib/logger';

export const messageRoutes = new Hono<AppEnv>();

messageRoutes.use('*', authMiddleware());

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
}).strict();

interface TripAccessRow {
  driver_id: number;
}

interface ParticipantAccessRow {
  id: number;
}

interface RecipientRow {
  user_id: number;
}

interface MessageRow {
  id: number;
  trip_id: number;
  sender_id: number;
  content_encrypted: string;
  sent_at: string;
  read_at: string | null;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface InsertResult {
  meta?: {
    last_row_id?: number;
  };
}

async function hasTripAccess(c: Context<AppEnv>, tripId: number, userId: number): Promise<{ driverId: number } | null> {
  const db = getDBOptional(c);
  if (!db) return null;

  const trip = await db
    .prepare('SELECT driver_id FROM trips WHERE id = ?')
    .bind(tripId)
    .first<TripAccessRow>();

  if (!trip) return null;
  if (trip.driver_id === userId) {
    return { driverId: trip.driver_id };
  }

  const participant = await db
    .prepare("SELECT id FROM trip_participants WHERE trip_id = ? AND user_id = ? AND status IN ('accepted', 'completed')")
    .bind(tripId, userId)
    .first<ParticipantAccessRow>();

  if (!participant) return null;
  return { driverId: trip.driver_id };
}

async function emitMessageEvent(c: Context<AppEnv>, tripId: number, payload: Record<string, unknown>, driverId: number): Promise<void> {
  const db = getDBOptional(c);
  if (!db) return;

  const recipients = new Set<number>([driverId]);
  const riders = await db
    .prepare("SELECT user_id FROM trip_participants WHERE trip_id = ? AND role = 'rider' AND status IN ('accepted', 'completed')")
    .bind(tripId)
    .all<RecipientRow>();

  for (const row of riders.results ?? []) {
    recipients.add(row.user_id);
  }

  for (const recipientId of recipients) {
    eventBus.emit('new_message', payload, recipientId);
  }
}

messageRoutes.post('/trips/:tripId/messages', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = Number.parseInt(c.req.param('tripId'), 10);
  if (!Number.isFinite(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }

  const parsedBody = sendMessageSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedBody.error.issues.map((i) => i.message).join(', ') } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Messaging service unavailable' } }, 500);
  }

  const access = await hasTripAccess(c, tripId, user.id);
  if (!access) {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'You do not have access to this trip chat' } }, 403);
  }

  if (!c.env?.ENCRYPTION_KEY) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Messaging encryption is not configured' } }, 503);
  }

  try {
    const encrypted = await encryptPII(parsedBody.data.content, c.env.ENCRYPTION_KEY, user.id);
    const inserted = await db
      .prepare('INSERT INTO messages (trip_id, sender_id, content_encrypted) VALUES (?, ?, ?)')
      .bind(tripId, user.id, encrypted)
      .run() as InsertResult;

    const messageId = Number(inserted.meta?.last_row_id || 0);
    const sentAt = new Date().toISOString();

    await emitMessageEvent(c, tripId, {
      tripId,
      messageId,
      senderId: user.id,
      sentAt,
    }, access.driverId);

    return c.json({
      success: true,
      message: {
        id: messageId,
        tripId,
        senderId: user.id,
        content: parsedBody.data.content,
        sentAt,
      },
    }, 201);
  } catch (err) {
    logger.error('Failed to send trip message', err instanceof Error ? err : undefined, {
      tripId,
      userId: user.id,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send message' } }, 500);
  }
});

messageRoutes.get('/trips/:tripId/messages', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = Number.parseInt(c.req.param('tripId'), 10);
  if (!Number.isFinite(tripId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid trip ID' } }, 400);
  }

  const pageRaw = c.req.query('page') ?? '1';
  const limitRaw = c.req.query('limit') ?? '50';
  const page = Number.parseInt(pageRaw, 10);
  const limit = Number.parseInt(limitRaw, 10);

  if (!Number.isFinite(page) || page < 1 || !Number.isFinite(limit) || limit < 1 || limit > 100) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid pagination query' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Messaging service unavailable' } }, 500);
  }

  const access = await hasTripAccess(c, tripId, user.id);
  if (!access) {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'You do not have access to this trip chat' } }, 403);
  }

  try {
    const offset = (page - 1) * limit;
    const rows = await db
      .prepare(`
        SELECT m.id, m.trip_id, m.sender_id, m.content_encrypted, m.sent_at, m.read_at,
               u.first_name_encrypted, u.last_name_encrypted
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.trip_id = ?
        ORDER BY m.id DESC
        LIMIT ? OFFSET ?
      `)
      .bind(tripId, limit, offset)
      .all<MessageRow>();

    const encKey = c.env?.ENCRYPTION_KEY;
    const messages = await Promise.all((rows.results ?? []).map(async (row) => {
      const content = await safeDecryptPII(row.content_encrypted, encKey, row.sender_id) || '[Encrypted message unavailable]';
      const firstName = await safeDecryptPII(row.first_name_encrypted, encKey, row.sender_id);
      const lastName = await safeDecryptPII(row.last_name_encrypted, encKey, row.sender_id);
      const senderName = [firstName, lastName].filter(Boolean).join(' ').trim() || `User ${row.sender_id}`;

      return {
        id: row.id,
        tripId: row.trip_id,
        senderId: row.sender_id,
        senderName,
        content,
        sentAt: row.sent_at,
        readAt: row.read_at,
      };
    }));

    return c.json({
      messages: messages.reverse(),
      page,
      limit,
      hasMore: (rows.results?.length ?? 0) === limit,
    });
  } catch (err) {
    logger.error('Failed to list trip messages', err instanceof Error ? err : undefined, {
      tripId,
      userId: user.id,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load messages' } }, 500);
  }
});

messageRoutes.put('/trips/:tripId/messages/:msgId/read', async (c) => {
  const user = c.get('user') as AuthUser;
  const tripId = Number.parseInt(c.req.param('tripId'), 10);
  const msgId = Number.parseInt(c.req.param('msgId'), 10);

  if (!Number.isFinite(tripId) || !Number.isFinite(msgId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid IDs' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Messaging service unavailable' } }, 500);
  }

  const access = await hasTripAccess(c, tripId, user.id);
  if (!access) {
    return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'You do not have access to this trip chat' } }, 403);
  }

  try {
    const result = await db
      .prepare(`
        UPDATE messages
        SET read_at = COALESCE(read_at, STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'now'))
        WHERE id = ?
          AND trip_id = ?
          AND sender_id != ?
      `)
      .bind(msgId, tripId, user.id)
      .run() as { meta?: { changes?: number } };

    return c.json({ success: true, updated: Number(result.meta?.changes || 0) > 0 });
  } catch (err) {
    logger.error('Failed to mark message read', err instanceof Error ? err : undefined, {
      tripId,
      msgId,
      userId: user.id,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update message status' } }, 500);
  }
});

export default messageRoutes;
