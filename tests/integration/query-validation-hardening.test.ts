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
    return { success: true, meta: (result as Record<string, unknown>) ?? { changes: 1, last_row_id: 1 } };
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

describe('Query and payload validation hardening', () => {
  test('matching driver-trips rejects invalid status, limit, and offset query params', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };

    const statusRes = await app.request('/api/matching/driver-trips?status=unknown', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(statusRes.status).toBe(400);
    const statusBody = (await statusRes.json()) as { error?: { code?: string; message?: string } };
    expect(statusBody.error?.code).toBe('VALIDATION_ERROR');
    expect(statusBody.error?.message).toBe('Invalid status query parameter');

    const limitRes = await app.request('/api/matching/driver-trips?limit=0', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(limitRes.status).toBe(400);
    const limitBody = (await limitRes.json()) as { error?: { code?: string; message?: string } };
    expect(limitBody.error?.message).toBe('Invalid limit query parameter');

    const offsetRes = await app.request('/api/matching/driver-trips?offset=-2', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(offsetRes.status).toBe(400);
    const offsetBody = (await offsetRes.json()) as { error?: { code?: string; message?: string } };
    expect(offsetBody.error?.message).toBe('Invalid offset query parameter');
  });

  test('matching rider-requests rejects invalid status, limit, and offset query params', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };

    const statusRes = await app.request('/api/matching/rider-requests?status=weird', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(statusRes.status).toBe(400);
    const statusBody = (await statusRes.json()) as { error?: { code?: string; message?: string } };
    expect(statusBody.error?.message).toBe('Invalid status query parameter');

    const limitRes = await app.request('/api/matching/rider-requests?limit=9999', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(limitRes.status).toBe(400);
    const limitBody = (await limitRes.json()) as { error?: { code?: string; message?: string } };
    expect(limitBody.error?.message).toBe('Invalid limit query parameter');

    const offsetRes = await app.request('/api/matching/rider-requests?offset=a', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(offsetRes.status).toBe(400);
    const offsetBody = (await offsetRes.json()) as { error?: { code?: string; message?: string } };
    expect(offsetBody.error?.message).toBe('Invalid offset query parameter');
  });

  test('user trips rejects invalid page, limit, and status filters', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };

    const pageRes = await app.request('/api/users/trips?page=0', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(pageRes.status).toBe(400);
    const pageBody = (await pageRes.json()) as { error?: { message?: string } };
    expect(pageBody.error?.message).toBe('Invalid page query parameter');

    const limitRes = await app.request('/api/users/trips?limit=1000', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(limitRes.status).toBe(400);
    const limitBody = (await limitRes.json()) as { error?: { message?: string } };
    expect(limitBody.error?.message).toBe('Invalid limit query parameter');

    const statusRes = await app.request('/api/users/trips?status=pending', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(statusRes.status).toBe(400);
    const statusBody = (await statusRes.json()) as { error?: { message?: string } };
    expect(statusBody.error?.message).toBe('Invalid status filter');
  });

  test('user trip creation rejects invalid seat constraints', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };
    const res = await app.request('/api/users/trips', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pickupLocation: { address: 'A' },
        dropoffLocation: { address: 'B' },
        scheduledTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        availableSeats: 6,
        totalSeats: 4,
      }),
    }, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('Available seats cannot exceed total seats');
  });

  test('trip search rejects invalid coordinates and maxDetour', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };

    const coordRes = await app.request(
      '/api/trips/available?pickupLat=200&pickupLng=28&dropoffLat=-26&dropoffLng=28',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(coordRes.status).toBe(400);
    const coordBody = (await coordRes.json()) as { error?: { code?: string; message?: string } };
    expect(coordBody.error?.code).toBe('VALIDATION_ERROR');
    expect(coordBody.error?.message).toContain('pickupLat');

    const detourRes = await app.request(
      '/api/trips/available?pickupLat=-26&pickupLng=28&dropoffLat=-26.1&dropoffLng=28.1&maxDetour=0',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(detourRes.status).toBe(400);
    const detourBody = (await detourRes.json()) as { error?: { code?: string; message?: string } };
    expect(detourBody.error?.code).toBe('VALIDATION_ERROR');
    expect(detourBody.error?.message).toContain('maxDetour');
  });
});
