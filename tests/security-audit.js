#!/usr/bin/env node

/**
 * Deterministic security audit for Klubz.
 *
 * This replaces random/simulated checks with reproducible assertions:
 * 1) cryptographic primitive checks (AES-256-GCM + HMAC)
 * 2) security middleware policy checks from source
 * 3) contract-level integration tests for authz/cors/csp/rate-limit/request-id
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  log(`\n${'='.repeat(64)}`, 'bright');
  log(title, 'bright');
  log('='.repeat(64), 'bright');
}

function check(condition, okMsg, errMsg) {
  if (condition) {
    log(`✅ ${okMsg}`, 'green');
    return true;
  }
  log(`❌ ${errMsg}`, 'red');
  return false;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function testAesGcm() {
  section('🔐 CRYPTOGRAPHY: AES-256-GCM');

  const plaintext = 'security-regression-check';
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

  const checks = [
    check(key.length === 32, 'Key length is 256 bits', 'Key length is not 256 bits'),
    check(iv.length === 12, 'IV length is 96 bits (GCM standard)', 'IV length is not 96 bits'),
    check(decrypted === plaintext, 'Round-trip encryption/decryption succeeds', 'AES-GCM round-trip failed'),
  ];

  return checks.every(Boolean);
}

function testJwtHmac() {
  section('🎫 TOKEN SIGNING: HMAC-SHA256');

  const payload = {
    sub: 'user-123',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const secret = crypto.randomBytes(32).toString('hex');

  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');

  const jwt = `${signingInput}.${sig}`;
  const recomputed = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');

  const checks = [
    check(secret.length >= 64, 'HMAC secret length is >= 256 bits', 'HMAC secret too short'),
    check(jwt.split('.').length === 3, 'JWT has 3 segments', 'JWT shape is invalid'),
    check(sig === recomputed, 'JWT signature verification succeeds', 'JWT signature verification failed'),
  ];

  return checks.every(Boolean);
}

function testSecurityMiddlewarePolicy() {
  section('🛡️ MIDDLEWARE POLICY CHECKS');

  const source = fs.readFileSync('src/index.tsx', 'utf8');

  const checks = [
    check(source.includes("c.header('Content-Security-Policy'"), 'CSP header is configured', 'CSP header missing'),
    check(source.includes("c.header('X-Content-Type-Options', 'nosniff')"), 'X-Content-Type-Options configured', 'X-Content-Type-Options missing'),
    check(source.includes("c.header('X-Frame-Options', 'DENY')"), 'X-Frame-Options configured', 'X-Frame-Options missing'),
    check(source.includes("c.header('Referrer-Policy', 'strict-origin-when-cross-origin')"), 'Referrer-Policy configured', 'Referrer-Policy missing'),
    check(source.includes("c.header('Strict-Transport-Security'"), 'HSTS configured', 'HSTS missing'),
    check(source.includes("app.use('/api/*', rateLimiter({"), 'API rate limiter middleware enabled', 'API rate limiter middleware missing'),
    check(source.includes('JWT_SECRET must be at least 32 characters in production'), 'Production JWT guard present', 'Production JWT guard missing'),
    check(source.includes('ENCRYPTION_KEY must be a 64-character hex string in production'), 'Production encryption-key guard present', 'Production encryption-key guard missing'),
  ];

  return checks.every(Boolean);
}

async function testSecurityContracts() {
  section('🧪 INTEGRATION SECURITY CONTRACTS');
  log('Running focused Vitest security suites...', 'blue');

  const files = [
    'tests/integration/security-hardening.test.ts',
    'tests/integration/route-authz-contracts.test.ts',
    'tests/integration/csp-security-contracts.test.ts',
    'tests/integration/cors-security-contracts.test.ts',
    'tests/integration/rate-limiter-contracts.test.ts',
    'tests/integration/request-id-contracts.test.ts',
  ];

  const code = await runCommand('npx', ['vitest', 'run', ...files]);
  return check(code === 0, 'Security contract suites passed', 'Security contract suites failed');
}

async function runSecurityAudit() {
  section('🔒 KLUBZ SECURITY AUDIT (DETERMINISTIC)');

  const results = [];
  results.push({ name: 'AES-256-GCM', passed: testAesGcm() });
  results.push({ name: 'JWT HMAC', passed: testJwtHmac() });
  results.push({ name: 'Security middleware policy', passed: testSecurityMiddlewarePolicy() });
  results.push({ name: 'Security integration contracts', passed: await testSecurityContracts() });

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const score = Math.round((passed / total) * 100);

  section('📊 SECURITY AUDIT RESULTS');
  for (const r of results) {
    log(`${r.passed ? '✅' : '❌'} ${r.name}`, r.passed ? 'green' : 'red');
  }
  log(`\nSecurity score: ${score}%`, score >= 90 ? 'green' : score >= 75 ? 'yellow' : 'red');

  if (score >= 90) {
    log('\nSecurity gate: PASS', 'green');
    return true;
  }

  log('\nSecurity gate: FAIL', 'red');
  return false;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSecurityAudit()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { runSecurityAudit };
