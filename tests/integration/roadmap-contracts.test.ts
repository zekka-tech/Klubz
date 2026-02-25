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

class MockStorage {
  public putCalls: Array<{ key: string; size: number; contentType?: string }> = [];

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob, options?: { httpMetadata?: Record<string, string> }) {
    let size = 0;
    if (typeof value === 'string') size = value.length;
    else if (value instanceof ArrayBuffer) size = value.byteLength;
    else if (ArrayBuffer.isView(value)) size = value.byteLength;
    this.putCalls.push({ key, size, contentType: options?.httpMetadata?.contentType });
    return {
      key,
      size,
      etag: 'etag',
      uploaded: new Date(),
    };
  }

  async get() { return null; }
  async delete() { return; }
  async head() { return null; }
  async list() { return { objects: [], truncated: false }; }
  async createMultipartUpload() {
    throw new Error('not implemented');
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
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  APPLE_CLIENT_ID: 'com.klubz.web',
  APPLE_TEAM_ID: 'TEAMID1234',
  APPLE_KEY_ID: 'KEYID1234',
  APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgCQrQkqp0Xd9DGKxt\nopWmnyxhTuLJLigz7t9p+Ed8QiKhRANCAAQ0Sb65bsjNu+ETQU+TqgzEWztdx/2A\nSVDH/bGMeMe1X7qGvIHO4Zle41ertemtShmANjAu/vjmigC6OYJIqO+K\n-----END PRIVATE KEY-----`,
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  ENVIRONMENT: 'development',
  APP_URL: 'http://localhost:3000',
  API_VERSION: 'v1',
  CACHE: new MockKV(),
  SESSIONS: new MockKV(),
  RATE_LIMIT_KV: new MockKV(),
  STORAGE: new MockStorage(),
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

describe('Roadmap integration contracts', () => {
  test('documents r2 upload returns 401 when token missing', async () => {
    const token = await authToken(1);
    const res = await app.request(
      '/api/users/documents/r2-upload?uploadToken=missing',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: 'data' },
      { ...baseEnv, DB: new MockDB(() => null), SESSIONS: new MockKV(), STORAGE: new MockStorage() },
    );

    expect(res.status).toBe(401);
  });

  test('documents r2 upload returns 403 when token belongs to another user', async () => {
    const token = await authToken(1);
    const sessions = new MockKV();
    await sessions.put('r2upload:abc', JSON.stringify({ userId: 2, fileKey: 'users/2/docs/a.pdf', docType: 'drivers_license' }));

    const res = await app.request(
      '/api/users/documents/r2-upload?uploadToken=abc',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: 'data' },
      { ...baseEnv, DB: new MockDB(() => null), SESSIONS: sessions, STORAGE: new MockStorage() },
    );

    expect(res.status).toBe(403);
  });

  test('documents r2 upload returns 413 when content-length exceeds limit', async () => {
    const token = await authToken(1);
    const sessions = new MockKV();
    await sessions.put('r2upload:big', JSON.stringify({ userId: 1, fileKey: 'users/1/docs/b.pdf', docType: 'drivers_license' }));

    const res = await app.request(
      '/api/users/documents/r2-upload?uploadToken=big',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/pdf',
          'Content-Length': String(11 * 1024 * 1024),
        },
        body: 'small-body',
      },
      { ...baseEnv, DB: new MockDB(() => null), SESSIONS: sessions, STORAGE: new MockStorage() },
    );

    expect(res.status).toBe(413);
  });

  test('documents r2 upload stores file and returns success', async () => {
    const token = await authToken(1);
    const sessions = new MockKV();
    const storage = new MockStorage();
    await sessions.put('r2upload:ok', JSON.stringify({ userId: 1, fileKey: 'users/1/docs/c.pdf', docType: 'drivers_license' }));

    const res = await app.request(
      '/api/users/documents/r2-upload?uploadToken=ok',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/pdf',
          'Content-Length': '5',
        },
        body: 'hello',
      },
      { ...baseEnv, DB: new MockDB(() => null), SESSIONS: sessions, STORAGE: storage },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; fileKey?: string };
    expect(body.success).toBe(true);
    expect(body.fileKey).toBe('users/1/docs/c.pdf');
    expect(storage.putCalls.length).toBe(1);
  });

  test('dispute filing denies non-participants', async () => {
    const token = await authToken(7);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') return null;
      if (query.includes('FROM trips WHERE id = ? AND driver_id = ?') && kind === 'first') return null;
      return null;
    });

    const res = await app.request(
      '/api/disputes',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 12, reason: 'Driver never arrived at pickup location' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(403);
  });

  test('dispute filing rejects non-completed trips', async () => {
    const token = await authToken(2);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') return { id: 1 };
      if (query.includes('SELECT id, status FROM trips') && kind === 'first') return { id: 9, status: 'active' };
      return null;
    });

    const res = await app.request(
      '/api/disputes',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 9, reason: 'Trip started too late and never reached destination' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(400);
  });

  test('dispute filing creates record for completed trips', async () => {
    const token = await authToken(3);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') return { id: 1 };
      if (query.includes('SELECT id, status FROM trips') && kind === 'first') return { id: 11, status: 'completed' };
      if (query.includes('FROM disputes') && kind === 'first') return null;
      if (query.includes('INSERT INTO disputes') && kind === 'run') return { last_row_id: 55 };
      return null;
    });

    const res = await app.request(
      '/api/disputes',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 11, reason: 'Driver charged extra cash outside the app' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { disputeId?: number };
    expect(body.disputeId).toBe(55);
  });

  test('dispute filing rejects duplicate open disputes', async () => {
    const token = await authToken(4);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trip_participants') && kind === 'first') return { id: 1 };
      if (query.includes('SELECT id, status FROM trips') && kind === 'first') return { id: 15, status: 'completed' };
      if (query.includes('FROM disputes') && kind === 'first') return { id: 19 };
      return null;
    });

    const res = await app.request(
      '/api/disputes',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: 15, reason: 'Vehicle details did not match listed driver profile' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(409);
  });

  test('promo validation returns invalid for expired code', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM promo_codes') && kind === 'first') {
        return {
          id: 1,
          discount_type: 'percent',
          discount_value: 10,
          max_uses: null,
          uses_count: 0,
          min_fare_cents: 0,
          expires_at: '2000-01-01T00:00:00.000Z',
          is_active: 1,
        };
      }
      return null;
    });

    const res = await app.request(
      '/api/promo-codes/validate?code=OLD',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isValid?: boolean; reason?: string };
    expect(body.isValid).toBe(false);
    expect(body.reason).toBe('expired');
  });

  test('promo validation returns invalid for usage limit and already redeemed', async () => {
    const token = await authToken(1);

    const limitDb = new MockDB((query, _params, kind) => {
      if (query.includes('FROM promo_codes') && kind === 'first') {
        return {
          id: 2,
          discount_type: 'fixed_cents',
          discount_value: 200,
          max_uses: 1,
          uses_count: 1,
          min_fare_cents: 0,
          expires_at: null,
          is_active: 1,
        };
      }
      return null;
    });

    const limitRes = await app.request(
      '/api/promo-codes/validate?code=FULL',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: limitDb },
    );
    const limitBody = (await limitRes.json()) as { isValid?: boolean; reason?: string };
    expect(limitBody.isValid).toBe(false);
    expect(limitBody.reason).toBe('usage_limit_reached');

    const redeemedDb = new MockDB((query, _params, kind) => {
      if (query.includes('FROM promo_codes') && kind === 'first') {
        return {
          id: 3,
          discount_type: 'fixed_cents',
          discount_value: 150,
          max_uses: null,
          uses_count: 0,
          min_fare_cents: 0,
          expires_at: null,
          is_active: 1,
        };
      }
      if (query.includes('FROM promo_redemptions') && kind === 'first') return { id: 42 };
      return null;
    });

    const redeemedRes = await app.request(
      '/api/promo-codes/validate?code=USED',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: redeemedDb },
    );
    const redeemedBody = (await redeemedRes.json()) as { isValid?: boolean; reason?: string };
    expect(redeemedBody.isValid).toBe(false);
    expect(redeemedBody.reason).toBe('already_redeemed');
  });

  test('promo validation returns valid discount details', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM promo_codes') && kind === 'first') {
        return {
          id: 4,
          discount_type: 'percent',
          discount_value: 15,
          max_uses: null,
          uses_count: 0,
          min_fare_cents: 500,
          expires_at: null,
          is_active: 1,
        };
      }
      if (query.includes('FROM promo_redemptions') && kind === 'first') return null;
      return null;
    });

    const res = await app.request(
      '/api/promo-codes/validate?code=SAVE15',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isValid?: boolean; discountType?: string; discountValue?: number; minFareCents?: number };
    expect(body).toEqual({
      isValid: true,
      discountType: 'percent',
      discountValue: 15,
      minFareCents: 500,
    });
  });

  test('loyalty redeem blocks self-referral', async () => {
    const token = await authToken(8);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM referral_codes') && kind === 'first') return { user_id: 8 };
      return null;
    });

    const res = await app.request(
      '/api/referrals/redeem',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: 'SELF8888' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(400);
  });

  test('loyalty redeem blocks duplicate redemption', async () => {
    const token = await authToken(8);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM referral_codes') && kind === 'first') return { user_id: 99 };
      if (query.includes("reason = 'referral_redeem'") && kind === 'first') return { id: 1 };
      return null;
    });

    const res = await app.request(
      '/api/referrals/redeem',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: 'FRIEND99' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(409);
  });

  test('loyalty redeem awards points to both users', async () => {
    const token = await authToken(8);
    let ledgerInserts = 0;

    const db = new MockDB((query, params, kind) => {
      if (query.includes('FROM referral_codes') && kind === 'first') return { user_id: 99 };
      if (query.includes("reason = 'referral_redeem'") && kind === 'first') return null;
      if (query.includes('COALESCE(SUM(delta), 0) as balance') && kind === 'first') return { balance: 0 };
      if (query.includes('INSERT INTO points_ledger') && kind === 'run') {
        ledgerInserts += 1;
        return { last_row_id: ledgerInserts };
      }
      if (query.includes('UPDATE referral_codes SET uses_count = uses_count + 1') && kind === 'run') return { changes: 1 };
      if (query.includes('SELECT id FROM points_ledger WHERE user_id = ? AND reason = ? AND reference_id = ?') && kind === 'first') {
        const reason = params[1];
        if (reason === 'referral_redeem') return null;
        if (reason === 'referral_success') return null;
      }
      return null;
    });

    const res = await app.request(
      '/api/referrals/redeem',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: 'FRIEND99' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; pointsAwarded?: number };
    expect(body.success).toBe(true);
    expect(body.pointsAwarded).toBe(200);
    expect(ledgerInserts).toBe(2);
  });

  test('apple oauth callback rejects invalid state', async () => {
    const res = await app.request(
      '/api/auth/apple/callback?code=abc123&state=missing',
      { method: 'GET' },
      { ...baseEnv, DB: new MockDB(() => null), SESSIONS: new MockKV() },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('oauth_error=state_invalid');
  });

  test('apple oauth callback stores oauth session and redirects on valid exchange', async () => {
    const sessions = new MockKV();
    await sessions.put('oauth:state:good-state', '1');

    const payload = Buffer.from(JSON.stringify({ sub: 'apple-sub-1', email: 'apple@example.com' })).toString('base64url');
    const idToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const db = new MockDB((query, _params, kind) => {
      if (query.includes("oauth_provider = 'apple' AND oauth_id = ?") && kind === 'first') {
        return {
          id: 15,
          email: 'apple@example.com',
          role: 'user',
          first_name_encrypted: null,
          last_name_encrypted: null,
          is_active: 1,
        };
      }
      if (query.includes('UPDATE users') && kind === 'run') return { changes: 1 };
      if (query.includes('INSERT INTO sessions') && kind === 'run') return { changes: 1 };
      if (query.includes('INSERT INTO audit_logs') && kind === 'run') return { changes: 1 };
      return null;
    });

    const res = await app.request(
      '/api/auth/apple/callback?code=ok-code&state=good-state',
      { method: 'GET' },
      { ...baseEnv, DB: db, SESSIONS: sessions },
    );

    fetchSpy.mockRestore();

    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('oauth_code=');
    const url = new URL(location);
    const oauthCode = url.searchParams.get('oauth_code');
    expect(oauthCode).toBeTruthy();
    const stored = await sessions.get(`oauth:sess:${oauthCode}`);
    expect(stored).toBeTruthy();
  });
});
