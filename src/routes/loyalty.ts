import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { awardPoints } from '../lib/points';
import { logger } from '../lib/logger';

export const loyaltyRoutes = new Hono<AppEnv>();

loyaltyRoutes.use('*', authMiddleware());

function generateReferralCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

loyaltyRoutes.get('/users/referral', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDBOptional(c);

  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  let row = await db
    .prepare('SELECT code, uses_count FROM referral_codes WHERE user_id = ? LIMIT 1')
    .bind(user.id)
    .first<{ code: string; uses_count: number }>();

  if (!row) {
    let createdCode: string | null = null;
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const code = generateReferralCode();
      try {
        await db
          .prepare('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)')
          .bind(user.id, code)
          .run();
        createdCode = code;
        break;
      } catch {
        // Collision retry.
      }
    }

    if (!createdCode) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to allocate referral code' } }, 500);
    }

    row = { code: createdCode, uses_count: 0 };
  }

  return c.json({ code: row.code, usesCount: row.uses_count });
});

loyaltyRoutes.get('/users/points', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDBOptional(c);

  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  const balance = await db
    .prepare('SELECT COALESCE(SUM(delta), 0) as balance FROM points_ledger WHERE user_id = ?')
    .bind(user.id)
    .first<{ balance: number }>();

  const history = await db
    .prepare(
      `SELECT id, delta, reason, reference_id, balance_after, created_at
       FROM points_ledger
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 20`,
    )
    .bind(user.id)
    .all<{
      id: number;
      delta: number;
      reason: string;
      reference_id: number | null;
      balance_after: number;
      created_at: string;
    }>();

  return c.json({
    balance: Number(balance?.balance ?? 0),
    history: history.results ?? [],
  });
});

const redeemSchema = z.object({
  referralCode: z.string().trim().min(4).max(32),
}).strict();

loyaltyRoutes.post('/referrals/redeem', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDBOptional(c);

  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
  }

  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid referral payload' } }, 400);
  }

  const referralCode = parsed.data.referralCode.toUpperCase();

  const referrer = await db
    .prepare('SELECT user_id FROM referral_codes WHERE code = ? LIMIT 1')
    .bind(referralCode)
    .first<{ user_id: number }>();

  if (!referrer) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Referral code not found' } }, 404);
  }

  if (referrer.user_id === user.id) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'You cannot redeem your own referral code' } }, 400);
  }

  const alreadyRedeemed = await db
    .prepare("SELECT id FROM points_ledger WHERE user_id = ? AND reason = 'referral_redeem' LIMIT 1")
    .bind(user.id)
    .first<{ id: number }>();

  if (alreadyRedeemed) {
    return c.json({ error: { code: 'CONFLICT', message: 'Referral code already redeemed' } }, 409);
  }

  try {
    await awardPoints(db, user.id, 200, 'referral_redeem', referrer.user_id);
    await awardPoints(db, referrer.user_id, 200, 'referral_success', user.id);

    await db
      .prepare('UPDATE referral_codes SET uses_count = uses_count + 1 WHERE user_id = ?')
      .bind(referrer.user_id)
      .run();

    return c.json({ success: true, pointsAwarded: 200 });
  } catch (err) {
    logger.error('Referral redeem failed', err instanceof Error ? err : undefined, {
      userId: user.id,
      referrerUserId: referrer.user_id,
    });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to redeem referral code' } }, 500);
  }
});

export default loyaltyRoutes;
