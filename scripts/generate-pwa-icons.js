#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const iconDir = path.join(repoRoot, 'public', 'static', 'icons');
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function ensureIconDir() {
  if (!fs.existsSync(iconDir)) {
    throw new Error(`Icon directory not found: ${iconDir}`);
  }
}

function generateIcon(size) {
  const svgPath = path.join(iconDir, `icon-${size}x${size}.svg`);
  const pngPath = path.join(iconDir, `icon-${size}x${size}.png`);

  if (!fs.existsSync(svgPath)) {
    throw new Error(`Source SVG missing: ${svgPath}`);
  }

  const result = spawnSync(
    'convert',
    [svgPath, '-background', 'none', '-resize', `${size}x${size}`, pngPath],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to generate PNG for ${size}x${size}`);
  }
}

function main() {
  ensureIconDir();
  for (const size of sizes) {
    generateIcon(size);
  }
  console.log(`Generated ${sizes.length} PNG icons in ${iconDir}`);
}

main();
