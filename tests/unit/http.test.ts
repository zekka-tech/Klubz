import { describe, test, expect, vi } from 'vitest';
import { getIP, getUserAgent, parseJSONBody } from '../../src/lib/http';

describe('HTTP Utilities', () => {
  describe('getIP', () => {
    test('extracts CF-Connecting-IP', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'CF-Connecting-IP') return '192.168.1.100';
            return undefined;
          }
        }
      } as any;

      expect(getIP(mockContext)).toBe('192.168.1.100');
    });

    test('falls back to X-Forwarded-For', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'X-Forwarded-For') return '192.168.1.101, 10.0.0.1';
            return undefined;
          }
        }
      } as any;

      expect(getIP(mockContext)).toBe('192.168.1.101');
    });

    test('supports lowercase x-forwarded-for header name', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'x-forwarded-for') return '203.0.113.10, 10.0.0.1';
            return undefined;
          }
        }
      } as any;

      expect(getIP(mockContext)).toBe('203.0.113.10');
    });

    test('normalizes IPv4 values that include a port', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'X-Forwarded-For') return '198.51.100.21:8443';
            return undefined;
          }
        }
      } as any;

      expect(getIP(mockContext)).toBe('198.51.100.21');
    });

    test('returns unknown for oversized spoofable header values', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'X-Forwarded-For') return '1'.repeat(120);
            return undefined;
          }
        }
      } as any;

      expect(getIP(mockContext)).toBe('unknown');
    });

    test('returns unknown if no IP headers', () => {
      const mockContext = {
        req: {
          header: () => undefined
        }
      } as any;

      expect(getIP(mockContext)).toBe('unknown');
    });
  });

  describe('getUserAgent', () => {
    test('extracts user agent', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'User-Agent') return 'Mozilla/5.0 Test Browser';
            return undefined;
          }
        }
      } as any;

      expect(getUserAgent(mockContext)).toBe('Mozilla/5.0 Test Browser');
    });

    test('truncates to 255 characters', () => {
      const longUA = 'A'.repeat(300);
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'User-Agent') return longUA;
            return undefined;
          }
        }
      } as any;

      const result = getUserAgent(mockContext);
      expect(result.length).toBe(255);
      expect(result).toBe('A'.repeat(255));
    });

    test('returns unknown if no user agent', () => {
      const mockContext = {
        req: {
          header: () => undefined
        }
      } as any;

      expect(getUserAgent(mockContext)).toBe('unknown');
    });

    test('extracts lowercase user-agent header', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'user-agent') return 'curl/8.5.0';
            return undefined;
          }
        }
      } as any;

      expect(getUserAgent(mockContext)).toBe('curl/8.5.0');
    });
  });

  describe('parseJSONBody', () => {
    test('parses valid JSON', async () => {
      const mockContext = {
        req: {
          json: async () => ({ name: 'John', age: 30 })
        }
      } as any;

      const result = await parseJSONBody(mockContext);
      expect(result).toEqual({ name: 'John', age: 30 });
    });

    test('returns null for invalid JSON', async () => {
      const mockContext = {
        req: {
          json: async () => {
            throw new Error('Invalid JSON');
          }
        }
      } as any;

      const result = await parseJSONBody(mockContext);
      expect(result).toBeNull();
    });
  });
});
