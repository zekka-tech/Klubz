/**
 * Klubz - Web Push Send Utility
 *
 * Sends a Web Push notification to all active subscriptions for a user.
 * Uses VAPID authentication (RFC 8292) via src/lib/vapid.ts.
 * Cloudflare Workers compatible — uses native fetch().
 */

import type { Bindings } from '../types';
import { buildVapidAuthHeader } from './vapid';
import { logger } from './logger';

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send a push notification to all subscriptions belonging to a user.
 * Silently removes expired/invalid subscriptions (410 Gone).
 */
export async function sendPushNotification(
  env: Bindings,
  db: { prepare(q: string): { bind(...args: unknown[]): { all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } } },
  userId: number,
  payload: PushPayload,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    logger.warn('VAPID keys not configured — skipping push notification', { userId });
    return;
  }

  const { results: subs } = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<PushSubscriptionRow>();

  if (!subs || subs.length === 0) return;

  const vapidSubject = `mailto:noreply@${new URL(env.APP_URL || 'https://klubz.com').hostname}`;
  const body = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        const authHeader = await buildVapidAuthHeader(
          sub.endpoint,
          vapidSubject,
          env.VAPID_PUBLIC_KEY,
          env.VAPID_PRIVATE_KEY,
        );

        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            TTL: '86400',
          },
          body,
        });

        // 410 Gone = subscription expired; remove it
        if (res.status === 410) {
          await db
            .prepare('DELETE FROM push_subscriptions WHERE id = ?')
            .bind(sub.id)
            .run();
        }
      } catch (err) {
        logger.warn('Push send failed', { userId, subscriptionId: sub.id, error: String(err) });
      }
    }),
  );
}
