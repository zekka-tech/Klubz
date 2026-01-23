// Basic API tests for Klubz platform

const API_BASE_URL = 'http://localhost:3000/api';

// Simple test runner
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('🧪 Running Klubz API Tests...\n');
    
    for (const test of this.tests) {
      try {
        await test.fn();
        console.log(`✅ ${test.name}`);
        this.passed++;
      } catch (error) {
        console.log(`❌ ${test.name}: ${error.message}`);
        this.failed++;
      }
    }

    console.log(`\n📊 Test Results:`);
    console.log(`✅ Passed: ${this.passed}`);
    console.log(`❌ Failed: ${this.failed}`);
    console.log(`📈 Total: ${this.tests.length}`);
    
    return this.failed === 0;
  }
}

// Test utilities
const assert = {
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
  },
  
  ok(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
  }
};

// Simple fetch wrapper
const api = {
  async get(endpoint) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`);
    return response.json();
  },
  
  async post(endpoint, data) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    return response.json();
  }
};

// Test runner instance
const runner = new TestRunner();

// Health check tests
runner.test('Health endpoint should return healthy status', async () => {
  const result = await api.get('/hello');
  assert.equal(result.message, 'Hello from Klubz API!');
});

// Authentication tests
runner.test('Login endpoint should accept valid credentials', async () => {
  const loginData = {
    email: 'test@klubz.com',
    password: 'TestPassword123!',
    rememberMe: false
  };
  
  const result = await api.post('/auth/login', loginData);
  assert.ok(result.accessToken, 'Should return access token');
  assert.ok(result.refreshToken, 'Should return refresh token');
  assert.ok(result.user, 'Should return user information');
});

runner.test('Registration endpoint should create new user', async () => {
  const registerData = {
    email: 'newuser@klubz.com',
    password: 'NewPassword123!',
    name: 'New User',
    role: 'passenger'
  };
  
  const result = await api.post('/auth/register', registerData);
  assert.ok(result.userId, 'Should return user ID');
  assert.equal(result.message, 'Registration successful');
});

// User management tests
runner.test('User profile endpoint should return user data', async () => {
  // This would normally require authentication
  const result = await api.get('/users/profile');
  assert.ok(result.id, 'Should have user ID');
  assert.ok(result.email, 'Should have email');
  assert.ok(result.name, 'Should have name');
});

// Trip management tests
runner.test('Available trips endpoint should return trip list', async () => {
  const params = new URLSearchParams({
    pickupLat: '-26.2041',
    pickupLng: '28.0473',
    dropoffLat: '-26.1076',
    dropoffLng: '28.0567',
    radius: '5'
  });
  
  const result = await api.get(`/trips/available?${params}`);
  assert.ok(Array.isArray(result.trips), 'Should return trips array');
  assert.ok(result.searchCriteria, 'Should include search criteria');
});

// Admin tests
runner.test('Admin stats endpoint should return statistics', async () => {
  const result = await api.get('/admin/stats');
  assert.ok(result.totalUsers, 'Should have total users');
  assert.ok(result.totalTrips, 'Should have total trips');
  assert.ok(result.revenue, 'Should have revenue data');
});

// Monitoring tests
runner.test('Metrics endpoint should return system metrics', async () => {
  const result = await api.get('/monitoring/metrics');
  assert.ok(result.system, 'Should have system metrics');
  assert.ok(result.application, 'Should have application metrics');
});

runner.test('SLA endpoint should return SLA compliance data', async () => {
  const result = await api.get('/monitoring/sla');
  assert.ok(result.availability, 'Should have availability data');
  assert.ok(result.responseTime, 'Should have response time data');
});

// Security tests
runner.test('Rate limiting should prevent excessive requests', async () => {
  const promises = [];
  
  // Make multiple rapid requests to trigger rate limiting
  for (let i = 0; i < 10; i++) {
    promises.push(api.get('/hello'));
  }
  
  const results = await Promise.allSettled(promises);
  const rateLimitedResults = results.filter(r => r.status === 'rejected');
  
  // At least some requests should be rate limited
  assert.ok(rateLimitedResults.length > 0, 'Should have rate limited requests');
});

// Error handling tests
runner.test('Invalid endpoint should return 404 error', async () => {
  try {
    await api.get('/nonexistent-endpoint');
    throw new Error('Should have thrown an error');
  } catch (error) {
    assert.ok(error.message.includes('404'), 'Should return 404 error');
  }
});

// Performance tests
runner.test('API response time should be under 500ms', async () => {
  const start = Date.now();
  await api.get('/hello');
  const responseTime = Date.now() - start;
  
  assert.ok(responseTime < 500, `Response time ${responseTime}ms should be under 500ms`);
});

// Run tests
if (require.main === module) {
  runner.run().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { runner, api, assert };