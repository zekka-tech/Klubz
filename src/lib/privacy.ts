/**
 * Klubz - Privacy Utilities
 *
 * GDPR/POPIA compliant data anonymization and masking functions.
 */

/**
 * Anonymize IP address for GDPR/POPIA compliance
 *
 * IPv4: Zeros the last octet (192.168.1.123 → 192.168.1.0)
 * IPv6: Keeps first 64 bits (first 4 groups), zeros the rest
 *
 * This maintains geolocation accuracy at city/region level while
 * preventing individual identification.
 */
export function anonymizeIP(ip: string): string {
  if (!ip || ip === 'unknown') {
    return 'unknown';
  }

  // IPv6 detection (contains colons)
  if (ip.includes(':')) {
    // Keep first 4 groups (64 bits), zero the rest
    const parts = ip.split(':').slice(0, 4);
    return parts.join(':') + '::0';
  }

  // IPv4
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return ip; // Invalid IP, return as-is
  }

  // Zero the last octet
  return parts.slice(0, 3).join('.') + '.0';
}

/**
 * Mask email address for display
 *
 * Examples:
 * - john@example.com → jo***@example.com
 * - a@test.com → a***@test.com
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) {
    return email;
  }

  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }

  return `${local[0]}${local[1]}${'*'.repeat(local.length - 2)}@${domain}`;
}

/**
 * Mask phone number for display
 *
 * Shows only last 4 digits:
 * - +27821234567 → *******4567
 * - 0821234567 → ******4567
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) {
    return '****';
  }

  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

/**
 * Mask credit card number for display
 *
 * Shows only last 4 digits:
 * - 4532123456789012 → ************9012
 */
export function maskCardNumber(cardNumber: string): string {
  if (cardNumber.length <= 4) {
    return '****';
  }

  return '*'.repeat(cardNumber.length - 4) + cardNumber.slice(-4);
}

/**
 * Redact sensitive data from log messages
 *
 * Replaces common sensitive patterns with [REDACTED]
 */
export function redactSensitiveData(message: string): string {
  let redacted = message;

  // Redact potential passwords (password=, pass=, pwd=)
  redacted = redacted.replace(/\b(password|pass|pwd)\s*[:=]\s*["']?[\w@#$%^&*()]+["']?/gi, '$1=[REDACTED]');

  // Redact potential API keys (various formats)
  redacted = redacted.replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[REDACTED_KEY]');

  // Redact email addresses in logs
  redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

  // Redact phone numbers
  redacted = redacted.replace(/\+?\d{10,15}/g, '[PHONE]');

  return redacted;
}

/**
 * Generate anonymized user identifier for analytics
 *
 * Creates a stable but non-reversible identifier from user ID
 */
export function anonymizeUserId(userId: number | string): string {
  // Simple hash-like transformation (not cryptographic)
  const str = String(userId);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `anon_${Math.abs(hash).toString(36)}`;
}

/**
 * Check if data retention period has expired
 *
 * Used for GDPR/POPIA data deletion compliance
 */
export function isRetentionExpired(
  deletedAt: string | Date,
  retentionDays = 30
): boolean {
  const deletedDate = new Date(deletedAt);
  const expiryDate = new Date(deletedDate.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  return new Date() >= expiryDate;
}

/**
 * Calculate permanent deletion date
 */
export function getPermanentDeletionDate(
  deletedAt: string | Date = new Date(),
  retentionDays = 30
): Date {
  const deletedDate = new Date(deletedAt);
  return new Date(deletedDate.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}
