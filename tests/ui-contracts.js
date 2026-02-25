#!/usr/bin/env node

/**
 * UI wiring contracts:
 * - app routes rendered by Renderer must have binding/load coverage
 * - nav targets must resolve to known routes
 * - on('id', ...) bindings must reference existing DOM ids in app templates
 * - admin sidebar menu ids must map to switch cases
 */

import fs from 'node:fs';

function uniq(arr) {
  return [...new Set(arr)];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractCaseLabels(block) {
  return uniq([...block.matchAll(/case '([^']+)'/g)].map((m) => m[1]));
}

function runAppContracts() {
  const source = fs.readFileSync('public/static/js/app.js', 'utf8');

  const renderSwitch = source.split('switch (currentScreen)')[1]?.split('default:')[0] ?? '';
  const bindSwitch = source.split('bindEvents(screen, signal)')[1]?.split('loadScreenData(screen)')[0] ?? '';
  const loadSwitch = source.split('loadScreenData(screen)')[1]?.split('// ═══ Event Handlers')[0] ?? '';

  const renderRoutes = extractCaseLabels(renderSwitch);
  const bindRoutes = extractCaseLabels(bindSwitch);
  const loadRoutes = extractCaseLabels(loadSwitch);

  const routedButUncovered = renderRoutes.filter((route) => !bindRoutes.includes(route) && !loadRoutes.includes(route));
  assert(routedButUncovered.length === 0, `App routes missing bind/load coverage: ${routedButUncovered.join(', ')}`);

  const navTargets = uniq([...source.matchAll(/class="nav-item"[^>]*data-screen="([^"]+)"/g)].map((m) => m[1]));
  const unknownNavTargets = navTargets.filter((route) => !renderRoutes.includes(route));
  assert(unknownNavTargets.length === 0, `Bottom-nav routes missing render cases: ${unknownNavTargets.join(', ')}`);

  const htmlIds = uniq([...source.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
  const boundIds = uniq([...source.matchAll(/\bon\(\s*'([^']+)'/g)].map((m) => m[1]));
  const missingIds = boundIds.filter((id) => !htmlIds.includes(id));
  assert(missingIds.length === 0, `Bound element ids missing in templates: ${missingIds.join(', ')}`);

  console.log('✅ app.js route/button wiring contracts passed');
}

function runAdminContracts() {
  const source = fs.readFileSync('public/static/js/admin.js', 'utf8');

  const menuBlock = source.split('const menuItems = [')[1]?.split('];')[0] ?? '';
  const menuIds = uniq([...menuBlock.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]));

  const switchBlock = source.split('switch (currentView)')[1]?.split('default:')[0] ?? '';
  const switchIds = extractCaseLabels(switchBlock);

  const missingCases = menuIds.filter((id) => !switchIds.includes(id));
  assert(missingCases.length === 0, `Admin menu ids missing switch cases: ${missingCases.join(', ')}`);

  console.log('✅ admin.js menu/tab wiring contracts passed');
}

try {
  runAppContracts();
  runAdminContracts();
  console.log('✅ UI contract checks passed');
  process.exit(0);
} catch (error) {
  console.error(`❌ UI contract failure: ${error.message}`);
  process.exit(1);
}
