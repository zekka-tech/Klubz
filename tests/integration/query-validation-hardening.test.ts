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

async function authToken(userId: number, role: 'user' | 'admin' | 'super_admin' = 'user', orgId?: string) {
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

  test('matching driver trip update rejects invalid or inconsistent payloads', async () => {
    const token = await authToken(77, 'user');
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT * FROM driver_trips WHERE id = ?1') && kind === 'first') {
        return {
          id: 'trip-1',
          driver_id: 77,
          organization_id: null,
          departure_lat: -26.2,
          departure_lng: 28.0,
          destination_lat: -26.1,
          destination_lng: 28.1,
          shift_lat: null,
          shift_lng: null,
          departure_time: 1700000000000,
          arrival_time: null,
          available_seats: 3,
          total_seats: 4,
          bbox_min_lat: null,
          bbox_max_lat: null,
          bbox_min_lng: null,
          bbox_max_lng: null,
          route_polyline_encoded: null,
          route_distance_km: null,
          status: 'offered',
          driver_rating: null,
          vehicle_json: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    });
    const env = { ...baseEnv, DB: db, CACHE: new MockKV() };

    const emptyRes = await app.request('/api/matching/driver-trips/trip-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env);
    expect(emptyRes.status).toBe(400);
    const emptyBody = (await emptyRes.json()) as { error?: { code?: string } };
    expect(emptyBody.error?.code).toBe('VALIDATION_ERROR');

    const statusRes = await app.request('/api/matching/driver-trips/trip-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'scheduled' }),
    }, env);
    expect(statusRes.status).toBe(400);
    const statusBody = (await statusRes.json()) as { error?: { code?: string } };
    expect(statusBody.error?.code).toBe('VALIDATION_ERROR');

    const seatsRes = await app.request('/api/matching/driver-trips/trip-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ availableSeats: 5 }),
    }, env);
    expect(seatsRes.status).toBe(400);
    const seatsBody = (await seatsRes.json()) as { error?: { code?: string; message?: string } };
    expect(seatsBody.error?.code).toBe('VALIDATION_ERROR');
    expect(seatsBody.error?.message).toBe('availableSeats cannot exceed trip totalSeats');
  });

  test('matching create driver trip rejects availableSeats greater than totalSeats', async () => {
    const token = await authToken(10, 'user');
    const res = await app.request('/api/matching/driver-trips', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departure: { lat: -26.2, lng: 28.0 },
        destination: { lat: -26.1, lng: 28.1 },
        departureTime: Date.now() + 60_000,
        availableSeats: 5,
        totalSeats: 4,
      }),
    }, { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toContain('availableSeats cannot exceed totalSeats');
  });

  test('matching config update rejects invalid payload', async () => {
    const token = await authToken(1, 'admin', 'org-1');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };

    const emptyRes = await app.request('/api/matching/config', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env);
    expect(emptyRes.status).toBe(400);
    const emptyBody = (await emptyRes.json()) as { error?: { code?: string } };
    expect(emptyBody.error?.code).toBe('VALIDATION_ERROR');

    const invalidRes = await app.request('/api/matching/config', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxResults: 0 }),
    }, env);
    expect(invalidRes.status).toBe(400);
    const invalidBody = (await invalidRes.json()) as { error?: { code?: string } };
    expect(invalidBody.error?.code).toBe('VALIDATION_ERROR');
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

  test('trip offer rejects invalid price payloads', async () => {
    const token = await authToken(10, 'user');
    const env = { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() };
    const res = await app.request('/api/trips/offer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pickupLocation: { address: 'A' },
        dropoffLocation: { address: 'B' },
        scheduledTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        availableSeats: 3,
        price: -5,
        vehicleInfo: { make: 'Toyota', model: 'Corolla', licensePlate: 'ABC123' },
      }),
    }, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });
});
