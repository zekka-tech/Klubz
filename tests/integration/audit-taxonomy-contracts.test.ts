import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import { hashPassword } from '../../src/lib/encryption';
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

describe('Audit taxonomy contracts', () => {
  test('auth login writes USER_LOGIN audit action', async () => {
    const password = 'StrongPass123!';
    const passwordHash = await hashPassword(password);
    let auditWrites = 0;
    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM users WHERE email_hash') && kind === 'first') {
        return {
          id: 10,
          email: 'user10@example.com',
          password_hash: passwordHash,
          first_name_encrypted: 'Test',
          last_name_encrypted: 'User',
          role: 'user',
          is_active: 1,
          mfa_enabled: 0,
        };
      }
      if (query.includes('UPDATE users SET last_login_at') && kind === 'run') {
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO audit_logs') && params[1] === 'USER_LOGIN' && kind === 'run') {
        auditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });

    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user10@example.com', password }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(auditWrites).toBe(1);
  });

  test('auth register and logout write USER_REGISTER and USER_LOGOUT audit actions', async () => {
    let registerAuditWrites = 0;
    let logoutAuditWrites = 0;
    const token = await authToken(11, 'user');

    const db = new MockDB((query, params, kind) => {
      if (query.includes('SELECT id FROM users WHERE email_hash') && kind === 'first') {
        return null;
      }
      if (query.includes('INSERT INTO users') && kind === 'run') {
        return { last_row_id: 11 };
      }
      if (query.includes('INSERT INTO audit_logs') && params[1] === 'USER_REGISTER' && kind === 'run') {
        registerAuditWrites += 1;
        return { changes: 1 };
      }
      if (query.includes('INSERT INTO audit_logs') && params[1] === 'USER_LOGOUT' && kind === 'run') {
        logoutAuditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });
    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const registerRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new11@example.com',
          password: 'StrongPass123!',
          name: 'New User',
        }),
      },
      env,
    );
    expect(registerRes.status).toBe(200);

    const logoutRes = await app.request(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );
    expect(logoutRes.status).toBe(200);
    expect(registerAuditWrites).toBe(1);
    expect(logoutAuditWrites).toBe(1);
  });

  test('user export and account deletion write DATA_EXPORT and ACCOUNT_DELETED audit actions', async () => {
    const token = await authToken(12, 'user');
    let exportAuditWrites = 0;
    let deleteAuditWrites = 0;

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM users WHERE id = ?') && kind === 'all') {
        return [{
          id: 12,
          email: 'user12@example.com',
          first_name_encrypted: null,
          last_name_encrypted: null,
          phone_encrypted: null,
          role: 'user',
          email_verified: 1,
          phone_verified: 0,
          mfa_enabled: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null,
          created_ip: '127.0.0.1',
        }];
      }
      if (query.includes('SELECT t.* FROM trips t') && kind === 'all') return [];
      if (query.includes('SELECT * FROM audit_logs') && kind === 'all') return [];
      if (query.includes('SELECT tp.*, t.title') && kind === 'all') return [];
      if (query.includes("VALUES (?, 'DATA_EXPORT', 'user'") && kind === 'run') {
        exportAuditWrites += 1;
        return { changes: 1 };
      }
      if (query.includes('FROM trip_participants') && kind === 'first') return { count: 0 };
      if (query.includes('FROM trips') && kind === 'first') return { count: 0 };
      if (query.includes('UPDATE users') && kind === 'run') return { changes: 1 };
      if (query.includes('UPDATE trip_participants') && kind === 'run') return { changes: 1 };
      if (query.includes("VALUES (?, 'ACCOUNT_DELETED', 'user'") && kind === 'run') {
        deleteAuditWrites += 1;
        return { changes: 1 };
      }
      return null;
    });
    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const exportRes = await app.request(
      '/api/users/export',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(exportRes.status).toBe(200);

    const deleteRes = await app.request(
      '/api/users/account',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(deleteRes.status).toBe(200);

    expect(exportAuditWrites).toBe(1);
    expect(deleteAuditWrites).toBe(1);
  });
});
