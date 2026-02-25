import type { D1Database } from '../types';

interface BalanceRow {
  balance: number | null;
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
