import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDBOptional } from '../lib/db';
import { logger } from '../lib/logger';

export const organizationRoutes = new Hono<AppEnv>();

organizationRoutes.use('*', authMiddleware());

const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
}).strict();

const joinOrgSchema = z.object({
  inviteCode: z.string().trim().min(4).max(32),
}).strict();

function createInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join('');
}

organizationRoutes.post('/', async (c) => {
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

  const parsed = createOrgSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid organization payload' } }, 400);
  }

  const orgId = crypto.randomUUID();
  let inviteCode = createInviteCode();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db
        .prepare('INSERT INTO organizations (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)')
        .bind(orgId, parsed.data.name, inviteCode, user.id)
        .run();
      break;
    } catch (err) {
      if (attempt === 4) {
        logger.error('Organization create failed', err instanceof Error ? err : undefined, { userId: user.id });
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create organization' } }, 500);
      }
      inviteCode = createInviteCode();
    }
  }

  try {
    await db
      .prepare('UPDATE users SET organization_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(orgId, user.id)
      .run();
  } catch (err) {
    logger.warn('Organization created but owner membership update failed', {
      userId: user.id,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return c.json({ orgId, inviteCode }, 201);
});

organizationRoutes.get('/current', async (c) => {
  const user = c.get('user') as AuthUser;
  const db = getDBOptional(c);

  if (!db) {
    return c.json({ error: { code: 'CONFIGURATION_ERROR', message: 'Service unavailable' } }, 503);
  }

  const userRow = await db
    .prepare('SELECT organization_id FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ organization_id: string | null }>();

  const org = await db
    .prepare(
      `SELECT id, name, invite_code, created_by
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(userRow?.organization_id || null)
    .first<{ id: string; name: string; invite_code: string | null; created_by: number | null }>();

  if (!org) {
    const fallback = await db
      .prepare(
        `SELECT id, name, invite_code, created_by
         FROM organizations
         WHERE created_by = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(user.id)
      .first<{ id: string; name: string; invite_code: string | null; created_by: number | null }>();

    if (!fallback) {
      return c.json({ organization: null });
    }

    const memberCountRow = await db
      .prepare('SELECT COUNT(*) as count FROM users WHERE organization_id = ?')
      .bind(fallback.id)
      .first<{ count: number }>();

    return c.json({
      organization: {
        id: fallback.id,
        name: fallback.name,
        inviteCode: fallback.invite_code,
        memberCount: Number(memberCountRow?.count ?? 0),
        isOwner: fallback.created_by === user.id,
      },
    });
  }

  const memberCountRow = await db
    .prepare('SELECT COUNT(*) as count FROM users WHERE organization_id = ?')
    .bind(org.id)
    .first<{ count: number }>();

  return c.json({
    organization: {
      id: org.id,
      name: org.name,
      inviteCode: org.invite_code,
      memberCount: Number(memberCountRow?.count ?? 0),
      isOwner: org.created_by === user.id,
    },
  });
});

organizationRoutes.post('/join', async (c) => {
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

  const parsed = joinOrgSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid join payload' } }, 400);
  }

  const inviteCode = parsed.data.inviteCode.toUpperCase();

  const org = await db
    .prepare('SELECT id, name FROM organizations WHERE invite_code = ? AND is_active = 1 LIMIT 1')
    .bind(inviteCode)
    .first<{ id: string; name: string }>();

  if (!org) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Organization invite code not found' } }, 404);
  }

  await db
    .prepare('UPDATE users SET organization_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(org.id, user.id)
    .run();

  return c.json({ orgName: org.name });
});

export default organizationRoutes;
