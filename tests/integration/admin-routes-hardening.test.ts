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

describe('Admin route hardening contracts', () => {
  test('admin stats returns 500 when DB batch fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((_query, _params, kind) => {
      if (kind === 'all') throw new Error('db unavailable');
      return null;
    });

    const res = await app.request(
      '/api/admin/stats',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load admin statistics');
  });

  test('admin users list returns 500 when DB read fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total FROM users') && kind === 'first') {
        throw new Error('count failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load users');
  });

  test('admin user detail returns 500 when DB read fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM users u WHERE u.id = ?') && kind === 'first') {
        throw new Error('detail failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/77',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load user details');
  });

  test('admin logs returns 500 when DB read fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total FROM audit_logs') && kind === 'first') {
        throw new Error('audit count failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/logs',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load audit logs');
  });

  test('admin users list rejects invalid page query', async () => {
    const token = await authToken(1, 'admin');
    const res = await app.request(
      '/api/admin/users?page=0',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('Invalid page query parameter');
  });

  test('admin users list rejects invalid limit query', async () => {
    const token = await authToken(1, 'admin');
    const res = await app.request(
      '/api/admin/users?limit=1000',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('Invalid limit query parameter');
  });

  test('admin users list rejects invalid role/status filters', async () => {
    const token = await authToken(1, 'admin');
    const roleRes = await app.request(
      '/api/admin/users?role=owner',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(roleRes.status).toBe(400);
    const roleBody = (await roleRes.json()) as { error?: { code?: string; message?: string } };
    expect(roleBody.error?.code).toBe('VALIDATION_ERROR');
    expect(roleBody.error?.message).toBe('Invalid role filter');

    const statusRes = await app.request(
      '/api/admin/users?status=blocked',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(statusRes.status).toBe(400);
    const statusBody = (await statusRes.json()) as { error?: { code?: string; message?: string } };
    expect(statusBody.error?.code).toBe('VALIDATION_ERROR');
    expect(statusBody.error?.message).toBe('Invalid status filter');
  });

  test('admin logs list rejects invalid pagination and level filters', async () => {
    const token = await authToken(1, 'admin');
    const pageRes = await app.request(
      '/api/admin/logs?page=-1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(pageRes.status).toBe(400);
    const pageBody = (await pageRes.json()) as { error?: { code?: string; message?: string } };
    expect(pageBody.error?.code).toBe('VALIDATION_ERROR');
    expect(pageBody.error?.message).toBe('Invalid page query parameter');

    const limitRes = await app.request(
      '/api/admin/logs?limit=500',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(limitRes.status).toBe(400);
    const limitBody = (await limitRes.json()) as { error?: { code?: string; message?: string } };
    expect(limitBody.error?.code).toBe('VALIDATION_ERROR');
    expect(limitBody.error?.message).toBe('Invalid limit query parameter');

    const levelRes = await app.request(
      '/api/admin/logs?level=error*',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(levelRes.status).toBe(400);
    const levelBody = (await levelRes.json()) as { error?: { code?: string; message?: string } };
    expect(levelBody.error?.code).toBe('VALIDATION_ERROR');
    expect(levelBody.error?.message).toBe('Invalid level filter');
  });

  test('admin organizations list rejects invalid pagination query params', async () => {
    const token = await authToken(1, 'admin');

    const pageRes = await app.request(
      '/api/admin/organizations?page=0',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(pageRes.status).toBe(400);
    const pageBody = (await pageRes.json()) as { error?: { code?: string; message?: string } };
    expect(pageBody.error?.code).toBe('VALIDATION_ERROR');
    expect(pageBody.error?.message).toBe('Invalid page query parameter');

    const limitRes = await app.request(
      '/api/admin/organizations?limit=1000',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(limitRes.status).toBe(400);
    const limitBody = (await limitRes.json()) as { error?: { code?: string; message?: string } };
    expect(limitBody.error?.code).toBe('VALIDATION_ERROR');
    expect(limitBody.error?.message).toBe('Invalid limit query parameter');
  });

  test('admin organizations list returns 500 when DB read fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total FROM (') && kind === 'first') {
        throw new Error('org count failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/organizations',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to load organizations');
  });

  test('admin organizations list returns derived organizations with metrics and pagination', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, params, kind) => {
      if (query.includes('COUNT(*) as total FROM (') && kind === 'first') {
        return { total: 2 };
      }
      if (query.includes('FROM (') && query.includes('orgs.organization_id') && kind === 'all') {
        expect(params).toEqual([1, 1]);
        return [
          {
            organization_id: 'org-b',
            driver_trip_count: 3,
            rider_request_count: 5,
            has_matching_config: 1,
            last_activity_at: '2026-02-18T00:00:00.000Z',
          },
        ];
      }
      if (query.includes("INSERT INTO audit_logs") && kind === 'run') {
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/organizations?page=2&limit=1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<{
        id: string;
        metrics: { driverTrips: number; riderRequests: number; hasMatchingConfig: boolean };
        lastActivityAt: string | null;
      }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    expect(body.organizations).toEqual([
      {
        id: 'org-b',
        metrics: { driverTrips: 3, riderRequests: 5, hasMatchingConfig: true },
        lastActivityAt: '2026-02-18T00:00:00.000Z',
      },
    ]);
    expect(body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  test('admin update requires authentication', async () => {
    const res = await app.request(
      '/api/admin/users/10',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHENTICATION_ERROR');
  });

  test('admin update rejects empty payload with no supported fields', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, role FROM users') && kind === 'first') {
        return { id: 10, role: 'user' };
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/10',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('No supported fields provided for update');
  });

  test('admin update returns 500 when DB write fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, role FROM users') && kind === 'first') {
        return { id: 10, role: 'user' };
      }
      if (query.startsWith('UPDATE users SET') && kind === 'run') {
        throw new Error('write failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/10',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to update user');
  });

  test('admin update writes audit log on success', async () => {
    const token = await authToken(1, 'admin');
    let auditWrites = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, role FROM users') && kind === 'first') {
        return { id: 10, role: 'user' };
      }
      if (query.startsWith('UPDATE users SET') && kind === 'run') {
        return { changes: 1 };
      }
      if (query.includes("INSERT INTO audit_logs") && query.includes('ADMIN_USER_UPDATED') && kind === 'run') {
        auditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/10',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(auditWrites).toBe(1);
  });

  test('admin export writes audit log on success', async () => {
    const token = await authToken(1, 'admin');
    let exportAuditWrites = 0;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM users WHERE id = ?') && kind === 'first') {
        return {
          email: 'target@example.com',
          first_name_encrypted: 'First',
          last_name_encrypted: 'Last',
          role: 'user',
          created_at: '2026-01-01T00:00:00.000Z',
        };
      }
      if (query.includes('SELECT t.* FROM trips') && kind === 'all') {
        return [];
      }
      if (query.includes('INSERT INTO data_export_requests') && kind === 'run') {
        return { changes: 1 };
      }
      if (query.includes("INSERT INTO audit_logs") && query.includes('ADMIN_USER_EXPORT') && kind === 'run') {
        exportAuditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/10/export',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(exportAuditWrites).toBe(1);
  });

  test('admin export returns 500 when export persistence fails', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM users WHERE id = ?') && kind === 'first') {
        return {
          email: 'target@example.com',
          first_name_encrypted: 'First',
          last_name_encrypted: 'Last',
          role: 'user',
          created_at: '2026-01-01T00:00:00.000Z',
        };
      }
      if (query.includes('SELECT t.* FROM trips') && kind === 'all') {
        return [];
      }
      if (query.includes('INSERT INTO data_export_requests') && kind === 'run') {
        throw new Error('insert failed');
      }
      return null;
    });

    const res = await app.request(
      '/api/admin/users/10/export',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Failed to export user data');
  });

  test('admin read endpoints write audit logs on success', async () => {
    const token = await authToken(1, 'admin');
    const auditActions: string[] = [];

    const db = new MockDB((query, params, kind) => {
      if (query.includes("INSERT INTO audit_logs") && kind === 'run') {
        auditActions.push(String(params[1]));
        return { changes: 1 };
      }
      if (query.includes('COUNT(*) as total FROM users') && kind === 'first') {
        return { total: 0 };
      }
      if (query.includes('FROM users u WHERE u.id = ?') && kind === 'first') {
        return {
          id: 10,
          email: 'user10@example.com',
          first_name_encrypted: 'Test',
          last_name_encrypted: 'User',
          role: 'user',
          phone_encrypted: '+1234567890',
          is_active: 1,
          email_verified: 1,
          mfa_enabled: 0,
          total_trips: 1,
          avg_rating: 4.5,
          created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null,
        };
      }
      if (query.includes('COUNT(*) as total FROM audit_logs') && kind === 'first') {
        return { total: 0 };
      }
      return null;
    });

    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };
    const statsRes = await app.request('/api/admin/stats', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);
    const usersRes = await app.request('/api/admin/users', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);
    const userDetailRes = await app.request('/api/admin/users/10', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);
    const orgRes = await app.request('/api/admin/organizations', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);
    const logsRes = await app.request('/api/admin/logs', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, env);

    expect(statsRes.status).toBe(200);
    expect(usersRes.status).toBe(200);
    expect(userDetailRes.status).toBe(200);
    expect(orgRes.status).toBe(200);
    expect(logsRes.status).toBe(200);
    expect(auditActions).toEqual(expect.arrayContaining([
      'ADMIN_STATS_VIEWED',
      'ADMIN_USERS_LIST_VIEWED',
      'ADMIN_USER_DETAIL_VIEWED',
      'ADMIN_ORGANIZATIONS_VIEWED',
      'ADMIN_LOGS_VIEWED',
    ]));
  });
});
