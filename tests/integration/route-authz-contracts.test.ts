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
  DB: new MockDB(() => null),
  CACHE: new MockKV(),
  SESSIONS: new MockKV(),
  RATE_LIMIT_KV: new MockKV(),
} as const;

async function authToken(
  userId: number,
  role: 'user' | 'admin' | 'super_admin' = 'user',
  orgId?: string,
) {
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

describe('Route authz contracts', () => {
  test('public routes are reachable without authentication', async () => {
    const health = await app.request('/health', { method: 'GET' }, baseEnv);
    expect(health.status).toBe(200);

    const hello = await app.request('/api/hello', { method: 'GET' }, baseEnv);
    expect(hello.status).toBe(200);

    const webhook = await app.request(
      '/api/payments/webhook',
      { method: 'POST', body: JSON.stringify({}) },
      baseEnv,
    );
    // Public endpoint: request may fail validation, but not auth.
    expect(webhook.status).not.toBe(401);
  });

  test('authenticated route group rejects missing JWT', async () => {
    const cases: Array<{ method: 'GET'; path: string }> = [
      { method: 'GET', path: '/api/users/profile' },
      { method: 'GET', path: '/api/users/trips' },
      { method: 'GET', path: '/api/trips/available' },
      { method: 'GET', path: '/api/matching/config' },
      { method: 'GET', path: '/api/monitoring/sla' },
    ];

    for (const tcase of cases) {
      const res = await app.request(tcase.path, { method: tcase.method }, baseEnv);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTHENTICATION_ERROR');
    }
  });

  test('admin-only routes reject authenticated non-admin users', async () => {
    const userToken = await authToken(20, 'user');
    const cases: Array<{ method: 'GET'; path: string }> = [
      { method: 'GET', path: '/api/admin/organizations' },
      { method: 'GET', path: '/api/admin/logs' },
      { method: 'GET', path: '/api/monitoring/security' },
      { method: 'GET', path: '/api/monitoring/metrics' },
    ];

    for (const tcase of cases) {
      const res = await app.request(
        tcase.path,
        { method: tcase.method, headers: { Authorization: `Bearer ${userToken}` } },
        baseEnv,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    }
  });

  test('admin-only routes allow admin users', async () => {
    const adminToken = await authToken(1, 'admin');

    const adminOrganizations = await app.request(
      '/api/admin/organizations',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      baseEnv,
    );
    expect(adminOrganizations.status).toBe(200);

    const monitoringSecurity = await app.request(
      '/api/monitoring/security',
      { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } },
      baseEnv,
    );
    expect(monitoringSecurity.status).toBe(200);
  });

  test('matching routes enforce organization scope for admin and allow super admin override', async () => {
    const adminToken = await authToken(1, 'admin', 'org-a');
    const superAdminToken = await authToken(2, 'super_admin');

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM rider_requests') && kind === 'first') {
        return {
          id: 'rider-request-1',
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
      if (query.includes('SELECT * FROM driver_trips') && kind === 'all') {
        return [];
      }
      if (query.includes('SELECT * FROM match_results') && kind === 'all') {
        return [];
      }
      return null;
    });

    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const adminCases: Array<{ method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }> = [
      { method: 'GET', path: '/api/matching/rider-requests/rider-request-1' },
      { method: 'GET', path: '/api/matching/results/rider-request-1' },
      { method: 'POST', path: '/api/matching/find', body: { riderRequestId: 'rider-request-1' } },
      { method: 'POST', path: '/api/matching/find-pool', body: { riderRequestId: 'rider-request-1' } },
      { method: 'POST', path: '/api/matching/reject', body: { matchId: 'match-1' } },
    ];

    for (const tcase of adminCases) {
      const res = await app.request(
        tcase.path,
        {
          method: tcase.method,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            ...(tcase.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(tcase.body ? { body: JSON.stringify(tcase.body) } : {}),
        },
        env,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    }

    const superAdminFind = await app.request(
      '/api/matching/find',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${superAdminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ riderRequestId: 'rider-request-1' }),
      },
      env,
    );
    expect(superAdminFind.status).toBe(200);
  });
});
