import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';


type ResolverKind = 'first' | 'all' | 'run';
type Resolver = (query: string, params: unknown[], kind: ResolverKind) => unknown;

class MockStmt {
  private params: unknown[] = [];
  constructor(private query: string, private resolver: Resolver) {}
  bind(...values: unknown[]) { this.params = values; return this; }
  async first<T>(): Promise<T | null> { return (this.resolver(this.query, this.params, 'first') ?? null) as T | null; }
  async all<T>(): Promise<{ success: boolean; results?: T[] }> { return { success: true, results: (this.resolver(this.query, this.params, 'all') as T[]) ?? [] }; }
  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> { return { success: true, meta: (this.resolver(this.query, this.params, 'run') as Record<string, unknown>) ?? { changes: 1, last_row_id: 1 } }; }
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
  SENDGRID_API_KEY: '', MAPBOX_ACCESS_TOKEN: '',
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

describe('Messages route contracts', () => {
  test('POST /trips/:tripId/messages returns 401 without token', async () => {
    const res = await app.request(
      '/api/trips/1/messages',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) },
      { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('POST /trips/:tripId/messages returns 403 when user is not in trip', async () => {
    const token = await authToken(5);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT driver_id FROM trips') && kind === 'first') {
        return { driver_id: 10 };
      }
      if (query.includes('FROM trip_participants') && kind === 'first') {
        return null;
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/messages',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(403);
  });

  test('POST /trips/:tripId/messages stores encrypted message and returns 201', async () => {
    const token = await authToken(5);
    let insertedContent = '';

    const db = new MockDB((query, params, kind) => {
      if (query.includes('SELECT driver_id FROM trips') && kind === 'first') {
        return { driver_id: 5 };
      }
      if (query.includes('INSERT INTO messages') && kind === 'run') {
        insertedContent = String(params[2] ?? '');
        return { last_row_id: 77, changes: 1 };
      }
      if (query.includes('FROM trip_participants') && kind === 'all') {
        return [{ user_id: 5 }, { user_id: 8 }];
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/22/messages',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'secret rider note' }) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(201);
    expect(insertedContent).not.toContain('secret rider note');
    expect(insertedContent).toContain('ct');
    const body = await res.json() as { message?: { id?: number } };
    expect(body.message?.id).toBe(77);
  });

  test('GET /trips/:tripId/messages returns conversation payload', async () => {
    const token = await authToken(5);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT driver_id FROM trips') && kind === 'first') {
        return { driver_id: 5 };
      }
      if (query.includes('FROM messages m') && kind === 'all') {
        return [{
          id: 1,
          trip_id: 22,
          sender_id: 5,
          content_encrypted: 'hello there',
          sent_at: new Date().toISOString(),
          read_at: null,
          first_name_encrypted: 'Alice',
          last_name_encrypted: 'Driver',
        }];
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/22/messages?limit=20&page=1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { messages?: Array<{ content?: string }> };
    expect(body.messages?.[0]?.content).toBe('hello there');
  });
});
