import { describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';
import { encrypt } from '../../src/lib/encryption';

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

const prefsTripUpdatesDisabled = {
  notifications_json: JSON.stringify({
    tripReminders: true,
    tripUpdates: false,
    marketingEmails: false,
    smsNotifications: true,
  }),
  privacy_json: JSON.stringify({
    shareLocation: true,
    allowDriverContact: true,
    showInDirectory: false,
  }),
  accessibility_json: JSON.stringify({
    wheelchairAccessible: false,
    visualImpairment: false,
    hearingImpairment: false,
  }),
  language: 'en',
  timezone: 'Africa/Johannesburg',
  currency: 'ZAR',
};

const prefsSmsDisabled = {
  notifications_json: JSON.stringify({
    tripReminders: true,
    tripUpdates: true,
    marketingEmails: false,
    smsNotifications: false,
  }),
  privacy_json: JSON.stringify({
    shareLocation: true,
    allowDriverContact: true,
    showInDirectory: false,
  }),
  accessibility_json: JSON.stringify({
    wheelchairAccessible: false,
    visualImpairment: false,
    hearingImpairment: false,
  }),
  language: 'en',
  timezone: 'Africa/Johannesburg',
  currency: 'ZAR',
};

const prefsNotificationsEnabled = {
  notifications_json: JSON.stringify({
    tripReminders: true,
    tripUpdates: true,
    marketingEmails: false,
    smsNotifications: true,
  }),
  privacy_json: JSON.stringify({
    shareLocation: true,
    allowDriverContact: true,
    showInDirectory: false,
  }),
  accessibility_json: JSON.stringify({
    wheelchairAccessible: false,
    visualImpairment: false,
    hearingImpairment: false,
  }),
  language: 'en',
  timezone: 'Africa/Johannesburg',
  currency: 'ZAR',
};

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

describe('Notification preference enforcement integration', () => {
  test('booking acceptance skips persisted notification when tripUpdates is disabled', async () => {
    const token = await authToken(50, 'user');
    let notificationInserts = 0;

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 50 };
      }
      if (query.includes("UPDATE trip_participants SET status = 'accepted'") && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return prefsTripUpdatesDisabled;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { ok: true };
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

    expect(res.status).toBe(200);
    expect(notificationInserts).toBe(0);
  });

  test('payment succeeded webhook skips persisted notification when tripUpdates is disabled', async () => {
    const token = await authToken(44, 'user');
    let notificationInserts = 0;
    const event = {
      id: 'evt_pref_skip_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_pref_skip_1',
          amount: 2500,
          metadata: {
            tripId: '10',
            userId: '44',
            bookingId: '77',
          },
        },
      },
    };

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_pref_skip_1' };
      }
      if (query.includes("SET payment_status = 'paid'") && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return prefsTripUpdatesDisabled;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy', Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(notificationInserts).toBe(0);
  });

  test('booking acceptance does not send SMS when smsNotifications is disabled', async () => {
    const token = await authToken(60, 'user');
    const smsEncrypted = await encrypt('+27123456789', baseEnv.ENCRYPTION_KEY, '60');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 60 };
      }
      if (query.includes("UPDATE trip_participants SET status = 'accepted'") && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('SELECT tp.user_id') && kind === 'first') {
        return {
          user_id: 60,
          title: 'Morning Ride',
          origin: 'A',
          destination: 'B',
          departure_time: new Date().toISOString(),
          price_per_seat: 30,
          email: 'rider@example.com',
          first_name_encrypted: null,
          last_name_encrypted: null,
          phone_encrypted: JSON.stringify({ data: smsEncrypted }),
          driver_first_name: null,
        };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return prefsSmsDisabled;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        ...baseEnv,
        TWILIO_ACCOUNT_SID: 'AC_test',
        TWILIO_AUTH_TOKEN: 'auth_test',
        TWILIO_PHONE_NUMBER: '+10000000000',
        DB: db,
        CACHE: new MockKV(),
      },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('booking acceptance sends SMS and persists notification when preferences allow it', async () => {
    const token = await authToken(61, 'user');
    const smsEncrypted = await encrypt('+27123456780', baseEnv.ENCRYPTION_KEY, '61');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ sid: 'SM123', status: 'sent' }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ));
    let notificationInserts = 0;

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 61 };
      }
      if (query.includes("UPDATE trip_participants SET status = 'accepted'") && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('UPDATE trips SET available_seats = available_seats - 1') && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('SELECT tp.user_id') && kind === 'first') {
        return {
          user_id: 61,
          title: 'Evening Ride',
          origin: 'A',
          destination: 'B',
          departure_time: new Date().toISOString(),
          price_per_seat: 30,
          email: 'rider@example.com',
          first_name_encrypted: null,
          last_name_encrypted: null,
          phone_encrypted: JSON.stringify({ data: smsEncrypted }),
          driver_first_name: null,
        };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return prefsNotificationsEnabled;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        ...baseEnv,
        TWILIO_ACCOUNT_SID: 'AC_test',
        TWILIO_AUTH_TOKEN: 'auth_test',
        TWILIO_PHONE_NUMBER: '+10000000000',
        DB: db,
        CACHE: new MockKV(),
      },
    );

    expect(res.status).toBe(200);
    expect(notificationInserts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  test('payment succeeded webhook persists notification when tripUpdates is enabled', async () => {
    const token = await authToken(44, 'user');
    let notificationInserts = 0;
    const event = {
      id: 'evt_pref_allow_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_pref_allow_1',
          amount: 2500,
          metadata: {
            tripId: '10',
            userId: '44',
            bookingId: '88',
          },
        },
      },
    };

    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT user_id, trip_id, payment_intent_id FROM trip_participants WHERE id = ?') && kind === 'first') {
        return { user_id: 44, trip_id: 10, payment_intent_id: 'pi_pref_allow_1' };
      }
      if (query.includes("SET payment_status = 'paid'") && kind === 'run') {
        return { ok: true };
      }
      if (query.includes('FROM user_preferences') && kind === 'first') {
        return prefsNotificationsEnabled;
      }
      if (query.includes('INSERT INTO notifications') && kind === 'run') {
        notificationInserts += 1;
        return { ok: true };
      }
      return null;
    });

    const res = await app.request(
      '/api/payments/webhook',
      {
        method: 'POST',
        headers: { 'stripe-signature': 'dummy', Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );

    expect(res.status).toBe(200);
    expect(notificationInserts).toBe(1);
  });
});
