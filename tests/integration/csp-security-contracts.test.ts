import { describe, expect, test } from 'vitest';
import app from '../../src/index';

describe('CSP security contracts', () => {
  test('default CSP includes hardened baseline directives', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain('connect-src');
  });

  test('production CSP includes upgrade-insecure-requests and app/ws connect origins', async () => {
    const res = await app.request(
      '/health',
      { method: 'GET' },
      {
        ENVIRONMENT: 'production',
        APP_URL: 'https://klubz-production.pages.dev',
        JWT_SECRET: 'integration-secret-0123456789abcdef',
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
    );

    expect(res.status).toBe(200);
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain('https://klubz-production.pages.dev');
    expect(csp).toContain('wss://klubz-production.pages.dev');
  });
});
