/**
 * Integration contract tests for /api/subscriptions/* routes.
 *
 * Tests cover:
 *   - Auth boundaries (401 without token)
 *   - Input validation (400 for bad bodies, past months)
 *   - DB unavailability (500 CONFIGURATION_ERROR)
 *   - Happy path creation and responses
 *   - Ownership checks (404 for other user's resource)
 *   - Payment state machine (409 when already paid)
 *   - Day slot cancellation guards (409 when not in scheduled state)
 *   - Subscription cancellation guards (409 when expired)
 *
 * Uses the same MockDB / MockKV pattern as trips-routes-contracts.test.ts.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
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

const baseEnv = {
  JWT_SECRET: 'integration-secret-0123456789abcdef',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: '',
  TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '',
  SENDGRID_API_KEY: '',
  MAPBOX_ACCESS_TOKEN: '',
  ENVIRONMENT: 'development',
  APP_URL: 'http://localhost:3000',
  API_VERSION: 'v1',
  SESSIONS: new MockKV(),
  RATE_LIMIT_KV: new MockKV(),
} as const;

async function authToken(userId: number, role: 'user' | 'admin' | 'super_admin' = 'user') {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: userId,
    email: `user${userId}@example.com`,
    name: `User ${userId}`,
    role,
    iat: now,
    exp: now + 3600,
    type: 'access',
  };
  return createToken(payload, baseEnv.JWT_SECRET);
}

/** Build a valid subscription body for the current or next month */
function validSubscriptionBody(monthOffset = 0) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1 + monthOffset;
  const normalized = new Date(Date.UTC(y, m - 1, 1));
  const month = `${normalized.getUTCFullYear()}-${String(normalized.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    month,
    recurringWeekdays: [1, 2, 3, 4, 5],
    defaultMorningDeparture: '07:30',
    defaultPickup: { lat: -26.2041, lng: 28.0473, address: 'Johannesburg CBD' },
    defaultDropoff: { lat: -25.7479, lng: 28.2293, address: 'Pretoria CBD' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Subscriptions routes contract tests', () => {

  // ── Auth boundaries ───────────────────────────────────────────────────────

  test('POST /subscriptions returns 401 without token', async () => {
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSubscriptionBody()),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('GET /subscriptions/current returns 401 without token', async () => {
    const res = await app.request(
      '/api/subscriptions/current',
      { method: 'GET' },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  test('POST /subscriptions returns 400 for past month', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validSubscriptionBody(), month: '2020-01' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  test('POST /subscriptions returns 400 for missing recurringWeekdays', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const { recurringWeekdays: _dropped, ...bodyWithout } = validSubscriptionBody();
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyWithout),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  // ── DB unavailability ─────────────────────────────────────────────────────

  test('POST /subscriptions returns 500 CONFIGURATION_ERROR when DB is unavailable', async () => {
    const token = await authToken(1);
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validSubscriptionBody()),
      },
      { ...baseEnv, CACHE: new MockKV() }, // no DB
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test('POST /subscriptions returns 200 with subscriptionId and estimatedAmount', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id FROM monthly_subscriptions') && kind === 'first') return null; // no existing
      if (query.includes('INSERT INTO monthly_subscriptions') && kind === 'run') return { last_row_id: 42 };
      if (query.includes('INSERT INTO monthly_scheduled_days') && kind === 'run') return { changes: 1 };
      return null;
    });
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validSubscriptionBody()),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      subscriptionId?: number;
      estimatedAmount?: number;
      month?: string;
    };
    expect(body.subscriptionId).toBe(42);
    expect(typeof body.estimatedAmount).toBe('number');
    expect(body.estimatedAmount).toBeGreaterThan(0);
    expect(body.month).toBeDefined();
  });

  // ── GET /current ──────────────────────────────────────────────────────────

  test('GET /subscriptions/current returns { subscription: null } when no subscription exists', async () => {
    const token = await authToken(1);
    const db = new MockDB((_query, _params, kind) => {
      if (kind === 'first') return null;
      return null;
    });
    const res = await app.request(
      '/api/subscriptions/current',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { subscription: unknown };
    expect(body.subscription).toBeNull();
  });

  // ── Ownership check ───────────────────────────────────────────────────────

  test('GET /subscriptions/:id returns 404 when subscription owned by other user', async () => {
    const token = await authToken(99); // user 99
    const db = new MockDB((query, _params, kind) => {
      // subscription belongs to user 1, not user 99
      if (query.includes('FROM monthly_subscriptions WHERE id = ? AND user_id = ?') && kind === 'first') {
        return null; // WHERE user_id=99 fails
      }
      return null;
    });
    const res = await app.request(
      '/api/subscriptions/1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
  });

  // ── Payment state machine ─────────────────────────────────────────────────

  test('POST /subscriptions/:id/payment returns 409 when payment_status is paid', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_subscriptions WHERE id = ? AND user_id = ?') && kind === 'first') {
        return {
          id: 1,
          user_id: 1,
          subscription_month: '2026-03',
          payment_status: 'paid',
          status: 'active',
          estimated_amount_cents: 120000,
        };
      }
      return null;
    });
    const res = await app.request(
      '/api/subscriptions/1/payment',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFLICT');
  });

  test('POST /subscriptions/:id/payment succeeds when payment_status is unpaid', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_subscriptions WHERE id = ? AND user_id = ?') && kind === 'first') {
        return {
          id: 1,
          user_id: 1,
          subscription_month: '2026-03',
          payment_status: 'unpaid',
          status: 'pending_payment',
          estimated_amount_cents: 50000,
        };
      }
      if (query.includes('UPDATE monthly_subscriptions') && kind === 'run') return { changes: 1 };
      return null;
    });

    // Mock the global fetch used by StripeService
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'pi_test_123',
        amount: 50000,
        currency: 'zar',
        status: 'requires_payment_method',
        client_secret: 'pi_test_123_secret_abc',
        metadata: {},
      }),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const res = await app.request(
        '/api/subscriptions/1/payment',
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
        { ...baseEnv, DB: db, CACHE: new MockKV() },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { clientSecret?: string; paymentIntentId?: string };
      expect(body.clientSecret).toBe('pi_test_123_secret_abc');
      expect(body.paymentIntentId).toBe('pi_test_123');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // ── Day slot cancellation guard ───────────────────────────────────────────

  test('DELETE /subscriptions/:id/days/:date/:type returns 409 when status is matched', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_subscriptions WHERE id = ? AND user_id = ?') && kind === 'first') {
        return { id: 1 };
      }
      if (query.includes('FROM monthly_scheduled_days') && kind === 'first') {
        return { id: 10, status: 'matched' };
      }
      return null;
    });
    const res = await app.request(
      '/api/subscriptions/1/days/2026-03-03/morning',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFLICT');
  });

  // ── Subscription cancellation guard ──────────────────────────────────────

  test('DELETE /subscriptions/:id returns 409 when status is expired', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM monthly_subscriptions WHERE id = ? AND user_id = ?') && kind === 'first') {
        return { id: 1, status: 'expired' };
      }
      return null;
    });
    const res = await app.request(
      '/api/subscriptions/1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFLICT');
  });

});
