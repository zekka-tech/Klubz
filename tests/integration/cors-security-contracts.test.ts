import { describe, expect, test } from 'vitest';
import app from '../../src/index';

describe('CORS and security header contracts', () => {
  test('allowed origin on non-preflight request receives CORS headers', async () => {
    const origin = 'https://klubz-production.pages.dev';
    const res = await app.request('/health', {
      method: 'GET',
      headers: { Origin: origin },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Vary')).toContain('Origin');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID');
  });

  test('disallowed origin on non-preflight request does not receive CORS allow-origin header', async () => {
    const res = await app.request('/health', {
      method: 'GET',
      headers: { Origin: 'https://evil.example' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('allowed origin preflight receives CORS headers', async () => {
    const origin = 'https://klubz-staging.pages.dev';
    const res = await app.request('/api/hello', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  test('disallowed origin preflight is rejected with 403', async () => {
    const res = await app.request('/api/hello', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://not-allowed.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('AUTHORIZATION_ERROR');
    expect(body.error?.message).toBe('CORS origin not allowed');
  });

  test('preflight without origin still returns base CORS capability headers', async () => {
    const res = await app.request('/api/hello', { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
