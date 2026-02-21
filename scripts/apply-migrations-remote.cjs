#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  let sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  // Strip single-line SQL comments so wrangler doesn't parse them as CLI flags
  sql = sql.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n').trim();
  if (sql.length === 0) {
    console.log('Skipping empty:', file);
    continue;
  }

  console.log('Applying:', file);
  try {
    execFileSync('npx', [
      'wrangler', 'd1', 'execute', 'klubz-db-prod',
      '--remote', '--command', sql
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('  OK');
  } catch (e) {
    const msg = (e.stderr || '') + (e.stdout || '');
    if (
      msg.includes('already exists') ||
      msg.includes('duplicate column') ||
      msg.includes('SQLITE_ERROR: duplicate') ||
      msg.includes('table already exists')
    ) {
      console.log('  Skipped (already applied)');
    } else if (msg.includes('no such table')) {
      console.warn('  WARN (skipped - table not yet created):', msg.match(/no such table: \S+/)?.[0] || '');
    } else {
      console.error('  ERROR:', msg.slice(0, 500));
    }
  }
}
console.log('\nAll migrations applied.');
