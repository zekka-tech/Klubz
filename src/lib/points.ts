import type { D1Database } from '../types';

interface BalanceRow {
  balance: number | null;
}

/**
 * Award points exactly once per (userId, reason, referenceId) triple.
 * Idempotent — silently skips if the entry already exists.
 */
export async function awardPointsOnce(
  db: D1Database,
  userId: number,
  delta: number,
  reason: string,
  referenceId: number,
): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM points_ledger WHERE user_id = ? AND reason = ? AND reference_id = ? LIMIT 1')
    .bind(userId, reason, referenceId)
    .first<{ id: number }>();
  if (existing) return;
  await awardPoints(db, userId, delta, reason, referenceId);
}

export async function awardPoints(
  db: D1Database,
  userId: number,
  delta: number,
  reason: string,
  referenceId?: number,
): Promise<number> {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('delta must be a non-zero finite number');
  }

  const current = await db
    .prepare('SELECT COALESCE(SUM(delta), 0) as balance FROM points_ledger WHERE user_id = ?')
    .bind(userId)
    .first<BalanceRow>();

  const currentBalance = Number(current?.balance ?? 0);
  const nextBalance = currentBalance + delta;

  await db
    .prepare(
      `INSERT INTO points_ledger (user_id, delta, reason, reference_id, balance_after)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(userId, delta, reason, referenceId ?? null, nextBalance)
    .run();

  return nextBalance;
}
