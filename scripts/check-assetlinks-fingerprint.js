#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(process.cwd(), 'public/.well-known/assetlinks.json');
const placeholder = 'REPLACE_WITH_PLAY_STORE_SHA256_CERT_FINGERPRINT';

try {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const fingerprints = Array.isArray(parsed)
    ? parsed.flatMap((entry) => entry?.target?.sha256_cert_fingerprints || [])
    : [];

  if (!fingerprints.length) {
    console.error('assetlinks check failed: no SHA-256 fingerprints defined.');
    process.exit(1);
  }

  if (fingerprints.includes(placeholder)) {
    console.error('assetlinks check failed: placeholder fingerprint is still present.');
    console.error('Set the Play Store signing SHA-256 fingerprint in public/.well-known/assetlinks.json before production deploy.');
    process.exit(1);
  }

  console.log('assetlinks check passed: non-placeholder fingerprint found.');
} catch (err) {
  console.error('assetlinks check failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
