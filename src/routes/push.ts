/**
 * Klubz - Web Push Subscription Routes
 *
 * POST /api/push/subscribe   — Save a browser push subscription
 * DELETE /api/push/subscribe — Remove a push subscription by endpoint
 * GET /api/push/vapid-key    — Return the public VAPID key (for frontend subscription setup)
 * POST /api/push/send        — Admin: manual push (testing)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { sendPushNotification } from '../lib/push';
import { logger } from '../lib/logger';

export const pushRoutes = new Hono<AppEnv>();

// ── Public: VAPID public key ────────────────────────────────────────────────

pushRoutes.get('/vapid-key', (c) => {
  const key = c.env?.VAPID_PUBLIC_KEY;
  if (!key) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Push notifications not configured' } }, 503);
  }
  return c.json({ vapidPublicKey: key });
});

// ── Authenticated routes ────────────────────────────────────────────────────

pushRoutes.use('/subscribe', authMiddleware());
pushRoutes.use('/send', adminMiddleware());

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
}).strict();

// POST /api/push/subscribe
pushRoutes.post('/subscribe', async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid subscription data' } }, 400);
  }

  const { endpoint, keys, userAgent } = parsed.data;
  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  try {
    await db
      .prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent`,
      )
      .bind(user.id, endpoint, keys.p256dh, keys.auth, userAgent || null)
      .run();

    return c.json({ success: true });
  } catch (err) {
    logger.error('push/subscribe failed', err instanceof Error ? err : undefined, { userId: user.id });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save subscription' } }, 500);
  }
});

// DELETE /api/push/subscribe
pushRoutes.delete('/subscribe', authMiddleware(), async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const endpoint = (body as { endpoint?: string })?.endpoint;
  if (!endpoint) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'endpoint required' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) return c.json({ success: true }); // best-effort

  await db
    .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .bind(user.id, endpoint)
    .run();

  return c.json({ success: true });
});

// POST /api/push/send — admin manual push for testing
pushRoutes.post('/send', async (c) => {
  const user = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const { userId, title, bodyText } = body as { userId?: number; title?: string; bodyText?: string };
  if (!userId || !title) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'userId and title required' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);

  await sendPushNotification(c.env, db as Parameters<typeof sendPushNotification>[1], userId, {
    title,
    body: bodyText || '',
    url: '/',
  });

  logger.info('Admin manual push sent', { adminId: user.id, targetUserId: userId });
  return c.json({ success: true });
});

export default pushRoutes;
