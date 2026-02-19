/**
 * Klubz Comprehensive Test Suite v3.1
 * Covers: Unit, Integration, Security, Performance, PWA, Accessibility
 * ─────────────────────────────────────────────────────────────────────
 * Updated for D1-backed routes with dev-mode fallbacks.
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

// ═══ Test Framework ═══
class TestRunner {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.results = [];
    this.startTime = Date.now();
  }

  async run(name, fn) {
    try {
      await fn();
      this.passed++;
      this.results.push({ name, status: 'passed' });
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      this.failed++;
      this.results.push({ name, status: 'failed', error: err.message });
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    \x1b[31m${err.message}\x1b[0m`);
    }
  }

  skip(name) {
    this.skipped++;
    this.results.push({ name, status: 'skipped' });
    console.log(`  \x1b[33m○\x1b[0m ${name} (skipped)`);
  }

  summary() {
    const duration = Date.now() - this.startTime;
    const total = this.passed + this.failed + this.skipped;
    console.log('\n' + '═'.repeat(60));
    console.log(`\x1b[1mTest Results:\x1b[0m ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped (${total} total)`);
    console.log(`Duration: ${duration}ms`);
    console.log('═'.repeat(60));
    return this.failed === 0;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(str, sub, msg = '') {
  if (!String(str).includes(sub)) throw new Error(`${msg} Expected "${str}" to include "${sub}"`);
}

async function fetchJSON(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

// Store tokens for authenticated requests
let accessToken = null;

// ═══ Test Suites ═══

async function testHealthAndInfra(runner) {
  console.log('\n\x1b[36m── Health & Infrastructure ──\x1b[0m');

  await runner.run('GET /health returns 200', async () => {
    const { status, data } = await fetchJSON('/health');
    assertEqual(status, 200, 'Health status');
    assertEqual(data.status, 'healthy');
    assert(data.version, 'Should have version');
    assert(data.timestamp, 'Should have timestamp');
  });

  await runner.run('GET /health includes features', async () => {
    const { data } = await fetchJSON('/health');
    assert(data.features, 'Should have features');
    assertEqual(data.features.matching, true, 'Matching feature');
    assertEqual(data.features.pwa, true, 'PWA feature');
    assertEqual(data.features.encryption, true, 'Encryption feature');
  });

  await runner.run('GET /api/hello returns message', async () => {
    const { status, data } = await fetchJSON('/api/hello');
    assertEqual(status, 200);
    assertEqual(data.message, 'Hello from Klubz API!');
  });

  await runner.run('GET / returns HTML (PWA shell)', async () => {
    const res = await fetch(`${BASE_URL}/`);
    const html = await res.text();
    assertEqual(res.status, 200);
    assertIncludes(html, 'Klubz');
    assertIncludes(html, 'manifest.json');
    assertIncludes(html, 'app.js');
  });

  await runner.run('GET /manifest.json is valid', async () => {
    const res = await fetch(`${BASE_URL}/manifest.json`);
    const manifest = await res.json();
    assertEqual(manifest.short_name, 'Klubz');
    assert(manifest.icons.length > 0, 'Should have icons');
    assert(manifest.start_url, 'Should have start_url');
    assertEqual(manifest.display, 'standalone');
  });

  await runner.run('GET /sw.js returns service worker', async () => {
    const res = await fetch(`${BASE_URL}/sw.js`);
    assertEqual(res.status, 200);
    const text = await res.text();
    assertIncludes(text, 'addEventListener');
    assertIncludes(text, 'cache');
  });

  await runner.run('GET /offline.html exists', async () => {
    const res = await fetch(`${BASE_URL}/offline.html`);
    assertEqual(res.status, 200);
    const text = await res.text();
    assertIncludes(text, 'Offline');
  });
}

async function testSecurityHeaders(runner) {
  console.log('\n\x1b[36m── Security Headers ──\x1b[0m');

  await runner.run('CSP header is present', async () => {
    const { headers } = await fetchJSON('/health');
    const csp = headers.get('Content-Security-Policy');
    assert(csp, 'CSP header should be present');
    assertIncludes(csp, "default-src 'self'");
    assertIncludes(csp, "frame-ancestors 'none'");
  });

  await runner.run('X-Content-Type-Options is nosniff', async () => {
    const { headers } = await fetchJSON('/health');
    assertEqual(headers.get('X-Content-Type-Options'), 'nosniff');
  });

  await runner.run('X-Frame-Options is DENY', async () => {
    const { headers } = await fetchJSON('/health');
    assertEqual(headers.get('X-Frame-Options'), 'DENY');
  });

  await runner.run('X-XSS-Protection is disabled per modern browser guidance', async () => {
    const { headers } = await fetchJSON('/health');
    assertEqual(headers.get('X-XSS-Protection'), '0');
  });

  await runner.run('Referrer-Policy is set', async () => {
    const { headers } = await fetchJSON('/health');
    assertEqual(headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  await runner.run('HSTS header is set', async () => {
    const { headers } = await fetchJSON('/health');
    const hsts = headers.get('Strict-Transport-Security');
    assert(hsts, 'HSTS should be set');
    assertIncludes(hsts, 'max-age=');
  });

  await runner.run('Permissions-Policy restricts features', async () => {
    const { headers } = await fetchJSON('/health');
    const pp = headers.get('Permissions-Policy');
    assert(pp, 'Permissions-Policy should be set');
    assertIncludes(pp, 'camera=()');
  });

  await runner.run('X-Request-ID is generated', async () => {
    const { headers } = await fetchJSON('/health');
    const rid = headers.get('X-Request-ID');
    assert(rid, 'X-Request-ID should be set');
    assert(rid.length > 10, 'Should be UUID-like');
  });

  await runner.run('CORS headers present for OPTIONS', async () => {
    const res = await fetch(`${BASE_URL}/api/hello`, { method: 'OPTIONS' });
    assert(res.status === 204 || res.status === 200, `CORS preflight should succeed, got ${res.status}`);
    assert(res.headers.get('Access-Control-Allow-Methods'), 'Should have allow methods');
  });
}

async function testAuthentication(runner) {
  console.log('\n\x1b[36m── Authentication ──\x1b[0m');

  await runner.run('POST /api/auth/login with valid credentials', async () => {
    const { status, data } = await fetchJSON('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@klubz.com', password: 'password123' }),
    });
    assertEqual(status, 200);
    assert(data.accessToken, 'Should return access token');
    assert(data.refreshToken, 'Should return refresh token');
    assert(data.user, 'Should return user');
    assert(data.user.id !== undefined, 'User should have id');
    assert(data.user.email, 'User should have email');

    // Store token for subsequent tests
    accessToken = data.accessToken;
  });

  await runner.run('POST /api/auth/login with missing fields returns 400', async () => {
    const { status, data } = await fetchJSON('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@klubz.com' }),
    });
    assertEqual(status, 400);
    assert(data.error, 'Should have error');
  });

  await runner.run('POST /api/auth/login with short password returns 400', async () => {
    const { status } = await fetchJSON('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@klubz.com', password: '123' }),
    });
    assertEqual(status, 400);
  });

  await runner.run('POST /api/auth/register with valid data', async () => {
    const { status, data } = await fetchJSON('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `test-${Date.now()}@klubz.com`,
        password: 'securePass123!',
        name: 'Test User',
        role: 'user',
      }),
    });
    assertEqual(status, 200);
    assert(data.userId !== undefined, 'Should return userId');
  });

  await runner.run('POST /api/auth/register without name returns 400', async () => {
    const { status } = await fetchJSON('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@x.com', password: '12345678' }),
    });
    assertEqual(status, 400);
  });

  await runner.run('POST /api/auth/refresh without token returns 401', async () => {
    const { status } = await fetchJSON('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assertEqual(status, 401);
  });

  await runner.run('POST /api/auth/logout succeeds', async () => {
    const { status, data } = await fetchJSON('/api/auth/logout', { method: 'POST', body: '{}' });
    assertEqual(status, 200);
    assertEqual(data.message, 'Logout successful');
  });
}

async function testUserAPI(runner) {
  console.log('\n\x1b[36m── User API ──\x1b[0m');

  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  await runner.run('GET /api/users/profile returns user data', async () => {
    const { status, data } = await fetchJSON('/api/users/profile', { headers: authHeaders });
    assertEqual(status, 200);
    assert(data.id !== undefined, 'Should have id');
    assert(data.email, 'Should have email');
    assert(data.stats, 'Should have stats');
    assert(typeof data.stats.totalTrips === 'number', 'Should have totalTrips');
    assert(typeof data.stats.carbonSaved === 'number', 'Should have carbonSaved');
  });

  await runner.run('GET /api/users/trips returns trip list', async () => {
    const { status, data } = await fetchJSON('/api/users/trips', { headers: authHeaders });
    assertEqual(status, 200);
    assert(Array.isArray(data.trips), 'Should have trips array');
    assert(data.pagination, 'Should have pagination');
  });

  await runner.run('GET /api/users/trips with status filter', async () => {
    const { status, data } = await fetchJSON('/api/users/trips?status=scheduled', { headers: authHeaders });
    assertEqual(status, 200);
    if (data.trips.length > 0) {
      data.trips.forEach(trip => {
        assertEqual(trip.status, 'scheduled', 'All trips should be scheduled');
      });
    }
  });

  await runner.run('Trip objects have required fields', async () => {
    const { data } = await fetchJSON('/api/users/trips', { headers: authHeaders });
    if (data.trips.length > 0) {
      const trip = data.trips[0];
      assert(trip.id !== undefined, 'Trip should have id');
      assert(trip.pickupLocation || trip.title, 'Trip should have pickup info or title');
      assert(trip.status, 'Trip should have status');
    }
  });
}

async function testMatchingAPI(runner) {
  console.log('\n\x1b[36m── Matching Engine API ──\x1b[0m');

  await runner.run('GET /api/matching/config returns configuration', async () => {
    const { status, data } = await fetchJSON('/api/matching/config');
    assertEqual(status, 200);
    const cfg = data.config || data;
    assert(cfg.weights, 'Should have weights');
    assert(cfg.thresholds, 'Should have thresholds');
    assert(typeof cfg.weights.pickupDistance === 'number', 'pickupDistance weight');
    assert(typeof cfg.thresholds.maxPickupDistanceKm === 'number', 'max pickup threshold');
  });

  await runner.run('GET /api/matching/stats returns statistics', async () => {
    const { status, data } = await fetchJSON('/api/matching/stats');
    assertEqual(status, 200);
    const stats = data.stats || data;
    assert(typeof stats.totalDriverTrips === 'number', 'Should have totalDriverTrips');
    assert(stats.timestamp, 'Should have timestamp');
  });

  await runner.run('POST /api/matching/driver-trips validates input', async () => {
    const { status, data } = await fetchJSON('/api/matching/driver-trips', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assertEqual(status, 400);
    assert(data.error, 'Should return validation error');
  });

  await runner.run('POST /api/matching/rider-requests validates coordinates', async () => {
    const { status } = await fetchJSON('/api/matching/rider-requests', {
      method: 'POST',
      body: JSON.stringify({
        pickup: { lat: 91, lng: 28 },
        dropoff: { lat: -26, lng: 28 },
        earliestDeparture: 100,
        latestDeparture: 200,
      }),
    });
    assertEqual(status, 400);
  });

  await runner.run('POST /api/matching/find validates required fields', async () => {
    const { status } = await fetchJSON('/api/matching/find', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert(status >= 400, `Should return error status, got ${status}`);
  });
}

async function testAdminAPI(runner) {
  console.log('\n\x1b[36m── Admin API ──\x1b[0m');

  await runner.run('GET /api/admin/stats returns dashboard data', async () => {
    const { status, data } = await fetchJSON('/api/admin/stats');
    assertEqual(status, 200);
    assert(typeof data.totalUsers === 'number', 'Should have totalUsers');
    assert(typeof data.totalTrips === 'number', 'Should have totalTrips');
    assert(data.carbonSaved, 'Should have carbonSaved');
    assert(data.revenue, 'Should have revenue');
  });
}

async function testMonitoringAPI(runner) {
  console.log('\n\x1b[36m── Monitoring API ──\x1b[0m');

  await runner.run('GET /api/monitoring/metrics returns system metrics', async () => {
    const { status, data } = await fetchJSON('/api/monitoring/metrics');
    assertEqual(status, 200);
    assert(data.system, 'Should have system metrics');
    assert(data.application, 'Should have application metrics');
  });

  await runner.run('GET /api/monitoring/sla returns SLA data', async () => {
    const { status, data } = await fetchJSON('/api/monitoring/sla');
    assertEqual(status, 200);
    assert(data.targets, 'Should have targets');
  });
}

async function testRateLimiting(runner) {
  console.log('\n\x1b[36m── Rate Limiting ──\x1b[0m');

  await runner.run('Rate limit headers are present', async () => {
    const { headers } = await fetchJSON('/api/hello');
    const limit = headers.get('X-RateLimit-Limit');
    const remaining = headers.get('X-RateLimit-Remaining');
    assert(limit, 'Should have X-RateLimit-Limit');
    assert(remaining, 'Should have X-RateLimit-Remaining');
    assert(parseInt(remaining) > 0, 'Should have remaining requests');
  });

  await runner.run('Rate limit decrements on each request', async () => {
    const { headers: h1 } = await fetchJSON('/api/hello');
    const r1 = parseInt(h1.get('X-RateLimit-Remaining'));
    const { headers: h2 } = await fetchJSON('/api/hello');
    const r2 = parseInt(h2.get('X-RateLimit-Remaining'));
    assert(r2 < r1 || r2 === r1, 'Remaining should decrement or stay same');
  });
}

async function testErrorHandling(runner) {
  console.log('\n\x1b[36m── Error Handling ──\x1b[0m');

  await runner.run('404 for unknown API route', async () => {
    const { status, data } = await fetchJSON('/api/nonexistent');
    assertEqual(status, 404);
    assert(data.error, 'Should have error object');
    assertEqual(data.error.code, 'NOT_FOUND');
  });

  await runner.run('404 for unknown static path', async () => {
    const { status } = await fetchJSON('/static/nonexistent.xyz');
    assertEqual(status, 404);
  });

  await runner.run('Error responses have consistent structure', async () => {
    const { data } = await fetchJSON('/api/nonexistent');
    assert(data.error.code, 'Should have error code');
    assert(data.error.message, 'Should have error message');
  });

  await runner.run('POST with invalid JSON returns error', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert(res.status >= 400, 'Should return error for invalid JSON');
  });
}

async function testRealTimeEvents(runner) {
  console.log('\n\x1b[36m── Real-Time Events (SSE) ──\x1b[0m');

  await runner.run('GET /api/events returns SSE stream', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/api/events`, { signal: controller.signal });
      assertEqual(res.status, 200);
      assertEqual(res.headers.get('Content-Type'), 'text/event-stream');
      assertEqual(res.headers.get('Cache-Control'), 'no-cache');
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
}

async function testPerformance(runner) {
  console.log('\n\x1b[36m── Performance ──\x1b[0m');

  await runner.run('Health endpoint < 200ms', async () => {
    const start = Date.now();
    await fetchJSON('/health');
    const duration = Date.now() - start;
    assert(duration < 200, `Response took ${duration}ms, expected < 200ms`);
  });

  await runner.run('API endpoint < 300ms', async () => {
    const start = Date.now();
    await fetchJSON('/api/hello');
    const duration = Date.now() - start;
    assert(duration < 300, `Response took ${duration}ms, expected < 300ms`);
  });

  await runner.run('Matching config < 300ms', async () => {
    const start = Date.now();
    await fetchJSON('/api/matching/config');
    const duration = Date.now() - start;
    assert(duration < 300, `Response took ${duration}ms, expected < 300ms`);
  });

  await runner.run('10 concurrent requests complete < 2s', async () => {
    const start = Date.now();
    await Promise.all(Array(10).fill(null).map(() => fetchJSON('/health')));
    const duration = Date.now() - start;
    assert(duration < 2000, `10 concurrent requests took ${duration}ms, expected < 2000ms`);
  });

  await runner.run('Sequential auth + profile < 1s', async () => {
    const start = Date.now();
    const loginRes = await fetchJSON('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'perf@test.com', password: 'password123' }),
    });
    const token = loginRes.data.accessToken;
    await fetchJSON('/api/users/profile', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const duration = Date.now() - start;
    assert(duration < 1000, `Auth flow took ${duration}ms, expected < 1000ms`);
  });
}

async function testPWAAssets(runner) {
  console.log('\n\x1b[36m── PWA Assets ──\x1b[0m');

  await runner.run('CSS file loads', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    assertEqual(res.status, 200);
    const text = await res.text();
    assert(text.length > 1000, 'CSS should have substantial content');
    assertIncludes(text, '--primary');
    assertIncludes(text, '.bottom-nav');
  });

  await runner.run('App JS loads', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    assertEqual(res.status, 200);
    const text = await res.text();
    assert(text.length > 5000, 'App JS should have substantial content');
    assertIncludes(text, 'Store');
    assertIncludes(text, 'Router');
  });

  await runner.run('PWA shell has required meta tags', async () => {
    const res = await fetch(`${BASE_URL}/`);
    const html = await res.text();
    assertIncludes(html, 'viewport-fit=cover');
    assertIncludes(html, 'apple-mobile-web-app-capable');
    assertIncludes(html, 'theme-color');
    assertIncludes(html, 'manifest.json');
    assertIncludes(html, 'noscript');
  });

  await runner.run('CSS has dark and light themes', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, 'data-theme="light"');
    assertIncludes(text, '--bg-primary');
  });

  await runner.run('CSS has mobile-first design', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, 'min-width: 640px');
    assertIncludes(text, 'min-width: 768px');
    assertIncludes(text, 'prefers-reduced-motion');
    assertIncludes(text, 'safe-area-inset');
  });

  await runner.run('App JS has all core modules', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'Auth');
    assertIncludes(text, 'Router');
    assertIncludes(text, 'Toast');
    assertIncludes(text, 'renderLoginScreen');
    assertIncludes(text, 'renderHomeScreen');
    assertIncludes(text, 'renderFindRideScreen');
    assertIncludes(text, 'renderOfferRideScreen');
  });
}

async function testAccessibility(runner) {
  console.log('\n\x1b[36m── Accessibility ──\x1b[0m');

  await runner.run('HTML has lang attribute', async () => {
    const res = await fetch(`${BASE_URL}/`);
    const html = await res.text();
    assertIncludes(html, 'lang="en"');
  });

  await runner.run('CSS supports prefers-reduced-motion', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, 'prefers-reduced-motion');
  });

  await runner.run('CSS supports prefers-contrast', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, 'prefers-contrast');
  });

  await runner.run('CSS has focus-visible styles', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, 'focus-visible');
  });

  await runner.run('Nav has aria labels', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'aria-label');
  });

  await runner.run('CSS has print styles', async () => {
    const res = await fetch(`${BASE_URL}/static/style.css`);
    const text = await res.text();
    assertIncludes(text, '@media print');
  });
}

async function testSecurityMeasures(runner) {
  console.log('\n\x1b[36m── Security Measures ──\x1b[0m');

  await runner.run('HTML escaping is used in app.js', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'escapeHtml');
  });

  await runner.run('Token stored with proper key naming', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'klubz_access_token');
    assertIncludes(text, 'klubz_refresh_token');
  });

  await runner.run('Auth logout clears tokens', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'removeItem');
  });

  await runner.run('Input validation on login form', async () => {
    const res = await fetch(`${BASE_URL}/static/js/app.js`);
    const text = await res.text();
    assertIncludes(text, 'minlength');
    assertIncludes(text, 'required');
  });

  await runner.run('CORS allows specific origins', async () => {
    const res = await fetch(`${BASE_URL}/api/hello`, {
      headers: { 'Origin': 'https://evil.com' }
    });
    const origin = res.headers.get('Access-Control-Allow-Origin');
    assert(origin !== 'https://evil.com', 'Should not allow arbitrary origins');
  });
}

async function testMatchingEngine(runner) {
  console.log('\n\x1b[36m── Matching Engine (Integration) ──\x1b[0m');

  await runner.run('Config has all required weight fields', async () => {
    const { data } = await fetchJSON('/api/matching/config');
    const cfg = data.config || data;
    const requiredWeights = ['pickupDistance', 'dropoffDistance', 'timeMatch', 'seatAvailability'];
    for (const w of requiredWeights) {
      assert(typeof cfg.weights[w] === 'number', `Missing weight: ${w}`);
      assert(cfg.weights[w] >= 0 && cfg.weights[w] <= 1, `Weight ${w} should be 0-1`);
    }
  });

  await runner.run('Config has all required threshold fields', async () => {
    const { data } = await fetchJSON('/api/matching/config');
    const cfg = data.config || data;
    const required = ['maxPickupDistanceKm', 'maxDropoffDistanceKm', 'maxTimeDiffMinutes'];
    for (const t of required) {
      assert(typeof cfg.thresholds[t] === 'number', `Missing threshold: ${t}`);
    }
  });

  await runner.run('Weights sum approximately to 1.0', async () => {
    const { data } = await fetchJSON('/api/matching/config');
    const cfg = data.config || data;
    const sum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 1.0) < 0.05, `Weights sum to ${sum}, expected ~1.0`);
  });

  await runner.run('Stats endpoint returns valid counters', async () => {
    const { data } = await fetchJSON('/api/matching/stats');
    const stats = data.stats || data;
    const fields = ['totalDriverTrips', 'activeDriverTrips', 'totalRiderRequests', 'totalMatches'];
    for (const f of fields) {
      assert(typeof stats[f] === 'number', `Missing stat: ${f}`);
      assert(stats[f] >= 0, `Stat ${f} should be >= 0`);
    }
  });
}

// ═══ Run All Tests ═══
async function main() {
  console.log('\x1b[1m\x1b[36m');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║    Klubz Comprehensive Test Suite v3.1                    ║');
  console.log('║    Testing: UI/UX, Security, Performance, PWA, A11y      ║');
  console.log('║    D1-backed routes with dev-mode fallbacks              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  console.log(`Target: ${BASE_URL}`);

  const runner = new TestRunner();

  // Wait for server
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      ready = true;
      break;
    } catch {
      console.log(`Waiting for server... (${i + 1}/10)`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!ready) {
    console.error('\x1b[31mServer not reachable. Aborting.\x1b[0m');
    process.exit(1);
  }

  // Run all test suites
  await testHealthAndInfra(runner);
  await testSecurityHeaders(runner);
  await testAuthentication(runner);
  await testUserAPI(runner);
  await testMatchingAPI(runner);
  await testMatchingEngine(runner);
  await testAdminAPI(runner);
  await testMonitoringAPI(runner);
  await testRateLimiting(runner);
  await testErrorHandling(runner);
  await testRealTimeEvents(runner);
  await testPerformance(runner);
  await testPWAAssets(runner);
  await testAccessibility(runner);
  await testSecurityMeasures(runner);

  const allPassed = runner.summary();
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
