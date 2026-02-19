import { describe, expect, test, vi } from 'vitest';
import app from '../../src/index';

class MockStmt {
  bind(..._values: unknown[]) {
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return null;
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    return { success: true, meta: {} };
  }
}

class MockDB {
  prepare(_query: string) {
    return new MockStmt();
  }
}

class MockKV {
  async get(_key: string, _type?: 'text' | 'json') {
    return null;
  }

  async put(_key: string, _value: string) {
    return;
  }
}

describe('request-id observability contracts', () => {
  test('echoes a valid client request id and uses it in error payloads', async () => {
    const requestId = 'client-request-12345';
    const res = await app.request('/api/notifications', {
      headers: { 'X-Request-ID': requestId },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('X-Request-ID')).toBe(requestId);

    const body = (await res.json()) as { error?: { requestId?: string } };
    expect(body.error?.requestId).toBe(requestId);
  });

  test('replaces invalid client request id with a server-generated id', async () => {
    const invalidRequestId = 'a'.repeat(300);
    const res = await app.request('/health', {
      headers: { 'X-Request-ID': invalidRequestId },
    });

    expect(res.status).toBe(200);
    const responseRequestId = res.headers.get('X-Request-ID');
    expect(responseRequestId).toBeTruthy();
    expect(responseRequestId).not.toBe(invalidRequestId);
    expect(responseRequestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  test('request and response logs share the same request id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const requestId = 'corr-id-987654';
      const res = await app.request('/health', {
        headers: { 'X-Request-ID': requestId },
      });

      expect(res.status).toBe(200);

      const lines = logSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; requestId?: string };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { type?: string; requestId?: string } => !!entry);

      const requestLog = lines.find((entry) => entry.type === 'request');
      const responseLog = lines.find((entry) => entry.type === 'response');
      expect(requestLog?.requestId).toBe(requestId);
      expect(responseLog?.requestId).toBe(requestId);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('request log uses normalized anonymized client IP from forwarded chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await app.request('/health', {
        headers: { 'x-forwarded-for': '203.0.113.77, 10.10.0.2' },
      });
      expect(res.status).toBe(200);

      const requestLog = logSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; ip?: string };
          } catch {
            return null;
          }
        })
        .find((entry) => entry && entry.type === 'request');

      expect(requestLog?.ip).toBe('203.0.113.0');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('auth module error logs include propagated request id', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const requestId = 'auth-corr-0001';
    try {
      const res = await app.request(
        '/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
          },
          body: JSON.stringify({
            email: 'corr@example.com',
            password: 'StrongPass123!',
          }),
        },
        {
          JWT_SECRET: 'integration-secret-0123456789abcdef',
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
          CACHE: new MockKV(),
          SESSIONS: new MockKV(),
          RATE_LIMIT_KV: new MockKV(),
        } as any,
      );

      expect(res.status).toBe(500);

      const parsedErrorLogs = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .map((line) => {
          try {
            return JSON.parse(line) as { message?: string; requestId?: string };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { message?: string; requestId?: string } => !!entry);

      const authLog = parsedErrorLogs.find((entry) => entry.message === 'Login denied because DB is unavailable');
      expect(authLog?.requestId).toBe(requestId);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('payment module warning logs include propagated request id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requestId = 'payments-corr-0001';
    try {
      const res = await app.request(
        '/api/payments/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': 'sig-placeholder',
            'X-Request-ID': requestId,
          },
          body: JSON.stringify({
            id: 'evt_corr_missing_metadata',
            type: 'payment_intent.succeeded',
            data: {
              object: {
                id: 'pi_corr_missing_metadata',
                amount: 2500,
                metadata: {},
              },
            },
          }),
        },
        {
          JWT_SECRET: 'integration-secret-0123456789abcdef',
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
          CACHE: new MockKV(),
          DB: new MockDB(),
          SESSIONS: new MockKV(),
          RATE_LIMIT_KV: new MockKV(),
        } as any,
      );

      expect(res.status).toBe(200);

      const parsedWarnLogs = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .map((line) => {
          try {
            return JSON.parse(line) as { message?: string; requestId?: string };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { message?: string; requestId?: string } => !!entry);

      const paymentsLog = parsedWarnLogs.find((entry) => entry.message === 'Ignoring Stripe success event with missing metadata');
      expect(paymentsLog?.requestId).toBe(requestId);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
