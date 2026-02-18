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
});
