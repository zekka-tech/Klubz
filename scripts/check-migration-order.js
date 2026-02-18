#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), 'migrations');

const knownLegacyDuplicatePrefixes = new Map([
  ['0003', new Set(['0003_add_payment_fields.sql', '0003_smart_matching.sql'])],
]);

function fail(message) {
  console.error(`[migration-check] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(migrationsDir)) {
  fail(`Migrations directory not found: ${migrationsDir}`);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  fail('No migration files found.');
}

const parsed = [];
for (const file of files) {
  const match = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
  if (!match) {
    fail(`Invalid migration filename format: ${file}. Expected 0001_description.sql`);
  }
  parsed.push({ file, prefix: match[1], number: Number(match[1]) });
}

const byPrefix = new Map();
for (const entry of parsed) {
  const list = byPrefix.get(entry.prefix) ?? [];
  list.push(entry.file);
  byPrefix.set(entry.prefix, list);
}

for (const [prefix, filesForPrefix] of byPrefix.entries()) {
  if (filesForPrefix.length <= 1) continue;

  const allowed = knownLegacyDuplicatePrefixes.get(prefix);
  if (!allowed) {
    fail(`Duplicate migration prefix ${prefix}: ${filesForPrefix.join(', ')}`);
  }

  for (const file of filesForPrefix) {
    if (!allowed.has(file)) {
      fail(`Unexpected duplicate for legacy prefix ${prefix}: ${file}`);
    }
  }

  if (allowed.size !== filesForPrefix.length) {
    fail(`Legacy duplicate prefix ${prefix} does not match expected file set.`);
  }
}

const uniqueVersions = [...new Set(parsed.map((m) => m.number))].sort((a, b) => a - b);
const min = uniqueVersions[0];
const max = uniqueVersions[uniqueVersions.length - 1];

if (min !== 1) {
  fail(`Migration versions must start at 0001. Found ${String(min).padStart(4, '0')}.`);
}

for (let current = min; current <= max; current += 1) {
  if (!uniqueVersions.includes(current)) {
    fail(`Missing migration version ${String(current).padStart(4, '0')}.`);
  }
}

const nextVersion = String(max + 1).padStart(4, '0');
console.log(`[migration-check] OK: ${files.length} files, ${uniqueVersions.length} unique versions, next version ${nextVersion}.`);
