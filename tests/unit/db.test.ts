import { describe, test, expect } from 'vitest';
import { getDB, getDBOptional } from '../../src/lib/db';

describe('Database Utilities', () => {
  describe('getDB', () => {
    test('returns DB when available', () => {
      const mockDB = { prepare: () => {} };
      const mockContext = {
        env: { DB: mockDB }
      } as any;

      expect(getDB(mockContext)).toBe(mockDB);
    });

    test('throws error when DB not available', () => {
      const mockContext = {
        env: {}
      } as any;

      expect(() => getDB(mockContext)).toThrow('Database not configured');
    });

    test('throws error when env is undefined', () => {
      const mockContext = {} as any;

      expect(() => getDB(mockContext)).toThrow('Database not configured');
    });
  });

  describe('getDBOptional', () => {
    test('returns DB when available', () => {
      const mockDB = { prepare: () => {} };
      const mockContext = {
        env: { DB: mockDB }
      } as any;

      expect(getDBOptional(mockContext)).toBe(mockDB);
    });

    test('returns null when DB not available', () => {
      const mockContext = {
        env: {}
      } as any;

      expect(getDBOptional(mockContext)).toBeNull();
    });

    test('returns null when env is undefined', () => {
      const mockContext = {} as any;

      expect(getDBOptional(mockContext)).toBeNull();
    });
  });
});
