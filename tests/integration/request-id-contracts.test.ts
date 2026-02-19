import { describe, expect, test, vi } from 'vitest';
import app from '../../src/index';

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
});
