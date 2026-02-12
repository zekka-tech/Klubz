import { describe, test, expect } from 'vitest';
import { hashPassword, verifyPassword, hashForLookup } from '../../src/lib/encryption';

describe('Encryption Library', () => {
  describe('hashPassword', () => {
    test('creates bcrypt hash', async () => {
      const hash = await hashPassword('testpassword123');
      expect(hash).toMatch(/^\$2[aby]\$/);
      expect(hash.length).toBeGreaterThan(50);
    });

    test('creates different hashes for same password', async () => {
      const hash1 = await hashPassword('testpassword123');
      const hash2 = await hashPassword('testpassword123');
      expect(hash1).not.toBe(hash2); // Different salts
    });
  });

  describe('verifyPassword', () => {
    test('validates correct password', async () => {
      const hash = await hashPassword('testpassword123');
      const valid = await verifyPassword('testpassword123', hash);
      expect(valid).toBe(true);
    });

    test('rejects wrong password', async () => {
      const hash = await hashPassword('testpassword123');
      const valid = await verifyPassword('wrongpassword', hash);
      expect(valid).toBe(false);
    });

    test('rejects empty password', async () => {
      const hash = await hashPassword('testpassword123');
      const valid = await verifyPassword('', hash);
      expect(valid).toBe(false);
    });
  });

  describe('hashForLookup', () => {
    test('creates consistent SHA-256 hash', async () => {
      const hash1 = await hashForLookup('test@example.com');
      const hash2 = await hashForLookup('test@example.com');
      expect(hash1).toBe(hash2); // Deterministic
    });

    test('creates different hashes for different inputs', async () => {
      const hash1 = await hashForLookup('test1@example.com');
      const hash2 = await hashForLookup('test2@example.com');
      expect(hash1).not.toBe(hash2);
    });

    test('produces hex string', async () => {
      const hash = await hashForLookup('test@example.com');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });
});
