import { describe, expect, test, vi } from 'vitest';
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
  JWT_SECRET: 'integration-secret-0123456789abcdef',
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

async function authToken(userId: number, role: 'user' | 'admin' | 'super_admin' = 'user', orgId?: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: userId,
    email: `user${userId}@example.com`,
    name: `User ${userId}`,
    role,
    orgId,
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

  test('login fails closed in production when auth DB is unavailable', async () => {
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'prod-user@example.com',
          password: 'StrongPass123!',
        }),
      },
      { ...baseEnv, ENVIRONMENT: 'production', CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Authentication service unavailable');
  });

  test('register fails closed in production when auth DB is unavailable', async () => {
    const res = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'prod-register@example.com',
          password: 'StrongPass123!',
          name: 'Prod User',
        }),
      },
      { ...baseEnv, ENVIRONMENT: 'production', CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Authentication service unavailable');
  });

  test('runtime configuration fails closed in production when JWT secret is invalid', async () => {
    const res = await app.request(
      '/health',
      { method: 'GET' },
      { ...baseEnv, ENVIRONMENT: 'production', JWT_SECRET: 'too-short' },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Internal server error');
  });

  test('runtime configuration fails closed in production when encryption key is invalid', async () => {
    const res = await app.request(
      '/health',
      { method: 'GET' },
      { ...baseEnv, ENVIRONMENT: 'production', ENCRYPTION_KEY: 'not-a-valid-key' },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Internal server error');
  });

  test('login fails closed in development when auth tables are missing', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM users') && kind === 'first') {
        throw new Error('D1_ERROR: no such table: users');
      }
      return null;
    });

    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dev-user@example.com',
          password: 'StrongPass123!',
        }),
      },
      { ...baseEnv, ENVIRONMENT: 'development', DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Authentication service unavailable');
  });

  test('register fails closed in development when auth tables are missing', async () => {
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id FROM users') && kind === 'first') {
        throw new Error('D1_ERROR: no such table: users');
      }
      return null;
    });

    const res = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dev-register@example.com',
          password: 'StrongPass123!',
          name: 'Dev User',
        }),
      },
      { ...baseEnv, ENVIRONMENT: 'development', DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Authentication service unavailable');
  });

  test('mfa verify returns explicit not implemented contract', async () => {
    const res = await app.request(
      '/api/auth/mfa/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '123456' }),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string; message?: string; status?: number } };
    expect(body.error?.code).toBe('NOT_IMPLEMENTED');
    expect(body.error?.status).toBe(501);
    expect(body.error?.message).toContain('MFA verification is not yet implemented');
  });

  test('trip booking rejects driver booking their own trip', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, available_seats, status, driver_id FROM trips') && kind === 'first') {
        return { id: 1, available_seats: 3, status: 'scheduled', driver_id: 10 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/book',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'Pickup A' },
          dropoffLocation: { address: 'Dropoff B' },
          passengers: 1,
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(body.error?.message).toBe('Drivers cannot book their own trips');
  });

  test('trip booking returns conflict when trip is not open for booking', async () => {
    const token = await authToken(20, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, available_seats, status, driver_id FROM trips') && kind === 'first') {
        return { id: 1, available_seats: 3, status: 'cancelled', driver_id: 10 };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/book',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'Pickup A' },
          dropoffLocation: { address: 'Dropoff B' },
          passengers: 1,
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Trip is not open for booking');
  });

  test('trip booking fails closed when trip DB is unavailable', async () => {
    const token = await authToken(20, 'user');

    const res = await app.request(
      '/api/trips/1/book',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'Pickup A' },
          dropoffLocation: { address: 'Dropoff B' },
          passengers: 1,
        }),
      },
      { ...baseEnv, DB: undefined as unknown as MockDB, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
    expect(body.error?.message).toBe('Trip service unavailable');
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

  test('trip booking accept is idempotent without CACHE using durable DB idempotency records', async () => {
    const token = await authToken(10, 'user');
    let idempotencyInserted = false;
    let acceptUpdates = 0;
    let seatUpdates = 0;

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('INSERT OR IGNORE INTO idempotency_records') && kind === 'run') {
        if (idempotencyInserted) return { changes: 0 };
        idempotencyInserted = true;
        return { changes: 1 };
      }
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

    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'accept-db-dup-1' };
    const first = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers },
      { ...baseEnv, DB: db, CACHE: undefined as unknown as MockKV },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers },
      { ...baseEnv, DB: db, CACHE: undefined as unknown as MockKV },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replay?: boolean };
    expect(secondBody.replay).toBe(true);
    expect(acceptUpdates).toBe(1);
    expect(seatUpdates).toBe(1);
  });

  test('trip booking accept returns internal error when DB update fails', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'accepted'") && kind === 'run') {
        throw new Error('D1_ERROR: statement timeout');
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

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Booking acceptance failed');
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

  test('trip booking reject is idempotent with Idempotency-Key replay', async () => {
    const token = await authToken(10, 'user');
    const sharedCache = new MockKV();
    let rejectUpdates = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 10 };
      }
      if (query.includes("SET status = 'rejected'") && kind === 'run') {
        rejectUpdates += 1;
        return { changes: 1 };
      }
      return null;
    });

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'reject-dup-1',
    };
    const first = await app.request(
      '/api/trips/1/bookings/2/reject',
      { method: 'POST', headers, body: JSON.stringify({ reason: 'No seats left' }) },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/trips/1/bookings/2/reject',
      { method: 'POST', headers, body: JSON.stringify({ reason: 'No seats left' }) },
      { ...baseEnv, DB: db, CACHE: sharedCache },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replay?: boolean };
    expect(secondBody.replay).toBe(true);
    expect(rejectUpdates).toBe(1);
  });

  test('trip cancel rejects non-owner driver', async () => {
    const token = await authToken(12, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 44, status: 'scheduled' };
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
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 12, status: 'cancelled' };
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

  test('trip cancel returns conflict when trip is completed', async () => {
    const token = await authToken(12, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 12, status: 'completed' };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/cancel',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Too late' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Completed trips cannot be cancelled');
  });

  test('trip cancel is idempotent with Idempotency-Key replay', async () => {
    const token = await authToken(12, 'user');
    const sharedCache = new MockKV();
    let cancelUpdates = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 12, status: 'scheduled' };
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

  test('handled validation failures emit handled observability log contract', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.request(
        '/api/payments/webhook',
        {
          method: 'POST',
          body: JSON.stringify({ id: 'evt_missing_sig_handled', type: 'payment_intent.succeeded', data: { object: {} } }),
        },
        { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
      );

      expect(res.status).toBe(400);
      const warnLines = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(warnLines.some((line) => line.includes('"type":"handled"') && line.includes('"code":"VALIDATION_ERROR"'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('unexpected server failures emit unhandled observability log contract', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request(
        '/api/payments/webhook',
        {
          method: 'POST',
          headers: { 'stripe-signature': 'dummy' },
          body: JSON.stringify({ id: 'evt_missing_secret_unhandled', type: 'payment_intent.succeeded', data: { object: {} } }),
        },
        { ...baseEnv, ENVIRONMENT: 'production', DB: new MockDB(() => null), CACHE: new MockKV() },
      );

      expect(res.status).toBe(500);
      const errorLines = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(errorLines.some((line) => line.includes('"type":"unhandled"') && line.includes('"code":"CONFIGURATION_ERROR"'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
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

  test('webhook replay is ignored without CACHE using durable DB replay ledger', async () => {
    let replayInserted = false;
    let replayInsertCalls = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT event_id FROM processed_webhook_events WHERE event_id = ?') && kind === 'first') {
        return replayInserted ? { event_id: 'evt_replay_db_1' } : null;
      }
      if (query.includes('INSERT OR IGNORE INTO processed_webhook_events') && kind === 'run') {
        replayInsertCalls += 1;
        replayInserted = true;
        return { changes: 1 };
      }
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return null;
      }
      return null;
    });

    const event = {
      id: 'evt_replay_db_1',
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_replay_db_1', amount: 1200, metadata: { bookingId: '77' } } },
    };

    const first = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: undefined as unknown as MockKV },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: undefined as unknown as MockKV },
    );

    expect(second.status).toBe(200);
    const body = (await second.json()) as { replay?: boolean };
    expect(body.replay).toBe(true);
    expect(replayInsertCalls).toBe(1);
  });

  test('webhook event retries after transient processing failure with same event id', async () => {
    let attempts = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient booking lookup failure');
        }
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_retry_1' };
      }
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        return { changes: 1 };
      }
      return null;
    });

    const cache = new MockKV();
    const event = {
      id: 'evt_retry_same_id_1',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_retry_1', amount: 1200, metadata: { bookingId: '77' } } },
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
    expect(first.status).toBe(500);

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
    const body = (await second.json()) as { replay?: boolean; received?: boolean };
    expect(body.received).toBe(true);
    expect(body.replay).toBeUndefined();
    expect(attempts).toBe(2);
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

  test('payment intent replays cached idempotent response without creating a new intent', async () => {
    const token = await authToken(44, 'user');
    const cache = new MockKV();
    const idempotencyKey = 'pi-replay-1';
    await cache.put(
      `idempotency:payment-intent:44:10:${idempotencyKey}`,
      JSON.stringify({
        clientSecret: 'cs_test_existing',
        paymentIntentId: 'pi_existing_1',
        amount: 120,
        currency: 'zar',
      }),
    );

    let dbCalls = 0;
    const db = new MockDB(() => {
      dbCalls += 1;
      return null;
    });

    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ tripId: 10, amount: 120 }),
      },
      { ...baseEnv, DB: db, CACHE: cache },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      replay?: boolean;
      paymentIntentId?: string;
      clientSecret?: string;
      amount?: number;
      currency?: string;
    };
    expect(body.replay).toBe(true);
    expect(body.paymentIntentId).toBe('pi_existing_1');
    expect(body.clientSecret).toBe('cs_test_existing');
    expect(body.amount).toBe(120);
    expect(body.currency).toBe('zar');
    expect(dbCalls).toBe(0);
  });

  test('payment intent replays durable DB idempotent response without CACHE', async () => {
    const token = await authToken(44, 'user');
    const idempotencyKey = 'pi-db-replay-1';
    let dbCalls = 0;
    const db = new MockDB((query, _params, kind) => {
      dbCalls += 1;
      if (query.includes('SELECT response_json FROM idempotency_records') && kind === 'first') {
        return {
          response_json: JSON.stringify({
            clientSecret: 'cs_test_db_existing',
            paymentIntentId: 'pi_db_existing_1',
            amount: 120,
            currency: 'zar',
          }),
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/intent',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ tripId: 10, amount: 120 }),
      },
      { ...baseEnv, DB: db, CACHE: undefined as unknown as MockKV },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      replay?: boolean;
      paymentIntentId?: string;
      clientSecret?: string;
      amount?: number;
      currency?: string;
    };
    expect(body.replay).toBe(true);
    expect(body.paymentIntentId).toBe('pi_db_existing_1');
    expect(body.clientSecret).toBe('cs_test_db_existing');
    expect(body.amount).toBe(120);
    expect(body.currency).toBe('zar');
    expect(dbCalls).toBe(1);
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
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        bookingLookupCount += 1;
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_paid_guard_1' };
      }
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        return { changes: 0 };
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
    expect(bookingLookupCount).toBe(1);
  });

  test('payment failed webhook ignores unknown booking and does not mutate state', async () => {
    let failedTransitions = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return null;
      }
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        failedTransitions += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_failed_unknown_booking_1',
          type: 'payment_intent.payment_failed',
          data: {
            object: {
              id: 'pi_failed_unknown_booking_1',
              amount: 1200,
              metadata: { bookingId: '404' },
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
    expect(failedTransitions).toBe(0);
  });

  test('payment failed webhook ignores mismatched payment intent for booking', async () => {
    let failedTransitions = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_expected_failed_1' };
      }
      if (query.includes("SET payment_status = 'failed'") && kind === 'run') {
        failedTransitions += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_failed_intent_mismatch_1',
          type: 'payment_intent.payment_failed',
          data: {
            object: {
              id: 'pi_unexpected_failed_1',
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
    expect(failedTransitions).toBe(0);
  });

  test('payment canceled webhook ignores mismatched payment intent for booking', async () => {
    let canceledTransitions = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_expected_cancel_1' };
      }
      if (query.includes("SET payment_status = 'canceled'") && kind === 'run') {
        canceledTransitions += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy' },
        body: JSON.stringify({
          id: 'evt_canceled_intent_mismatch_1',
          type: 'payment_intent.canceled',
          data: {
            object: {
              id: 'pi_unexpected_cancel_1',
              amount: 1200,
              metadata: { bookingId: '77' },
            },
          },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean };
    expect(body.received).toBe(true);
    expect(canceledTransitions).toBe(0);
  });

  test('payment succeeded webhook is idempotent across distinct event ids for same booking', async () => {
    let paidTransitions = 0;
    let notificationInserts = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_success_once_1' };
      }
      if (query.includes("SET payment_status = 'paid'") && kind === 'run') {
        paidTransitions += 1;
        return { changes: paidTransitions === 1 ? 1 : 0 };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return null;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { changes: 1 };
      }
      return null;
    });
    const cache = new MockKV();
    const env = { ...baseEnv, DB: db, CACHE: cache };

    const first = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 'sig_test',
        },
        body: JSON.stringify({
          id: 'evt_success_once_1',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_success_once_1',
              amount: 2500,
              metadata: { tripId: '10', userId: '44', bookingId: '77' },
            },
          },
        }),
      },
      env,
    );

    const second = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 'sig_test',
        },
        body: JSON.stringify({
          id: 'evt_success_once_2',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_success_once_1',
              amount: 2500,
              metadata: { tripId: '10', userId: '44', bookingId: '77' },
            },
          },
        }),
      },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(paidTransitions).toBe(2);
    expect(notificationInserts).toBe(1);
  });

  test('payment succeeded webhook ignores metadata mismatch against canonical booking context', async () => {
    let paidTransitions = 0;
    let notificationInserts = 0;

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_meta_guard_1' };
      }
      if (query.includes("SET payment_status = 'paid'") && kind === 'run') {
        paidTransitions += 1;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 'sig_test',
        },
        body: JSON.stringify({
          id: 'evt_meta_guard_1',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_meta_guard_1',
              amount: 2500,
              metadata: { tripId: '999', userId: '999', bookingId: '77' },
            },
          },
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received?: boolean };
    expect(body.received).toBe(true);
    expect(paidTransitions).toBe(0);
    expect(notificationInserts).toBe(0);
  });

  test('matching routes require authentication', async () => {
    const res = await app.request('/api/matching/config', { method: 'GET' }, { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHENTICATION_ERROR');
  });

  test('matching driver trip update rejects non-owner user', async () => {
    const token = await authToken(12, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM driver_trips WHERE id = ?1') && kind === 'first') {
        return {
          id: 'trip-1',
          driver_id: 77,
          organization_id: null,
          departure_lat: -26.2,
          departure_lng: 28.0,
          destination_lat: -26.1,
          destination_lng: 28.1,
          shift_lat: null,
          shift_lng: null,
          departure_time: 1700000000000,
          arrival_time: null,
          available_seats: 3,
          total_seats: 4,
          bbox_min_lat: null,
          bbox_max_lat: null,
          bbox_min_lng: null,
          bbox_max_lng: null,
          route_polyline_encoded: null,
          route_distance_km: null,
          status: 'offered',
          driver_rating: null,
          vehicle_json: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/driver-trips/trip-1',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableSeats: 2 }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('matching driver trip read blocks cross-org admin and allows super admin', async () => {
    const adminToken = await authToken(1, 'admin', 'org-a');
    const superAdminToken = await authToken(2, 'super_admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM driver_trips WHERE id = ?1') && kind === 'first') {
        return {
          id: 'trip-1',
          driver_id: 77,
          organization_id: 'org-b',
          departure_lat: -26.2,
          departure_lng: 28.0,
          destination_lat: -26.1,
          destination_lng: 28.1,
          shift_lat: null,
          shift_lng: null,
          departure_time: 1700000000000,
          arrival_time: null,
          available_seats: 3,
          total_seats: 4,
          bbox_min_lat: null,
          bbox_max_lat: null,
          bbox_min_lng: null,
          bbox_max_lng: null,
          route_polyline_encoded: null,
          route_distance_km: null,
          status: 'offered',
          driver_rating: null,
          vehicle_json: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };
    const forbidden = await app.request(
      '/api/matching/driver-trips/trip-1',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      env,
    );
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { error?: { code?: string } };
    expect(forbiddenBody.error?.code).toBe('AUTHORIZATION_ERROR');

    const allowed = await app.request(
      '/api/matching/driver-trips/trip-1',
      { method: 'GET', headers: { Authorization: `Bearer ${superAdminToken}` } },
      env,
    );
    expect(allowed.status).toBe(200);
  });

  test('matching batch endpoint requires admin role', async () => {
    const token = await authToken(33, 'user');
    const res = await app.request(
      '/api/matching/batch',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('matching batch endpoint scopes admin processing to own organization', async () => {
    const token = await authToken(33, 'admin', 'org-a');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM rider_requests') && query.includes("status = 'pending'") && kind === 'all') {
        return [
          {
            id: 'rider-request-org-a',
            rider_id: 101,
            organization_id: 'org-a',
            pickup_lat: -26.2,
            pickup_lng: 28.0,
            dropoff_lat: -26.1,
            dropoff_lng: 28.1,
            earliest_departure: 1700000000000,
            latest_departure: 1700003600000,
            seats_needed: 1,
            preferences_json: null,
            status: 'pending',
            matched_driver_trip_id: null,
            matched_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'rider-request-org-b',
            rider_id: 102,
            organization_id: 'org-b',
            pickup_lat: -26.2,
            pickup_lng: 28.0,
            dropoff_lat: -26.1,
            dropoff_lng: 28.1,
            earliest_departure: 1700000000000,
            latest_departure: 1700003600000,
            seats_needed: 1,
            preferences_json: null,
            status: 'pending',
            matched_driver_trip_id: null,
            matched_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ];
      }
      if (query.includes('SELECT * FROM driver_trips') && kind === 'all') {
        return [];
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/batch',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalRiders?: number };
    expect(body.totalRiders).toBe(1);
  });

  test('matching reject endpoint blocks users outside the match participants', async () => {
    const token = await authToken(55, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') {
        return {
          id: 'match-1',
          driver_trip_id: 'driver-trip-1',
          rider_request_id: 'rider-request-1',
          driver_id: 77,
          rider_id: 88,
          status: 'pending',
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/reject',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'match-1', reason: 'not suitable' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('matching confirm endpoint rejects payload that mismatches match context', async () => {
    const token = await authToken(88, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') {
        return {
          id: 'match-1',
          driver_trip_id: 'driver-trip-actual',
          rider_request_id: 'rider-request-actual',
          driver_id: 77,
          rider_id: 88,
          status: 'pending',
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: 'match-1',
          driverTripId: 'driver-trip-other',
          riderRequestId: 'rider-request-other',
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Match context does not match request payload');
  });

  test('matching confirm blocks cross-org admin access', async () => {
    const token = await authToken(1, 'admin', 'org-a');
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') {
        return {
          id: 'match-1',
          driver_trip_id: 'driver-trip-1',
          rider_request_id: 'rider-request-1',
          driver_id: 77,
          rider_id: 88,
          status: 'pending',
        };
      }
      if (query.includes('FROM rider_requests') && kind === 'first') {
        return {
          id: String(params[0] ?? 'rider-request-1'),
          rider_id: 88,
          organization_id: 'org-b',
          pickup_lat: -26.2,
          pickup_lng: 28.0,
          dropoff_lat: -26.1,
          dropoff_lng: 28.1,
          earliest_departure: 1700000000000,
          latest_departure: 1700003600000,
          seats_needed: 1,
          preferences_json: null,
          status: 'pending',
          matched_driver_trip_id: null,
          matched_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }
      if (query.includes('available_seats = available_seats - 1') && kind === 'run') {
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: 'match-1',
          driverTripId: 'driver-trip-1',
          riderRequestId: 'rider-request-1',
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(body.error?.message).toBe('Not allowed to confirm this match');
  });

  test('matching confirm enforces seat reservation under sequential race on same driver trip', async () => {
    const token = await authToken(88, 'user');
    let availableSeats = 1;
    let match1Status: 'pending' | 'confirmed' = 'pending';
    let match2Status: 'pending' | 'confirmed' = 'pending';

    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') {
        const id = String(params[0] ?? '');
        if (id === 'match-1') {
          return {
            id: 'match-1',
            driver_trip_id: 'driver-trip-1',
            rider_request_id: 'rider-request-1',
            driver_id: 77,
            rider_id: 88,
            status: match1Status,
          };
        }
        if (id === 'match-2') {
          return {
            id: 'match-2',
            driver_trip_id: 'driver-trip-1',
            rider_request_id: 'rider-request-2',
            driver_id: 77,
            rider_id: 88,
            status: match2Status,
          };
        }
      }

      if (query.includes('FROM rider_requests') && kind === 'first') {
        return {
          id: String(params[0] ?? 'rider-request-1'),
          rider_id: 88,
          organization_id: null,
          pickup_lat: -26.2,
          pickup_lng: 28.0,
          dropoff_lat: -26.1,
          dropoff_lng: 28.1,
          earliest_departure: 1700000000000,
          latest_departure: 1700003600000,
          seats_needed: 1,
          preferences_json: null,
          status: 'pending',
          matched_driver_trip_id: null,
          matched_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }

      if (query.includes('FROM driver_trips') && kind === 'first') {
        return {
          id: 'driver-trip-1',
          driver_id: 77,
          organization_id: null,
          departure_lat: -26.2,
          departure_lng: 28.0,
          destination_lat: -26.1,
          destination_lng: 28.1,
          shift_lat: null,
          shift_lng: null,
          departure_time: 1700000000000,
          arrival_time: null,
          available_seats: availableSeats,
          total_seats: 4,
          bbox_min_lat: null,
          bbox_max_lat: null,
          bbox_min_lng: null,
          bbox_max_lng: null,
          route_polyline_encoded: null,
          route_distance_km: null,
          status: 'offered',
          driver_rating: null,
          vehicle_json: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }

      if (query.includes('available_seats = available_seats - 1') && kind === 'run') {
        if (availableSeats > 0) {
          availableSeats -= 1;
          return { changes: 1 };
        }
        return { changes: 0 };
      }

      if (query.includes("SET status = 'confirmed'") && kind === 'run') {
        const id = String(params[0] ?? '');
        if (id === 'match-1') match1Status = 'confirmed';
        if (id === 'match-2') match2Status = 'confirmed';
        return { changes: 1 };
      }

      if (query.includes('UPDATE rider_requests') && kind === 'run') {
        return { changes: 1 };
      }

      return null;
    });

    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const first = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: 'match-1',
          driverTripId: 'driver-trip-1',
          riderRequestId: 'rider-request-1',
        }),
      },
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: 'match-2',
          driverTripId: 'driver-trip-1',
          riderRequestId: 'rider-request-2',
        }),
      },
      env,
    );
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error?: { code?: string; message?: string } };
    expect(secondBody.error?.code).toBe('CONFLICT');
    expect(secondBody.error?.message).toBe('No seats available on driver trip');
  });

  test('matching reject endpoint returns conflict when match is not pending', async () => {
    const token = await authToken(77, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') {
        return {
          id: 'match-2',
          driver_trip_id: 'driver-trip-1',
          rider_request_id: 'rider-request-1',
          driver_id: 77,
          rider_id: 88,
          status: 'rejected',
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/matching/reject',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'match-2', reason: 'duplicate' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toBe('Match is no longer pending');
  });

  test('monitoring sla endpoint requires authentication', async () => {
    const res = await app.request('/api/monitoring/sla', { method: 'GET' }, { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHENTICATION_ERROR');
  });

  test('monitoring security endpoint requires admin role', async () => {
    const userToken = await authToken(21, 'user');
    const forbidden = await app.request(
      '/api/monitoring/security',
      { method: 'GET', headers: { Authorization: `Bearer ${userToken}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { error?: { code?: string } };
    expect(forbiddenBody.error?.code).toBe('AUTHORIZATION_ERROR');

    const adminToken = await authToken(1, 'admin');
    const allowed = await app.request(
      '/api/monitoring/security',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(allowed.status).toBe(200);
  });

  test('monitoring metrics endpoint writes admin audit log on success', async () => {
    const adminToken = await authToken(1, 'admin');
    let auditWrites = 0;
    const db = new MockDB((query, params, kind) => {
      if (query.includes('INSERT INTO audit_logs') && params[1] === 'ADMIN_MONITORING_METRICS_VIEWED' && kind === 'run') {
        auditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/monitoring/metrics',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(auditWrites).toBe(1);
  });

  test('monitoring security endpoint writes admin audit log on success', async () => {
    const adminToken = await authToken(1, 'admin');
    let auditWrites = 0;
    const db = new MockDB((query, params, kind) => {
      if (query.includes('INSERT INTO audit_logs') && params[1] === 'ADMIN_MONITORING_SECURITY_VIEWED' && kind === 'run') {
        auditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/monitoring/security',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(auditWrites).toBe(1);
  });

  test('account deletion is blocked when user is driving active trips', async () => {
    const token = await authToken(33, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') {
        return { count: 0 };
      }
      if (query.includes('FROM trips') && kind === 'first') {
        return { count: 2 };
      }
      return null;
    });

    const res = await app.request(
      '/api/users/account',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('Cannot delete account while driving active trips. Please cancel your trips first.');
  });

  test('admin cannot assign super admin role', async () => {
    const token = await authToken(1, 'admin');
    const res = await app.request(
      '/api/admin/users/55',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'super_admin' }),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(body.error?.message).toBe('Only super admins can assign super admin role');
  });

  test('admin cannot modify existing super admin account', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, role FROM users WHERE id = ?') && kind === 'first') {
        return { id: 2, role: 'super_admin' };
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/2',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(body.error?.message).toBe('Only super admins can modify super admin accounts');
  });
});
