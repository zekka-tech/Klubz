/**
 * Integration contract tests for /api/matching/* routes.
 *
 * Tests cover:
 *   - Auth boundaries (401 without token)
 *   - Input validation (400 for bad bodies)
 *   - DB unavailability (fails closed at 500)
 *   - Business-logic guards (404, 409)
 */

import { describe, expect, test } from 'vitest';
import app from '../../src/index';
import { createToken } from '../../src/middleware/auth';
import type { JWTPayload } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared test infrastructure (same pattern as security-hardening.test.ts)
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
  SENDGRID_API_KEY: '', MAPBOX_ACCESS_TOKEN: '',
  ENVIRONMENT: 'development',
  APP_URL: 'http://localhost:3000',
  API_VERSION: 'v1',
  SESSIONS: new MockKV(),
  RATE_LIMIT_KV: new MockKV(),
} as const;

async function authToken(userId: number, role: 'user' | 'admin' | 'super_admin' = 'user', orgId?: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { sub: userId, email: `user${userId}@example.com`, name: `User ${userId}`, role, orgId, iat: now, exp: now + 3600, type: 'access' };
  return createToken(payload, baseEnv.JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Matching routes contract tests', () => {

  // ── Auth boundaries ───────────────────────────────────────────────────────

  test('POST /matching/driver-trips returns 401 without token', async () => {
    const res = await app.request(
      '/api/matching/driver-trips',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('POST /matching/rider-requests returns 401 without token', async () => {
    const res = await app.request(
      '/api/matching/rider-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('POST /matching/find returns 401 without token', async () => {
    const res = await app.request(
      '/api/matching/find',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('POST /matching/confirm returns 401 without token', async () => {
    const res = await app.request(
      '/api/matching/confirm',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  test('GET /matching/config returns 401 without token', async () => {
    const res = await app.request(
      '/api/matching/config',
      { method: 'GET' },
      { ...baseEnv, CACHE: new MockKV() },
    );
    expect(res.status).toBe(401);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  test('POST /matching/driver-trips returns 400 for missing required fields', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/matching/driver-trips',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ departure: { lat: -26.2, lng: 28.0 } }), // missing destination, time, etc.
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  test('POST /matching/find returns 400 for missing pickup/dropoff', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/matching/find',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatsNeeded: 1 }), // missing pickup/dropoff
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  test('POST /matching/rider-requests returns 400 for past departure time', async () => {
    // Departure time validation (with 5-min grace window) lives in /rider-requests, not /find
    const token = await authToken(1);
    const db = new MockDB((_query, _params, _kind) => null);
    const now = Date.now();
    const res = await app.request(
      '/api/matching/rider-requests',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup: { lat: -26.2, lng: 28.0 },
          dropoff: { lat: -26.1, lng: 28.1 },
          earliestDeparture: now - 3_600_000, // 1 hour in the past (well beyond 5-min grace)
          latestDeparture: now - 3_500_000,
          seatsNeeded: 1,
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  test('POST /matching/confirm returns 400 for missing matchId', async () => {
    const token = await authToken(1);
    const db = new MockDB(() => null);
    const res = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverTripId: 'dt-1' }), // missing matchId and riderRequestId
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(400);
  });

  // ── Business-logic guards ─────────────────────────────────────────────────

  test('POST /matching/confirm returns 404 for unknown matchId', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM match_results') && kind === 'first') return null; // not found
      return null;
    });
    const res = await app.request(
      '/api/matching/confirm',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'nonexistent-match', driverTripId: 'dt-1', riderRequestId: 'rr-1' }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(404);
  });

  test('DELETE /matching/driver-trips/:id returns 403 when not the owner', async () => {
    const token = await authToken(99); // not the driver
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM driver_trips') && kind === 'first') {
        return { id: 'dt-1', driver_id: 1, status: 'offered' }; // driver is user 1, not 99
      }
      return null;
    });
    const res = await app.request(
      '/api/matching/driver-trips/dt-1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(403);
  });

  test('GET /matching/config returns 403 for non-admin updating another org', async () => {
    const token = await authToken(1, 'user', 'org-a'); // user in org-a
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM matching_config') && kind === 'first') return null;
      return null;
    });
    const res = await app.request(
      '/api/matching/config?organizationId=org-b', // requesting org-b config
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ maxResults: 5 }) },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
  });

  // ── DB unavailability ─────────────────────────────────────────────────────

  test('POST /matching/driver-trips fails closed when DB unavailable', async () => {
    // Route uses MatchingRepository(c.env.DB) directly — no DB yields 500
    const token = await authToken(1);
    const now = Date.now();
    const res = await app.request(
      '/api/matching/driver-trips',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departure: { lat: -26.2, lng: 28.0 },
          destination: { lat: -26.1, lng: 28.1 },
          departureTime: now + 3_600_000,
          arrivalTime: now + 7_200_000,
          totalSeats: 4,
          availableSeats: 3,
        }),
      },
      { ...baseEnv, CACHE: new MockKV() }, // no DB
    );
    expect(res.status).toBe(500);
  });

  // ── Successful path sanity ────────────────────────────────────────────────

  test('POST /matching/find returns empty matches array when no drivers available', async () => {
    const token = await authToken(1);
    const db = new MockDB((query, _params, kind) => {
      if (query.includes('FROM driver_trips') && kind === 'all') return [];
      if (query.includes('FROM rider_requests') && kind === 'first') return null;
      if (query.includes('INSERT INTO rider_requests') && kind === 'run') return { last_row_id: 42 };
      if (query.includes('INSERT INTO match_results') && kind === 'run') return { changes: 0 };
      return null;
    });
    const now = Date.now();
    const res = await app.request(
      '/api/matching/find',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup: { lat: -26.2041, lng: 28.0473 },
          dropoff: { lat: -26.1076, lng: 28.0567 },
          earliestDeparture: now + 1_800_000,
          latestDeparture: now + 3_600_000,
          seatsNeeded: 1,
        }),
      },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { matches?: unknown[] };
    expect(Array.isArray(body.matches)).toBe(true);
    expect(body.matches?.length).toBe(0);
  });

  test('GET /matching/stats returns 200 for admin', async () => {
    const token = await authToken(1, 'admin');
    const db = new MockDB((query, _params, kind) => {
      if (kind === 'first') return { total: 0, avg: 0, confirmed: 0, rejected: 0, pending: 0 };
      if (kind === 'all') return [];
      return null;
    });
    const res = await app.request(
      '/api/matching/stats',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { ...baseEnv, DB: db, CACHE: new MockKV() },
    );
    expect(res.status).toBe(200);
  });
});
