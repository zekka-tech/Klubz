import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { eventBus } from '../lib/eventBus';
import { logger } from '../lib/logger';

export const disputeRoutes = new Hono<AppEnv>();

disputeRoutes.use('*', authMiddleware());

const createDisputeSchema = z.object({
  tripId: z.number().int().positive(),
  reason: z.string().trim().min(10).max(2000),
  evidenceText: z.string().trim().max(5000).optional(),
}).strict();

disputeRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = createDisputeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid dispute payload' } }, 400);
  }

  const { tripId, reason, evidenceText } = parsed.data;
  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  const participant = await db
    .prepare('SELECT id FROM trip_participants WHERE trip_id = ? AND user_id = ?')
    .bind(tripId, user.id)
    .first<{ id: number }>();

  if (!participant) {
    const tripOwner = await db
      .prepare('SELECT id FROM trips WHERE id = ? AND driver_id = ?')
      .bind(tripId, user.id)
      .first<{ id: number }>();

    if (!tripOwner) {
      return c.json({ error: { code: 'AUTHORIZATION_ERROR', message: 'You were not part of this trip' } }, 403);
    }
  }

  const trip = await db
    .prepare('SELECT id, status FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ id: number; status: string }>();

  if (!trip) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Trip not found' } }, 404);
  }

  if (trip.status !== 'completed') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Disputes can only be filed for completed trips' } }, 400);
  }

  const existing = await db
    .prepare("SELECT id FROM disputes WHERE trip_id = ? AND filed_by = ? AND status IN ('open', 'investigating')")
    .bind(tripId, user.id)
    .first<{ id: number }>();

  if (existing) {
    return c.json({ error: { code: 'CONFLICT', message: 'An open dispute for this trip already exists' } }, 409);
  }

  try {
    const result = await db
      .prepare('INSERT INTO disputes (trip_id, filed_by, reason, evidence_text) VALUES (?, ?, ?, ?)')
      .bind(tripId, user.id, reason, evidenceText || null)
      .run();

    const disputeId = Number(result.meta?.last_row_id ?? 0);

    eventBus.emit('system:alert', {
      type: 'dispute_filed',
      disputeId,
      tripId,
      filedBy: user.id,
    });

    // Best-effort audit log — do not fail the response if this write fails
    await db
      .prepare(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, created_at)
         VALUES (?, 'DISPUTE_FILED', 'trip', ?, CURRENT_TIMESTAMP)`,
      )
      .bind(user.id, tripId)
      .run()
      .catch((auditErr: unknown) => {
        logger.warn('Dispute audit log write failed', { disputeId, error: String(auditErr) });
      });

    return c.json({ disputeId }, 201);
  } catch (err) {
    logger.error('Dispute create failed', err instanceof Error ? err : undefined, { tripId, userId: user.id });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to file dispute' } }, 500);
  }
});

export default disputeRoutes;
