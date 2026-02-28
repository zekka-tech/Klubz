/**
 * Klubz - Safety Routes (Emergency Contacts & SOS)
 *
 * GET    /api/safety/contacts      — List emergency contacts
 * POST   /api/safety/contacts      — Add an emergency contact
 * DELETE /api/safety/contacts/:id  — Remove a contact
 * POST   /api/safety/sos           — Trigger SOS alert
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { encryptPII, safeDecryptPII } from '../lib/encryption';
import { eventBus } from '../lib/eventBus';
import { logger } from '../lib/logger';

export const safetyRoutes = new Hono<AppEnv>();

safetyRoutes.use('*', authMiddleware());

const addContactSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().min(5).max(30),
  relationship: z.string().max(50).optional(),
  isPrimary: z.boolean().optional(),
}).strict();

// ── GET /api/safety/contacts ────────────────────────────────────────────────

safetyRoutes.get('/contacts', async (c) => {
  const user = c.get('user');
  const db = getDBOptional(c);
  if (!db) return c.json({ contacts: [] });

  const { results } = await db
    .prepare(
      `SELECT id, name_encrypted, phone_encrypted, relationship, is_primary, created_at
       FROM emergency_contacts WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC`,
    )
    .bind(user.id)
    .all<{
      id: number;
      name_encrypted: string;
      phone_encrypted: string;
      relationship: string | null;
      is_primary: number;
      created_at: string;
    }>();

  const encKey = c.env?.ENCRYPTION_KEY;
  const contacts = await Promise.all(
    (results ?? []).map(async (row) => ({
      id: row.id,
      name: (await safeDecryptPII(row.name_encrypted, encKey, user.id)) ?? '(encrypted)',
      phone: (await safeDecryptPII(row.phone_encrypted, encKey, user.id)) ?? '(encrypted)',
      relationship: row.relationship,
      isPrimary: !!row.is_primary,
      createdAt: row.created_at,
    })),
  );

  return c.json({ contacts });
});

// ── POST /api/safety/contacts ───────────────────────────────────────────────

safetyRoutes.post('/contacts', async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = addContactSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid contact data' } }, 400);
  }

  const { name, phone, relationship, isPrimary = true } = parsed.data;
  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  const encKey = c.env?.ENCRYPTION_KEY;
  if (!encKey) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Encryption not configured' } }, 503);
  }

  const encName = await encryptPII(name, encKey, user.id);
  const encPhone = await encryptPII(phone, encKey, user.id);

  const result = await db
    .prepare(
      `INSERT INTO emergency_contacts (user_id, name_encrypted, phone_encrypted, relationship, is_primary)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(user.id, encName, encPhone, relationship || null, isPrimary ? 1 : 0)
    .run();

  return c.json({ contactId: result.meta?.last_row_id }, 201);
});

// ── DELETE /api/safety/contacts/:id ────────────────────────────────────────

safetyRoutes.delete('/contacts/:id', async (c) => {
  const user = c.get('user');
  const contactId = parseInt(c.req.param('id'));
  if (isNaN(contactId)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid contact ID' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) return c.json({ success: true });

  const contact = await db
    .prepare('SELECT id FROM emergency_contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, user.id)
    .first<{ id: number }>();

  if (!contact) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Contact not found' } }, 404);
  }

  await db
    .prepare('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, user.id)
    .run();

  return c.json({ success: true });
});

// ── POST /api/safety/sos ────────────────────────────────────────────────────

safetyRoutes.post('/sos', async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }

  const { tripId, lat, lng } = (body as { tripId?: number; lat?: number; lng?: number }) || {};

  const db = getDBOptional(c);
  if (db) {
    try {
      await db
        .prepare(
          `INSERT INTO sos_events (user_id, trip_id, lat, lng) VALUES (?, ?, ?, ?)`,
        )
        .bind(user.id, tripId || null, lat ?? null, lng ?? null)
        .run();
    } catch (err) {
      logger.warn('SOS DB insert failed', { userId: user.id, error: String(err) });
    }
  }

  // Emit system alert for admin SSE listeners
  eventBus.emit('system:alert', {
    type: 'sos',
    userId: user.id,
    tripId: tripId ?? null,
    coords: lat != null && lng != null ? { lat, lng } : null,
  });

  // Contact notification via SMS is best-effort — fire and forget
  if (db) {
    void (async () => {
      try {
        const { results: contacts } = await db
          .prepare(
            `SELECT phone_encrypted FROM emergency_contacts WHERE user_id = ? AND is_primary = 1`,
          )
          .bind(user.id)
          .all<{ phone_encrypted: string }>();

        // In production: call NotificationService.sendSMS for each contact.
        // Kept as a log here to avoid circular dependencies.
        logger.info('SOS: emergency contacts to notify', {
          userId: user.id,
          contactCount: contacts?.length ?? 0,
        });
      } catch { /* best-effort */ }
    })();
  }

  return c.json({ success: true, message: 'SOS alert sent' });
});

export default safetyRoutes;
