/**
 * Integration contract tests for /api/trips/* routes.
 *
 * Tests cover:
 *   - Auth boundaries (401 without token, 403 for non-owner)
 *   - Input validation (400 for bad bodies)
 *   - Business-logic guards (409 for state conflicts)
 *   - DB unavailability (fails closed at 500)
 *
 * Uses the MockDB / MockKV pattern from security-hardening.test.ts.
 */

import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

type ResolverKind = 'first' | 'all' | 'run';
type Resolver = (query: string, params: unknown[], kind: ResolverKind) => unknown;

class MockStmt {
  private params: unknown[] = [];
  constructor(private query: string, private resolver: Resolver) {}
  bind(...values: unknown[]) { this.params = values; return this; }
  async first<T>(): Promise<T | null> { return (this.resolver(this.query, this.params, 'first') ?? null) as T | null; }
  async all<T>(): Promise<{ success: boolean; results?: T[] }> { return { success: true, results: (this.resolver(this.query, this.params, 'all') as T[]) ?? [] }; }
  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> { return { success: true, meta: (this.resolver(this.query, this.params, 'run') as Record<string, unknown>) ?? { last_row_id: 1 } }; }
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
  const payload: JWTPayload = { sub: userId, email: `user${userId}@example.com`, name: `User ${userId}`, role, iat: now, exp: now + 3600, type: 'access' };
  return createToken(payload, baseEnv.JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trips routes contract tests', () => {

  // ── Auth boundaries ───────────────────────────────────────────────────────

  test('GET /trips/available returns 401 without token', async () => {
    const res = await app.request('/api/trips/available', { method: 'GET' }, { ...baseEnv, DB: new MockDB(() => null), CACHE: new MockKV() });
    expect(res.status).toBe(401);
  });

  test('POST /trips/offer returns 401 without token', async () => {
    const res = await app.request('/api/trips/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }, { ...baseEnv, CACHE: new MockKV() });
    expect(res.status).toBe(401);
  });

  test('POST /trips/:id/book returns 401 without token', async () => {
    const res = await app.request('/api/trips/1/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }, { ...baseEnv, CACHE: new MockKV() });
    expect(res.status).toBe(401);
  });

  test('POST /trips/:id/cancel returns 401 without token', async () => {
    const res = await app.request('/api/trips/1/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }, { ...baseEnv, CACHE: new MockKV() });
    expect(res.status).toBe(401);
  });

  // ── DB unavailability (fails closed) ──────────────────────────────────────

  test('POST /trips/offer fails closed when DB is unavailable', async () => {
    const token = await authToken(1);
    const res = await app.request(
      '/api/trips/offer',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'Johannesburg CBD' },
          dropoffLocation: { address: 'Pretoria' },
          scheduledTime: new Date(Date.now() + 3_600_000).toISOString(),
          vehicleInfo: { make: 'Toyota', model: 'Corolla', licensePlate: 'GP123ABC' },
        }),
      },
      { ...baseEnv, CACHE: new MockKV() }, // no DB
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
  });

  test('POST /trips/:id/cancel fails closed when DB is unavailable', async () => {
    const token = await authToken(1);
    const res = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFIGURATION_ERROR');
  });

  // ── Input validation ──────────────────────────────────────────────────────

  test('POST /trips/offer returns 400 for missing required fields', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/trips/offer',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'JHB' }), // missing required fields
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  test('POST /trips/:id/rate returns 400 for out-of-range rating', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips') && kind === 'first') return { id: 1, driver_id: 2, status: 'completed' };
      if (query.includes('FROM trip_participants') && kind === 'first') return { id: 1, user_id: 1, role: 'rider', status: 'accepted', rating: null };
      return null;
    });
    const res = await app.request(
      '/api/trips/1/rate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 6 }), // invalid: > 5
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  // ── Business-logic guards ─────────────────────────────────────────────────

  test('POST /trips/:id/cancel returns 404 for unknown trip', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') return null; // not found
      return null;
    });
    const res = await app.request(
      '/api/trips/999/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
  });

  test('POST /trips/:id/cancel returns 403 when user is not the driver', async () => {
    const token = await authToken(99); // user 99, driver_id is 1
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'scheduled' };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('POST /trips/:id/cancel returns 409 for already-cancelled trip', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'cancelled' };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFLICT');
  });

  test('POST /trips/:id/cancel returns 409 for completed trip', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'completed' };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
  });

  test('POST /trips/:id/bookings/:bookingId/accept returns 403 when not the driver', async () => {
    const token = await authToken(99); // not the driver
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'scheduled', available_seats: 3 };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  test('POST /trips/:id/bookings/:bookingId/accept returns 409 when booking is not pending', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'scheduled', available_seats: 3 };
      }
      // Simulate booking already accepted: UPDATE WHERE status='requested' matches 0 rows
      if (query.includes("SET status = 'accepted'") && kind === 'run') {
        return { changes: 0 };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/bookings/2/accept',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('CONFLICT');
  });

  test('POST /trips/:id/book returns 404 for non-existent trip', async () => {
    const token = await authToken(5);
    const db = new MockDB((_query, _params, _kind) => null); // trip not found
    const res = await app.request(
      '/api/trips/999/book',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickupLocation: { address: 'Pickup' }, dropoffLocation: { address: 'Dropoff' } }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
  });

  test('POST /trips/:id/book returns 403 when driver tries to book own trip', async () => {
    const token = await authToken(1); // driver is user 1
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'scheduled', available_seats: 3 };
      }
      return null;
    });
    const res = await app.request(
      '/api/trips/1/book',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickupLocation: { address: 'Pickup' }, dropoffLocation: { address: 'Dropoff' } }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  // ── Successful path sanity ────────────────────────────────────────────────

  test('POST /trips/offer returns 200 and tripId for valid payload', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('INSERT INTO trips') && kind === 'run') return { last_row_id: 99 };
      if (query.includes('INSERT INTO trip_participants') && kind === 'run') return { changes: 1 };
      return null;
    });
    const res = await app.request(
      '/api/trips/offer',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupLocation: { address: 'Johannesburg CBD' },
          dropoffLocation: { address: 'Sandton' },
          scheduledTime: new Date(Date.now() + 3_600_000).toISOString(),
          vehicleInfo: { make: 'Toyota', model: 'Corolla', licensePlate: 'GP001XYZ' },
          availableSeats: 3,
          price: 50,
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { trip?: { id: number } };
    expect(body.trip?.id).toBe(99);
  });

  test('POST /trips/:id/cancel succeeds for driver with valid trip', async () => {
    const token = await authToken(1);
    let cancelUpdateCalled = false;
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('SELECT id, driver_id, status FROM trips') && kind === 'first') {
        return { id: 1, driver_id: 1, status: 'scheduled' };
      }
      if (query.includes("UPDATE trips SET status = 'cancelled'") && kind === 'run') {
        cancelUpdateCalled = true;
        return { changes: 1 };
      }
      if (query.includes('UPDATE trip_participants') && kind === 'run') return { changes: 0 };
      if (query.includes('FROM trip_participants tp') && kind === 'all') return [];
      if (query.includes('INSERT INTO idempotency_records') && kind === 'run') return { changes: 1 };
      if (query.includes('FROM idempotency_records') && kind === 'first') return null;
      return null;
    });
    const res = await app.request(
      '/api/trips/1/cancel',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Test cancellation' }) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    expect(cancelUpdateCalled).toBe(true);
    const body = await res.json() as { message?: string };
    expect(body.message).toContain('cancelled');
  });
});
