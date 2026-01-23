import crypto from 'crypto'

export interface EncryptedData {
  encrypted: string
  iv: string
  tag: string
}

export interface EncryptionConfig {
  algorithm: string
  keyLength: number
  ivLength: number
  tagLength: number
}

const DEFAULT_CONFIG: EncryptionConfig = {
  algorithm: 'aes-256-gcm',
  keyLength: 32, // 256 bits
  ivLength: 16,  // 128 bits
  tagLength: 16   // 128 bits
}

/**
 * Encrypt sensitive data using AES-256-GCM
 * @param data - Data to encrypt
 * @param key - Encryption key (must be 32 bytes for AES-256)
 * @param config - Optional encryption configuration
 * @returns Encrypted data with IV and authentication tag
 */
export function encryptData(
  data: string | object,
  key: string | Buffer,
  config: Partial<EncryptionConfig> = {}
): EncryptedData {
  const finalConfig = { ...DEFAULT_CONFIG, ...config }
  
  // Ensure key is proper length
  let keyBuffer: Buffer
  if (typeof key === 'string') {
    keyBuffer = Buffer.from(key, 'hex')
    if (keyBuffer.length !== finalConfig.keyLength) {
      throw new Error(`Key must be ${finalConfig.keyLength} bytes for AES-256-GCM`)
    }
  } else {
    keyBuffer = key
  }
  
  // Generate random IV
  const iv = crypto.randomBytes(finalConfig.ivLength)
  
  // Create cipher
  const cipher = crypto.createCipher(finalConfig.algorithm, keyBuffer)
  cipher.setAAD(Buffer.from('klubz-aad')) // Additional authenticated data
  
  // Encrypt data
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
  let encrypted = cipher.update(dataStr, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  // Get authentication tag
  const tag = cipher.getAuthTag()
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex')
  }
}

/**
 * Decrypt data encrypted with AES-256-GCM
 * @param encryptedData - Encrypted data with IV and tag
 * @param key - Decryption key (must be 32 bytes for AES-256)
 * @param config - Optional encryption configuration
 * @returns Decrypted data
 */
export function decryptData(
  encryptedData: EncryptedData,
  key: string | Buffer,
  config: Partial<EncryptionConfig> = {}
): string {
  const finalConfig = { ...DEFAULT_CONFIG, ...config }
  
  // Ensure key is proper length
  let keyBuffer: Buffer
  if (typeof key === 'string') {
    keyBuffer = Buffer.from(key, 'hex')
    if (keyBuffer.length !== finalConfig.keyLength) {
      throw new Error(`Key must be ${finalConfig.keyLength} bytes for AES-256-GCM`)
    }
  } else {
    keyBuffer = key
  }
  
  // Create decipher
  const decipher = crypto.createDecipher(finalConfig.algorithm, keyBuffer)
  decipher.setAAD(Buffer.from('klubz-aad'))
  decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'))
  
  // Decrypt data
  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

/**
 * Encrypt PII (Personally Identifiable Information) with additional security measures
 * @param data - PII data to encrypt
 * @param key - Encryption key
 * @param userId - User ID for audit logging
 * @returns Encrypted PII data
 */
export function encryptPII(
  data: string,
  key: string,
  userId: string
): EncryptedData {
  // Add timestamp and user context to prevent replay attacks
  const dataWithContext = {
    data,
    userId,
    timestamp: Date.now(),
    purpose: 'pii_encryption'
  }
  
  return encryptData(dataWithContext, key)
}

/**
 * Decrypt PII with validation and audit logging
 * @param encryptedData - Encrypted PII data
 * @param key - Decryption key
 * @param userId - User ID for audit logging
 * @returns Decrypted PII data
 */
export function decryptPII(
  encryptedData: EncryptedData,
  key: string,
  userId: string
): string {
  try {
    const decrypted = decryptData(encryptedData, key)
    const parsed = JSON.parse(decrypted)
    
    // Validate the decrypted data
    if (!parsed.data || parsed.purpose !== 'pii_encryption') {
      throw new Error('Invalid PII data structure')
    }
    
    // Check for replay attacks (data should be less than 1 hour old)
    const maxAge = 60 * 60 * 1000 // 1 hour
    if (Date.now() - parsed.timestamp > maxAge) {
      throw new Error('PII data has expired')
    }
    
    // In a real implementation, log PII access for audit purposes
    console.log(`PII access logged for user ${userId} at ${new Date().toISOString()}`)
    
    return parsed.data
  } catch (error) {
    throw new Error('Failed to decrypt PII data: ' + (error as Error).message)
  }
}

/**
 * Generate a secure random key for encryption
 * @param length - Key length in bytes (default: 32 for AES-256)
 * @returns Hex-encoded key
 */
export function generateEncryptionKey(length = 32): string {
  return crypto.randomBytes(length).toString('hex')
}

/**
 * Hash data using SHA-256 (for non-reversible operations)
 * @param data - Data to hash
 * @param salt - Optional salt
 * @returns Hex-encoded hash
 */
export function hashData(data: string, salt?: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(data)
  if (salt) {
    hash.update(salt)
  }
  return hash.digest('hex')
}

/**
 * Hash PII for lookup purposes (with organization-specific salt)
 * @param data - PII data to hash
 * @param organizationId - Organization ID for salt generation
 * @returns Hashed data
 */
export function hashPII(data: string, organizationId: string): string {
  const salt = hashData(organizationId + 'klubz-pii-salt')
  return hashData(data, salt)
}

/**
 * Mask sensitive data for logging purposes
 * @param data - Sensitive data to mask
 * @param visibleChars - Number of characters to keep visible at the end
 * @param maskChar - Character to use for masking
 * @returns Masked data
 */
export function maskData(data: string, visibleChars = 4, maskChar = '*'): string {
  if (data.length <= visibleChars) {
    return maskChar.repeat(data.length)
  }
  
  const maskedLength = data.length - visibleChars
  return maskChar.repeat(maskedLength) + data.slice(-visibleChars)
}

/**
 * Validate encryption key format
 * @param key - Key to validate
 * @returns Whether the key is valid
 */
export function isValidEncryptionKey(key: string): boolean {
  try {
    const keyBuffer = Buffer.from(key, 'hex')
    return keyBuffer.length === 32
  } catch {
    return false
  }
}

/**
 * Rotate encryption key (for key rotation policies)
 * @param oldKey - Current encryption key
 * @returns New encryption key
 */
export function rotateEncryptionKey(oldKey?: string): string {
  // Generate new key
  const newKey = generateEncryptionKey()
  
  // In a real implementation, you would:
  // 1. Re-encrypt all data with the new key
  // 2. Update key management system
  // 3. Archive the old key securely
  
  return newKey
}