import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';

type ResolverKind = 'first' | 'all' | 'run';
type Resolver = (query: string, params: unknown[], kind: ResolverKind) => unknown;

class MockStmt {
  private params: unknown[] = [];

  constructor(
    private query: string,
    private resolver: Resolver,
  ) {}

  bind(...values: unknown[]) {
    this.params = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = this.resolver(this.query, this.params, 'first');
    return (result ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ success: boolean; results?: T[] }> {
    const result = this.resolver(this.query, this.params, 'all');
    return { success: true, results: (result as T[]) ?? [] };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const result = this.resolver(this.query, this.params, 'run');
    return { success: true, meta: (result as Record<string, unknown>) ?? { last_row_id: 1 } };
  }
}

class MockDB {
  constructor(private resolver: Resolver) {}

  prepare(query: string) {
    return new MockStmt(query, this.resolver);
  }

  async batch<T = unknown>(statements: Array<{ first?: () => Promise<T | null>; all?: () => Promise<{ results?: T[] }> }>) {
    const out: Array<{ success: boolean; results?: T[] }> = [];
    for (const stmt of statements) {
      if (stmt.all) {
        const all = await stmt.all();
        out.push({ success: true, results: all.results ?? [] });
      } else if (stmt.first) {
        const first = await stmt.first();
        out.push({ success: true, results: first ? [first] : [] });
      } else {
        out.push({ success: true, results: [] });
      }
    }
    return out;
  }
}

class MockKV {
  private store = new Map<string, string>();

  async get(key: string, type?: 'text' | 'json') {
    const raw = this.store.get(key) ?? null;
    if (!raw) return null;
    if (type === 'json') return JSON.parse(raw) as unknown;
    return raw;
  }

  async put(key: string, value: string) {
    this.store.set(key, value);
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list() {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    };
  }
}

const baseEnv = {
  JWT_SECRET: 'integration-secret',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_PHONE_NUMBER: '',
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

describe('Security hardening integration flows', () => {
  test('registration persists role=user server-side', async () => {
    let insertedRole: unknown = null;

    const db = new MockDB((query, params, kind) => {
      if (query.includes('SELECT id FROM users') && kind === 'first') return null;
      if (query.includes('INSERT INTO users') && kind === 'run') {
        insertedRole = params[6];
        return { last_row_id: 42 };
      }
      return null;
    });

    const res = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new@example.com',
          password: 'StrongPass123!',
          name: 'New User',
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(insertedRole).toBe('user');
  });

  test('trip booking accept rejects non-owner driver', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 99 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('trip booking accept returns conflict when booking is not pending', async () => {
    const token = await authToken(10, 'user');
    let seatUpdateCalls = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'accepted'") && kind === 'run') {
        return { changes: 0 };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        seatUpdateCalls += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Booking is no longer pending');
    expect(seatUpdateCalls).toBe(0);
  });

  test('trip booking accept rolls back when seat decrement fails', async () => {
    const token = await authToken(10, 'user');
    let compensationCalls = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'accepted'") && kind === 'run') {
        return { changes: 1 };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        return { changes: 0 };
      }
      if (query.includes("SET status = 'requested', accepted_at = NULL") && kind === 'run') {
        compensationCalls += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('No seats available');
    expect(compensationCalls).toBe(1);
  });

  test('trip booking accept is idempotent with Idempotency-Key replay', async () => {
    const token = await authToken(10, 'user');
    const sharedCache = new MockKV();
    let acceptUpdates = 0;
    let seatUpdates = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'accepted'") && kind === 'run') {
        acceptUpdates += 1;
        return { changes: 1 };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        seatUpdates += 1;
        return { changes: 1 };
      }
      return null;
    });

    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'accept-dup-1' };
    const first = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replay?: boolean };
    expect(secondBody.replay).toBe(true);
    expect(acceptUpdates).toBe(1);
    expect(seatUpdates).toBe(1);
  });

  test('trip booking reject rejects non-owner driver', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 99 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/reject',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'No seats left' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('trip booking reject returns conflict when booking is not pending', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'rejected'") && kind === 'run') {
        return { changes: 0 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/reject',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'No seats left' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Booking is no longer pending');
  });

  test('trip cancel rejects non-owner driver', async () => {
    const token = await authToken(12, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 44 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/cancel',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Emergency' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('trip cancel returns conflict when trip is already cancelled', async () => {
    const token = await authToken(12, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 12 };
      }
      if (query.includes("SET status = 'cancelled'") && kind === 'run') {
        return { changes: 0 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/cancel',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Already handled' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Trip is already cancelled');
  });

  test('trip cancel is idempotent with Idempotency-Key replay', async () => {
    const token = await authToken(12, 'user');
    const sharedCache = new MockKV();
    let cancelUpdates = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 12 };
      }
      if (query.includes("SET status = 'cancelled'") && kind === 'run') {
        cancelUpdates += 1;
        return { changes: 1 };
      }
      return null;
    });

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'cancel-dup-1',
    };
    const first = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers, body: JSON.stringify({ reason: 'Ops issue' }) },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers, body: JSON.stringify({ reason: 'Ops issue' }) },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replay?: boolean };
    expect(secondBody.replay).toBe(true);
    expect(cancelUpdates).toBe(1);
  });

  test('trip rating rejects non-completed participation', async () => {
    const token = await authToken(20, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, user_id, status FROM trip_participants') && kind === 'first') {
        return { id: 1, user_id: 20, status: 'accepted' };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/rate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5, comment: 'Great trip' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  test('trip rating succeeds for completed participation', async () => {
    const token = await authToken(20, 'user');
    let ratingUpdated = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, user_id, status FROM trip_participants') && kind === 'first') {
        return { id: 1, user_id: 20, status: 'completed' };
      }
      if (query.includes('UPDATE trip_participants SET rating') && kind === 'run') {
        ratingUpdated = true;
        return { success: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/rate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 4, comment: 'Solid ride' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(ratingUpdated).toBe(true);
  });

  test('webhook returns configuration error in production without webhook secret', async () => {
    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({ id: 'evt_missing_secret', type: 'payment_intent.succeeded', data: { object: {} } }),
      },
      { ...baseEnv, ENVIRONMENT: 'production', DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Internal server error');
  });

  test('webhook replay is ignored on second identical event', async () => {
    const db = new MockDB(() => null);
    const cache = new MockKV();
    const event = {
      id: 'evt_replay_1',
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_1', amount: 1200, metadata: { bookingId: '77' } } },
    };

    const first = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: cache },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: cache },
    );

    expect(second.status).toBe(200);
    const body = (await second.json()) as { replay?: boolean };
    expect(body.replay).toBe(true);
  });

  test('webhook rejects requests without stripe signature header', async () => {
    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        body: JSON.stringify({ id: 'evt_no_sig', type: 'payment_intent.succeeded', data: { object: {} } }),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; status?: number } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.status).toBe(400);
  });

  test('webhook success event with missing metadata is ignored without DB mutation', async () => {
    let updateCalls = 0;
    const db = new MockDB((query) => {
      if (query.includes('UPDATE trip_participants')) updateCalls += 1;
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_missing_meta_success',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_missing_meta_1', amount: 1200, metadata: { bookingId: '77' } } },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean; ignored?: boolean; reason?: string };
    expect(body.received).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('missing_metadata');
    expect(updateCalls).toBe(0);
  });

  test('webhook payment_failed event with missing metadata is ignored without DB mutation', async () => {
    let updateCalls = 0;
    const db = new MockDB((query) => {
      if (query.includes('UPDATE trip_participants')) updateCalls += 1;
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_missing_meta_failed',
          type: 'payment_intent.payment_failed',
          data: { object: { id: 'pi_missing_meta_2', amount: 1200, metadata: {} } },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean; ignored?: boolean; reason?: string };
    expect(body.received).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('missing_metadata');
    expect(updateCalls).toBe(0);
  });

  test('webhook canceled event with missing metadata is ignored without DB mutation', async () => {
    let updateCalls = 0;
    const db = new MockDB((query) => {
      if (query.includes('UPDATE trip_participants')) updateCalls += 1;
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_missing_meta_canceled',
          type: 'payment_intent.canceled',
          data: { object: { id: 'pi_missing_meta_3', amount: 1200, metadata: {} } },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean; ignored?: boolean; reason?: string };
    expect(body.received).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe('missing_metadata');
    expect(updateCalls).toBe(0);
  });

  test('payment intent endpoint still requires auth', async () => {
    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 1, amount: 10 }),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string; status?: number } };
    expect(body.error?.code).toBe('AUTHENTICATION_ERROR');
    expect(body.error?.status).toBe(401);
  });

  test('payment intent rejects amount tampering when it does not match trip fare', async () => {
    const token = await authToken(44, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants tp') && kind === 'first') {
        return { id: 77, title: 'Morning commute', price_per_seat: 120 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 10, amount: 1 }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string; status?: number } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.status).toBe(400);
    expect(body.error?.message).toBe('amount does not match trip fare');
  });

  test('payment failed webhook does not downgrade already-finalized paid booking', async () => {
    let bookingLookupCount = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        return { changes: 0 };
      }
      if (query.includes('SELECT user_id, trip_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        bookingLookupCount += 1;
        return { user_id: 44, trip_id: 10 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_no_downgrade_1',
          type: 'payment_intent.payment_failed',
          data: {
            object: {
              id: 'pi_paid_guard_1',
              amount: 1200,
              metadata: { bookingId: '77' },
              last_payment_error: { message: 'Card declined' },
            },
          },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean };
    expect(body.received).toBe(true);
    expect(bookingLookupCount).toBe(0);
  });
});
