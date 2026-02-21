/**
 * Klubz - Web Crypto API Encryption + bcryptjs Password Hashing
 *
 * Production-grade encryption for Cloudflare Workers.
 * Uses Web Crypto API (crypto.subtle) — no deprecated Node.js crypto APIs.
 *
 * AES-256-GCM for PII encryption with proper IV and AAD.
 * bcryptjs for password hashing (pure JS, Workers-compatible, industry standard).
 */

import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedData {
  /** Base64-encoded ciphertext */
  ct: string;
  /** Base64-encoded initialization vector (12 bytes) */
  iv: string;
  /** Algorithm version for future key rotation */
  v: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for AES-GCM
const ENCRYPTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/**
 * Import a hex-encoded key string into a CryptoKey for AES-GCM.
 */
async function importKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  if (keyBytes.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes (got ${keyBytes.length})`);
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// AES-256-GCM Encryption / Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt data using AES-256-GCM with random IV.
 *
 * @param data - String data to encrypt
 * @param hexKey - 64-char hex-encoded 256-bit key
 * @param aad - Optional additional authenticated data (e.g. userId)
 */
export async function encrypt(
  data: string,
  hexKey: string,
  aad?: string,
): Promise<EncryptedData> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(data);

  const params: AesGcmParams = { name: ALGORITHM, iv: iv as unknown as BufferSource };
  if (aad) {
    params.additionalData = new TextEncoder().encode(aad);
  }

  const ciphertext = await crypto.subtle.encrypt(params, key, encoded);

  return {
    ct: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    v: ENCRYPTION_VERSION,
  };
}

/**
 * Decrypt data encrypted with AES-256-GCM.
 *
 * @param encrypted - Encrypted payload
 * @param hexKey - 64-char hex-encoded 256-bit key
 * @param aad - Optional AAD (must match what was used during encryption)
 */
export async function decrypt(
  encrypted: EncryptedData,
  hexKey: string,
  aad?: string,
): Promise<string> {
  const key = await importKey(hexKey);
  const iv = base64ToBytes(encrypted.iv);
  const ciphertext = base64ToBytes(encrypted.ct);

  const params: AesGcmParams = { name: ALGORITHM, iv: iv as unknown as BufferSource };
  if (aad) {
    params.additionalData = new TextEncoder().encode(aad);
  }

  const plaintext = await crypto.subtle.decrypt(params, key, ciphertext as unknown as BufferSource);
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a JSON-serializable object.
 */
export async function encryptJSON(
  data: unknown,
  hexKey: string,
  aad?: string,
): Promise<string> {
  const encrypted = await encrypt(JSON.stringify(data), hexKey, aad);
  return JSON.stringify(encrypted);
}

/**
 * Decrypt a JSON string that was encrypted with encryptJSON.
 */
export async function decryptJSON<T = unknown>(
  encryptedStr: string,
  hexKey: string,
  aad?: string,
): Promise<T> {
  const encrypted: EncryptedData = JSON.parse(encryptedStr);
  const decrypted = await decrypt(encrypted, hexKey, aad);
  return JSON.parse(decrypted) as T;
}

// ---------------------------------------------------------------------------
// Password Hashing (bcryptjs — industry standard, Workers-compatible)
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12; // Good balance of security vs. performance

/**
 * Hash a password using bcrypt with auto-generated salt.
 * Returns a standard bcrypt hash string: `$2a$12$...`
 *
 * bcryptjs is pure JS with no native dependencies, fully Workers-compatible.
 * Cost factor 12 provides ~250ms hash time, resistant to brute-force.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a stored hash.
 * Supports both bcrypt hashes ($2a$/$2b$) and legacy PBKDF2 ($pbkdf2$) formats.
 * Legacy PBKDF2 hashes are verified but should be re-hashed on next login.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  // Handle legacy PBKDF2 hashes from previous implementation
  if (stored.startsWith('$pbkdf2$')) {
    return verifyPasswordPBKDF2(password, stored);
  }

  // Standard bcrypt verification
  return bcrypt.compareSync(password, stored);
}

/**
 * Legacy PBKDF2 password verification for migration compatibility.
 * Passwords verified with this should be re-hashed with bcrypt on next login.
 */
async function verifyPasswordPBKDF2(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  // Format: $pbkdf2$iterations$salt$hash
  if (parts.length !== 5 || parts[1] !== 'pbkdf2') {
    return false;
  }

  const iterations = parseInt(parts[2], 10);
  const salt = base64ToBytes(parts[3]);
  const storedHash = base64ToBytes(parts[4]);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const computedHash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  return timingSafeEqual(new Uint8Array(computedHash), storedHash);
}

/**
 * Check whether a stored hash is in the legacy PBKDF2 format.
 * Used to trigger re-hashing on successful login.
 */
export function isLegacyHash(stored: string): boolean {
  return stored.startsWith('$pbkdf2$');
}

// ---------------------------------------------------------------------------
// SHA-256 Hashing (for non-reversible lookups)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of a string, returned as hex.
 */
export async function sha256(data: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Hash PII for database lookup columns (e.g. email_hash).
 * Uses an application-specific salt prefix.
 */
export async function hashForLookup(
  data: string,
  salt: string = 'klubz-lookup-salt',
): Promise<string> {
  return sha256(salt + ':' + data.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// PII Helpers
// ---------------------------------------------------------------------------

/**
 * Encrypt PII with user-scoped AAD.
 */
export async function encryptPII(
  data: string,
  encryptionKey: string,
  userId: number | string,
): Promise<string> {
  const encrypted = await encrypt(data, encryptionKey, `user:${userId}`);
  return JSON.stringify(encrypted);
}

/**
 * Safely decrypt PII, falling back to the raw value for legacy plaintext data
 * or when the encryption key is unavailable.
 *
 * This is the preferred read helper for `*_encrypted` columns:
 * - New data (properly encrypted JSON) is decrypted normally.
 * - Legacy plaintext data (stored before encryption was enforced) is returned as-is.
 * - If the encryption key is not configured the raw string is returned unchanged.
 */
export async function safeDecryptPII(
  encryptedStr: string | null | undefined,
  encryptionKey: string | undefined,
  userId: number | string,
): Promise<string | null> {
  if (!encryptedStr) return null;
  if (!encryptionKey) return encryptedStr;
  try {
    const parsed: EncryptedData = JSON.parse(encryptedStr);
    if (parsed.ct && parsed.iv && typeof parsed.v === 'number') {
      return await decrypt(parsed, encryptionKey, `user:${userId}`);
    }
  } catch {
    // Not encrypted JSON — legacy plaintext value, return as-is
  }
  return encryptedStr;
}

/**
 * Decrypt PII with user-scoped AAD.
 */
export async function decryptPII(
  encryptedStr: string,
  encryptionKey: string,
  userId: number | string,
): Promise<string> {
  const encrypted: EncryptedData = JSON.parse(encryptedStr);
  return decrypt(encrypted, encryptionKey, `user:${userId}`);
}

/**
 * Mask sensitive data for display/logging.
 */
export function maskData(data: string, visibleEnd: number = 4): string {
  if (data.length <= visibleEnd) return '*'.repeat(data.length);
  return '*'.repeat(data.length - visibleEnd) + data.slice(-visibleEnd);
}

/**
 * Mask an email address for display.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return maskData(email);
  const maskedLocal = local.length <= 2
    ? '*'.repeat(local.length)
    : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
  return `${maskedLocal}@${domain}`;
}

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------

/**
 * Generate a random 256-bit encryption key as a hex string.
 */
export function generateEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

/**
 * Generate a random JWT secret (64 bytes / 512 bits).
 */
export function generateJWTSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return bytesToHex(bytes);
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
