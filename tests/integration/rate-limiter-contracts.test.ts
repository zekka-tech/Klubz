import { describe, expect, test } from 'vitest';
import app from '../../src/index';

describe('API rate limiter contracts', () => {
  test('API responses expose rate limit headers', async () => {
    const res = await app.request('/api/hello', {
      headers: { 'x-forwarded-for': '203.0.113.201' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  test('exceeding API rate limit returns 429 with retry contract', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.202' };
    let final: Response | null = null;

    for (let i = 0; i < 121; i++) {
      final = await app.request('/api/hello', { headers });
    }

    expect(final).toBeTruthy();
    expect(final?.status).toBe(429);
    expect(final?.headers.get('Retry-After')).toBeTruthy();

    const body = (await final?.json()) as {
      error?: { code?: string; retryAfter?: number; message?: string };
    };
    expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof body.error?.retryAfter).toBe('number');
    expect((body.error?.retryAfter || 0) > 0).toBe(true);
  });
});
