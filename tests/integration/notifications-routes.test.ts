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
    return { success: true, meta: (result as Record<string, unknown>) ?? {} };
  }
}

class MockDB {
  constructor(private resolver: Resolver) {}

  prepare(query: string) {
    return new MockStmt(query, this.resolver);
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

async function authToken(userId: number) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: userId,
    email: `user${userId}@example.com`,
    name: `User ${userId}`,
    role: 'user',
    iat: now,
    exp: now + 3600,
    type: 'access',
  };
  return createToken(payload, baseEnv.JWT_SECRET);
}

describe('Notification route integration flows', () => {
  test('unauthorized requests are rejected for notifications routes', async () => {
    const db = new MockDB(() => null);
    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const noAuthList = await app.request('/api/notifications', {}, env);
    expect(noAuthList.status).toBe(401);
    const noAuthBody = (await noAuthList.json()) as {
      error?: { code?: string; message?: string; status?: number; requestId?: string; timestamp?: string };
    };
    expect(noAuthBody.error?.code).toBe('AUTHENTICATION_ERROR');
    expect(noAuthBody.error?.status).toBe(401);
    expect(noAuthBody.error?.message).toBe('Missing or invalid authorization header');
    expect(typeof noAuthBody.error?.requestId).toBe('string');
    expect(typeof noAuthBody.error?.timestamp).toBe('string');

    const invalidAuthRead = await app.request(
      '/api/notifications/1/read',
      { method: 'PATCH', headers: { Authorization: 'Bearer invalid-token' } },
      env,
    );
    expect(invalidAuthRead.status).toBe(401);

    const noAuthReadAll = await app.request(
      '/api/notifications/read-all',
      { method: 'POST' },
      env,
    );
    expect(noAuthReadAll.status).toBe(401);
  });

  test('lists user notifications with pagination and metadata parsing', async () => {
    const token = await authToken(5);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total') && kind === 'first') return { total: 2 };
      if (query.includes('FROM notifications') && kind === 'all') {
        return [{
          id: 11,
          user_id: 5,
          trip_id: 44,
          notification_type: 'booking_accepted',
          channel: 'in_app',
          status: 'sent',
          subject: 'Booking accepted',
          message: 'Your booking was accepted.',
          metadata: JSON.stringify({ bookingId: 99 }),
          sent_at: '2026-02-17T10:00:00Z',
          delivered_at: null,
          read_at: null,
          created_at: '2026-02-17T10:00:00Z',
        }];
      }
      return null;
    });

    const res = await app.request(
      '/api/notifications?limit=10&offset=0',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: number; metadata: { bookingId: number } | null }>;
      pagination: { total: number };
    };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(11);
    expect(body.data[0]?.metadata?.bookingId).toBe(99);
    expect(body.pagination.total).toBe(2);
  });

  test('marks owned notification as read', async () => {
    const token = await authToken(7);
    let updated = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id FROM notifications') && kind === 'first') return { id: 1 };
      if (query.includes("SET status = 'read'") && kind === 'run') {
        updated = true;
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/notifications/1/read',
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(updated).toBe(true);
  });

  test('returns 404 when trying to mark another user notification as read', async () => {
    const token = await authToken(7);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id FROM notifications') && kind === 'first') return null;
      return null;
    });

    const res = await app.request(
      '/api/notifications/999/read',
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(404);
  });

  test('marks all unread notifications as read', async () => {
    const token = await authToken(9);
    let updateCalled = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total') && kind === 'first') return { total: 3 };
      if (query.includes("SET status = 'read'") && kind === 'run') {
        updateCalled = true;
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/notifications/read-all',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(3);
    expect(updateCalled).toBe(true);
  });

  test('status filter returns only matching notifications', async () => {
    const token = await authToken(5);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('COUNT(*) as total') && kind === 'first') return { total: 1 };
      if (query.includes('FROM notifications') && kind === 'all') {
        return [{
          id: 21,
          user_id: 5,
          trip_id: 88,
          notification_type: 'trip_cancelled',
          channel: 'in_app',
          status: 'read',
          subject: 'Trip cancelled',
          message: 'Your trip was cancelled.',
          metadata: null,
          sent_at: '2026-02-17T10:00:00Z',
          delivered_at: null,
          read_at: '2026-02-17T10:05:00Z',
          created_at: '2026-02-17T10:00:00Z',
        }];
      }
      return null;
    });

    const res = await app.request(
      '/api/notifications?status=read&limit=10&offset=0',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: number; status: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(21);
    expect(body.data[0]?.status).toBe('read');
  });

  test('lifecycle: mark as read then query read notifications', async () => {
    const token = await authToken(13);
    const state = { read: false };
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id FROM notifications') && kind === 'first') return { id: 7 };
      if (query.includes("SET status = 'read'") && kind === 'run') {
        state.read = true;
        return { ok: true };
      }
      if (query.includes('COUNT(*) as total') && kind === 'first') {
        return { total: state.read ? 1 : 0 };
      }
      if (query.includes('FROM notifications') && kind === 'all') {
        return state.read ? [{
          id: 7,
          user_id: 13,
          trip_id: 10,
          notification_type: 'booking_accepted',
          channel: 'in_app',
          status: 'read',
          subject: 'Booking accepted',
          message: 'Accepted.',
          metadata: null,
          sent_at: '2026-02-17T10:00:00Z',
          delivered_at: null,
          read_at: '2026-02-17T10:10:00Z',
          created_at: '2026-02-17T10:00:00Z',
        }] : [];
      }
      return null;
    });

    const markRead = await app.request(
      '/api/notifications/7/read',
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(markRead.status).toBe(200);

    const readList = await app.request(
      '/api/notifications?status=read&limit=10&offset=0',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(readList.status).toBe(200);
    const body = (await readList.json()) as { data: Array<{ id: number; status: string }>; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
    expect(body.data[0]?.id).toBe(7);
    expect(body.data[0]?.status).toBe('read');
  });

  test('limit is clamped to max 100 and min 1', async () => {
    const token = await authToken(15);
    let capturedLimit: unknown = null;
    const db = new MockDB((query, params, kind) => {
      if (query.includes('COUNT(*) as total') && kind === 'first') return { total: 0 };
      if (query.includes('FROM notifications') && kind === 'all') {
        capturedLimit = params[params.length - 2];
        return [];
      }
      return null;
    });

    const highRes = await app.request(
      '/api/notifications?limit=9999&offset=0',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(highRes.status).toBe(200);
    expect(capturedLimit).toBe(100);

    const lowRes = await app.request(
      '/api/notifications?limit=0&offset=0',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(lowRes.status).toBe(200);
    expect(capturedLimit).toBe(1);
  });

  test('offset affects hasMore and page slice behavior', async () => {
    const token = await authToken(16);
    let capturedOffset: unknown = null;
    const db = new MockDB((query, params, kind) => {
      if (query.includes('COUNT(*) as total') && kind === 'first') return { total: 3 };
      if (query.includes('FROM notifications') && kind === 'all') {
        capturedOffset = params[params.length - 1];
        return [{
          id: 31,
          user_id: 16,
          trip_id: 9,
          notification_type: 'booking_accepted',
          channel: 'in_app',
          status: 'sent',
          subject: 'S',
          message: 'M',
          metadata: null,
          sent_at: null,
          delivered_at: null,
          read_at: null,
          created_at: '2026-02-17T10:00:00Z',
        }];
      }
      return null;
    });

    const res = await app.request(
      '/api/notifications?limit=1&offset=2',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(capturedOffset).toBe(2);
    const body = (await res.json()) as {
      data: Array<{ id: number }>;
      pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(31);
    expect(body.pagination.total).toBe(3);
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.offset).toBe(2);
    expect(body.pagination.hasMore).toBe(false);
  });

  test('invalid status filter returns 400 validation error', async () => {
    const token = await authToken(17);
    const db = new MockDB(() => null);

    const res = await app.request(
      '/api/notifications?status=unknown',
      { headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; status?: number; requestId?: string; timestamp?: string };
    };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.status).toBe(400);
    expect(body.error?.message).toBe('Invalid status filter');
    expect(typeof body.error?.requestId).toBe('string');
    expect(typeof body.error?.timestamp).toBe('string');
  });
});
