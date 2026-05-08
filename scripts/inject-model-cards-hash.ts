#!/usr/bin/env node
/**
 * Post-build script: Calculates SHA-256 of piper-model-cards.json
 * and patches it directly into dist/control-asset-sw.js.
 *
 * Strategy: Direct artifact patching (consistent with inject-worker-hash.ts).
 * - Source carries a fixed placeholder — source is never mutated by the build.
 * - Source placeholder: PIPER_MODEL_CARDS_SHA256 constant in src/control-asset-sw.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'src/piper-model-cards.json');
const SW_DIST_PATH = path.join(ROOT, 'dist/control-asset-sw.js');

/**
 * Fixed 64-character placeholder embedded in src/control-asset-sw.ts.
 * All-ones distinguishes it from the worker placeholder (all-zeros).
 */
const PLACEHOLDER = '1111111111111111111111111111111111111111111111111111111111111111';

function calculateCardsHash(): string {
  const buffer = fs.readFileSync(INDEX_PATH);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function patchDist(hash: string): void {
  if (!fs.existsSync(SW_DIST_PATH)) {
    console.error(`[inject-model-cards-hash] Service Worker artifact not found at: ${SW_DIST_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(SW_DIST_PATH, 'utf-8');

  if (!content.includes(PLACEHOLDER)) {
    console.error(`[inject-model-cards-hash] Placeholder not found in dist/control-asset-sw.js.`);
    console.error(`[inject-model-cards-hash] Expected placeholder: "${PLACEHOLDER}"`);
    console.error('[inject-model-cards-hash] Ensure src/control-asset-sw.ts uses the all-ones placeholder, not a stale hash.');
    process.exit(1);
  }

  const patched = content.replace(PLACEHOLDER, hash);
  fs.writeFileSync(SW_DIST_PATH, patched, 'utf-8');
  console.log(`[inject-model-cards-hash] Patched dist/control-asset-sw.js: 11111111... → ${hash.slice(0, 8)}...`);

  // Verify the patch was applied and the placeholder is gone.
  const verification = fs.readFileSync(SW_DIST_PATH, 'utf-8');
  if (verification.includes(PLACEHOLDER)) {
    console.error('[inject-model-cards-hash] Patch verification FAILED: placeholder still present.');
    process.exit(1);
  }
  console.log('[inject-model-cards-hash] Patch verified: placeholder absent, hash present.');
}

const hash = calculateCardsHash();
patchDist(hash);
