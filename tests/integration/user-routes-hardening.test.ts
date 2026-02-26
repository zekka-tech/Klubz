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

describe('User route hardening contracts', () => {
  test('public user rating endpoint returns aggregate data without auth', async () => {
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') {
        expect(params).toEqual([42]);
        return { review_count: 3, avg_rating: 4.3333 };
      }
      return null;
    });

    const res = await app.request(
      '/api/users/42/rating',
      { method: 'GET' },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { averageRating?: number; reviewCount?: number };
    expect(body.averageRating).toBe(4.3);
    expect(body.reviewCount).toBe(3);
  });

  test('public user rating endpoint validates user id', async () => {
    const res = await app.request(
      '/api/users/not-a-number/rating',
      { method: 'GET' },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  test('user profile returns 500 when DB read fails', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM users u WHERE u.id = ?') && kind === 'first') {
        throw new Error('profile read failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/users/profile',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load profile');
  });

  test('user profile update returns 500 when DB write fails', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.startsWith('UPDATE users SET') && kind === 'run') {
        throw new Error('profile update failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/users/profile',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated User' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to update profile');
  });

  test('user trips list returns 500 when DB read fails', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total FROM trip_participants') && kind === 'first') {
        throw new Error('trip count failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/users/trips',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load trips');
  });

  test('user trip creation returns 500 when DB write fails', async () => {
    const token = await authToken(10, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('INSERT INTO trips') && kind === 'run') {
        throw new Error('trip insert failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/users/trips',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'A' },
          dropoffLocation: { address: 'B' },
          scheduledTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to create trip');
  });

  test('driver earnings falls back to legacy fare fields when fare_rate_per_km is null', async () => {
    const token = await authToken(15, 'user');
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM trips t') && kind === 'all') {
        expect(params).toEqual([15]);
        return [
          { month: '2026-02', trip_count: 2, estimated_earnings: 102.5 },
        ];
      }
      return null;
    });

    const res = await app.request(
      '/api/users/earnings',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      months: Array<{ month: string; trip_count: number; estimated_earnings: number }>;
      summary: { totalEarnings: number; totalTrips: number; avgPerTrip: number };
    };
    expect(body.months).toHaveLength(1);
    expect(body.months[0]?.estimated_earnings).toBe(102.5);
    expect(body.summary.totalEarnings).toBe(102.5);
    expect(body.summary.totalTrips).toBe(2);
    expect(body.summary.avgPerTrip).toBe(51.25);
  });
});
