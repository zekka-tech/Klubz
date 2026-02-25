import { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';

export const promoRoutes = new Hono<AppEnv>();

promoRoutes.use('*', authMiddleware());

promoRoutes.get('/promo-codes/validate', async (c) => {
  const user = c.get('user') as AuthUser;
  const code = c.req.query('code')?.trim();

  if (!code) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'code query parameter is required' } }, 400);
  }

  const db = getDBOptional(c);
  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  const promo = await db.prepare(`
    SELECT id, discount_type, discount_value, max_uses, uses_count, min_fare_cents, expires_at, is_active
    FROM promo_codes
    WHERE code = ? COLLATE NOCASE
    LIMIT 1
  `).bind(code).first<{
    id: number;
    discount_type: 'percent' | 'fixed_cents';
    discount_value: number;
    max_uses: number | null;
    uses_count: number;
    min_fare_cents: number;
    expires_at: string | null;
    is_active: number;
  }>();

  if (!promo || promo.is_active !== 1) {
    return c.json({ isValid: false, reason: 'invalid_or_inactive' });
  }

  if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
    return c.json({ isValid: false, reason: 'expired' });
  }

  if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
    return c.json({ isValid: false, reason: 'usage_limit_reached' });
  }

  const alreadyUsed = await db
    .prepare('SELECT id FROM promo_redemptions WHERE promo_code_id = ? AND user_id = ?')
    .bind(promo.id, user.id)
    .first<{ id: number }>();

  if (alreadyUsed) {
    return c.json({ isValid: false, reason: 'already_redeemed' });
  }

  return c.json({
    isValid: true,
    discountType: promo.discount_type,
    discountValue: promo.discount_value,
    minFareCents: promo.min_fare_cents ?? 0,
  });
});

export default promoRoutes;
