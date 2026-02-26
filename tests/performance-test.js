#!/usr/bin/env node

/**
 * Deterministic performance smoke suite for deployment readiness.
 *
 * Focus:
 * 1) event-loop responsiveness under CPU pressure
 * 2) concurrent async task throughput
 * 3) memory growth under allocation churn
 * 4) matching engine benchmark/regression via tests/matching.test.js
 */

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
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

function check(condition, passMsg, failMsg) {
  if (condition) {
    log(`✅ ${passMsg}`, 'green');
    return true;
  }
  log(`❌ ${failMsg}`, 'red');
  return false;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function testEventLoopLatency() {
  section('⏱️ EVENT LOOP LATENCY');

  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const baselineDelay = performance.now() - start;

  const cpuStart = performance.now();
  let checksum = 0;
  for (let i = 0; i < 80_000; i++) {
    const hash = crypto.createHash('sha256').update(`klubz-${i}`).digest('hex');
    checksum ^= hash.charCodeAt(0);
  }
  const cpuDuration = performance.now() - cpuStart;

  const postSamples = [];
  for (let i = 0; i < 80; i += 1) {
    const postStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    postSamples.push(performance.now() - postStart);
  }
  const sorted = [...postSamples].sort((a, b) => a - b);
  const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  const postP99 = sorted[p99Index];

  log(`Baseline setTimeout(0) delay: ${baselineDelay.toFixed(2)}ms`, 'blue');
  log(`CPU burst duration: ${cpuDuration.toFixed(2)}ms`, 'blue');
  log(`Post-burst setTimeout(0) p99 delay: ${postP99.toFixed(2)}ms`, 'blue');

  const checks = [
    check(cpuDuration < 2000, 'CPU burst stayed under 2s', 'CPU burst exceeded 2s'),
    check(postP99 < 50, 'Post-burst loop p99 stayed under 50ms', 'Post-burst loop p99 exceeded 50ms'),
    check(checksum !== 0, 'Checksum guard validated workload execution', 'Checksum guard failed'),
  ];

  return checks.every(Boolean);
}

async function testConcurrentThroughput() {
  section('🚦 CONCURRENT ASYNC THROUGHPUT');

  const tasks = 1200;
  const t0 = performance.now();

  await Promise.all(
    Array.from({ length: tasks }, (_, i) =>
      Promise.resolve().then(() => crypto.createHash('sha1').update(`task-${i}`).digest('hex'))
    )
  );

  const duration = performance.now() - t0;
  const throughput = tasks / (duration / 1000);

  log(`Completed ${tasks} async tasks in ${duration.toFixed(2)}ms`, 'blue');
  log(`Throughput: ${throughput.toFixed(0)} tasks/sec`, 'blue');

  const checks = [
    check(duration < 2500, 'Async batch completed under 2.5s', 'Async batch exceeded 2.5s'),
    check(throughput > 500, 'Throughput above 500 tasks/sec', 'Throughput below 500 tasks/sec'),
  ];

  return checks.every(Boolean);
}

async function testMemoryGrowth() {
  section('🧠 MEMORY GROWTH');

  const before = process.memoryUsage();

  const dataset = Array.from({ length: 25_000 }, (_, i) => ({
    id: i,
    payload: crypto.createHash('md5').update(`payload-${i}`).digest('hex'),
  }));

  // Prevent optimization away
  const digest = dataset[100].payload.slice(0, 4) + dataset[10_000].payload.slice(0, 4);

  if (global.gc) global.gc();

  const after = process.memoryUsage();
  const rssDeltaMb = (after.rss - before.rss) / (1024 * 1024);
  const heapDeltaMb = (after.heapUsed - before.heapUsed) / (1024 * 1024);

  log(`RSS delta: ${rssDeltaMb.toFixed(2)} MB`, 'blue');
  log(`Heap-used delta: ${heapDeltaMb.toFixed(2)} MB`, 'blue');

  const checks = [
    check(digest.length === 8, 'Dataset integrity check passed', 'Dataset integrity check failed'),
    check(rssDeltaMb < 180, 'RSS growth stayed below 180MB', 'RSS growth exceeded 180MB'),
    check(heapDeltaMb < 120, 'Heap growth stayed below 120MB', 'Heap growth exceeded 120MB'),
  ];

  return checks.every(Boolean);
}

async function testMatchingEngineBenchmark() {
  section('🧭 MATCHING ENGINE BENCHMARK REGRESSION');
  log('Running tests/matching.test.js (includes performance assertions)...', 'blue');

  const code = await runCommand('node', ['tests/matching.test.js']);
  return check(code === 0, 'Matching benchmark suite passed', 'Matching benchmark suite failed');
}

async function runLoadTests() {
  section('🚀 KLUBZ PERFORMANCE SMOKE SUITE');

  const results = [];
  results.push({ name: 'Event loop latency', passed: await testEventLoopLatency() });
  results.push({ name: 'Concurrent throughput', passed: await testConcurrentThroughput() });
  results.push({ name: 'Memory growth', passed: await testMemoryGrowth() });
  results.push({ name: 'Matching benchmark', passed: await testMatchingEngineBenchmark() });

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const score = Math.round((passed / total) * 100);

  section('📈 PERFORMANCE RESULTS');
  for (const r of results) {
    log(`${r.passed ? '✅' : '❌'} ${r.name}`, r.passed ? 'green' : 'red');
  }
  log(`\nPerformance score: ${score}%`, score >= 90 ? 'green' : score >= 75 ? 'yellow' : 'red');

  if (score >= 90) {
    log('\nPerformance gate: PASS', 'green');
    return true;
  }

  log('\nPerformance gate: FAIL', 'red');
  return false;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runLoadTests()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { runLoadTests };
