/**
 * Integration contract tests for /api/payments/* routes.
 *
 * Tests cover:
 *   - Auth boundaries (401 without token for /intent)
 *   - Input validation (400 for bad bodies)
 *   - Idempotency (webhook replay via KV and DB)
 *   - DB unavailability (fails closed at 500)
 *   - Stripe webhook event processing (payment_intent.succeeded, .failed, .canceled)
 */

import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

type ResolverKind = 'first' | 'all' | 'run';
type Resolver = (query: string, params: unknown[], kind: ResolverKind) => unknown;

class MockStmt {
  private params: unknown[] = [];
  constructor(private query: string, private resolver: Resolver) {}
  bind(...values: unknown[]) { this.params = values; return this; }
  async first<T>(): Promise<T | null> { return (this.resolver(this.query, this.params, 'first') ?? null) as T | null; }
  async all<T>(): Promise<{ success: boolean; results?: T[] }> { return { success: true, results: (this.resolver(this.query, this.params, 'all') as T[]) ?? [] }; }
  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> { return { success: true, meta: (this.resolver(this.query, this.params, 'run') as Record<string, unknown>) ?? { last_row_id: 1 } }; }
}

class MockDB {
  constructor(private resolver: Resolver) {}
  prepare(query: string) { return new MockStmt(query, this.resolver); }
  async batch() { return []; }
}

class MockKV {
  private store = new Map<string, string>();
  async get(key: string, type?: string) {
    const val = this.store.get(key) ?? null;
    if (type === 'json' && val !== null) { try { return JSON.parse(val); } catch { return null; } }
    return val;
  }
  async put(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
  async list() { return { keys: [], list_complete: true, cursor: '' }; }
}

class FailingKV extends MockKV {
  async get() { throw new Error('KV unavailable'); }
  async put() { throw new Error('KV unavailable'); }
}

const baseEnv = {
  JWT_SECRET: 'integration-secret-0123456789abcdef',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: '',
  TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '',
  SENDGRID_API_KEY: '', MAPBOX_ACCESS_TOKEN: '',
  ENVIRONMENT: 'development',
  APP_URL: 'http://localhost:3000',
  API_VERSION: 'v1',
  SESSIONS: new MockKV(),
  RATE_LIMIT_KV: new MockKV(),
} as const;

async function authToken(userId: number, role: 'user' | 'admin' | 'super_admin' = 'user') {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { sub: userId, email: `user${userId}@example.com`, name: `User ${userId}`, role, iat: now, exp: now + 3600, type: 'access' };
  return createToken(payload, baseEnv.JWT_SECRET);
}

function stripeEvent(type: string, paymentIntentId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_${paymentIntentId}`,
    type,
    data: {
      object: {
        id: paymentIntentId,
        amount: 5000,
        currency: 'zar',
        metadata: { bookingId: '42', userId: '1', tripId: '10', amount: '50' },
        ...extra,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Payments routes contract tests', () => {

  // ── Auth boundaries ───────────────────────────────────────────────────────

  test('POST /payments/intent returns 401 without token', async () => {
    const res = await app.request(
      '/api/payments/intent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: 1 }) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  // ── Webhook: DB unavailability ────────────────────────────────────────────

  test('POST /payments/webhook fails closed when DB is unavailable', async () => {
    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: stripeEvent('payment_intent.succeeded', 'pi_no_db_1'),
      },
      { ...baseEnv, CACHE: new MockKV() }, // no DB
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
  });

  // ── Webhook: bad payload ──────────────────────────────────────────────────

  test('POST /payments/webhook returns 400 for malformed JSON', async () => {
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  test('POST /payments/webhook returns 400 for missing event type', async () => {
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'evt_123', data: { object: {} } }), // missing `type`
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  // ── Webhook: payment_intent.succeeded ─────────────────────────────────────

  test('POST /payments/webhook processes payment_intent.succeeded and returns 200', async () => {
    let auditWrites = 0;
    let paymentUpdated = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM processed_webhook_events') && kind === 'first') return null; // not replayed
      if (query.includes('INSERT OR IGNORE INTO processed_webhook_events') && kind === 'run') return { changes: 1 };
      if (query.includes('FROM trip_participants') && kind === 'first') {
        return { id: 42, user_id: 1, trip_id: 10, payment_status: 'pending', payment_intent_id: 'pi_pay_1' };
      }
      if (query.includes("SET payment_status = 'paid'") && kind === 'run') {
        paymentUpdated = true;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO audit_logs') && kind === 'run') {
        auditWrites++;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') return { last_row_id: 1 };
      if (query.includes('FROM user_preferences') && kind === 'first') return null;
      if (query.includes('FROM trips') && kind === 'first') {
        return { id: 10, title: 'Joburg → Sandton', origin: 'Joburg', destination: 'Sandton', departure_time: Date.now() + 3600000 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: stripeEvent('payment_intent.succeeded', 'pi_pay_1'),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    expect(paymentUpdated).toBe(true);
  });

  // ── Webhook: payment_intent.payment_failed ────────────────────────────────

  test('POST /payments/webhook processes payment_intent.payment_failed and returns 200', async () => {
    let paymentFailed = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM processed_webhook_events') && kind === 'first') return null;
      if (query.includes('INSERT OR IGNORE INTO processed_webhook_events') && kind === 'run') return { changes: 1 };
      if (query.includes('FROM trip_participants') && kind === 'first') {
        return { id: 43, user_id: 2, trip_id: 10, payment_status: 'pending', payment_intent_id: 'pi_fail_1' };
      }
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        paymentFailed = true;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') return { last_row_id: 1 };
      if (query.includes('FROM user_preferences') && kind === 'first') return null;
      if (query.includes('INSERT INTO audit_logs') && kind === 'run') return { changes: 1 };
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: stripeEvent('payment_intent.payment_failed', 'pi_fail_1', {
          last_payment_error: { message: 'card declined' },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    expect(paymentFailed).toBe(true);
  });

  // ── Webhook: payment_intent.canceled ─────────────────────────────────────

  test('POST /payments/webhook processes payment_intent.canceled and returns 200', async () => {
    let paymentCanceled = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM processed_webhook_events') && kind === 'first') return null;
      if (query.includes('INSERT OR IGNORE INTO processed_webhook_events') && kind === 'run') return { changes: 1 };
      if (query.includes('FROM trip_participants') && kind === 'first') {
        return { id: 44, user_id: 3, trip_id: 10, payment_status: 'pending', payment_intent_id: 'pi_cancel_1' };
      }
      if (query.includes("SET payment_status = 'canceled'") && kind === 'run') {
        paymentCanceled = true;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO audit_logs') && kind === 'run') return { changes: 1 };
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: stripeEvent('payment_intent.canceled', 'pi_cancel_1'),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    expect(paymentCanceled).toBe(true);
  });

  // ── Webhook: idempotency via KV ───────────────────────────────────────────

  test('POST /payments/webhook is idempotent with KV cache (replayed event returns 200)', async () => {
    let dbProcessed = 0;
    const sharedKV = new MockKV();
    await sharedKV.put('stripe:webhook:event:evt_idem_kv_1', JSON.stringify({ processedAt: new Date().toISOString() }));

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM processed_webhook_events') && kind === 'first') return null;
      if (query.includes('INSERT OR IGNORE INTO processed_webhook_events') && kind === 'run') {
        dbProcessed++;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: JSON.stringify({
          id: 'evt_idem_kv_1',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_idem_1', amount: 5000, metadata: { bookingId: '42', userId: '1', tripId: '10', amount: '50' } } },
        }),
      },
      { ...baseEnv, DB: db, CACHE: sharedKV },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { replay?: boolean };
    expect(body.replay).toBe(true);
    expect(dbProcessed).toBe(0); // KV hit, DB not queried
  });

  // ── Webhook: idempotency via DB fallback ──────────────────────────────────

  test('POST /payments/webhook is idempotent via DB when KV is unavailable', async () => {
    let dbReplayCheck = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM processed_webhook_events') && kind === 'first') {
        dbReplayCheck++;
        return { event_id: 'evt_idem_db_1' }; // already processed
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
        body: JSON.stringify({
          id: 'evt_idem_db_1',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_idem_2', amount: 5000, metadata: { bookingId: '42', userId: '1', tripId: '10', amount: '50' } } },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new FailingKV() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { replay?: boolean };
    expect(body.replay).toBe(true);
    expect(dbReplayCheck).toBeGreaterThan(0);
  });

  // ── POST /payments/intent: validation ─────────────────────────────────────

  test('POST /payments/intent returns 400 for missing bookingId', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // missing bookingId
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  test('POST /payments/intent returns 404 for non-existent booking', async () => {
    const token = await authToken(1);
    const db = new MockDB((_query, _params, _kind) => null); // no booking found
    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 9999, amount: 50 }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
  });

  test('POST /payments/intent returns 404 when booking does not belong to user', async () => {
    // Ownership is enforced by SQL WHERE user_id=? — another user's booking returns 404 (not 403)
    const token = await authToken(99); // user 99 has no accepted booking for trip 42
    const db = new MockDB((_query, _params, _kind) => null); // query with user_id=99 finds nothing
    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 42, amount: 50 }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});
