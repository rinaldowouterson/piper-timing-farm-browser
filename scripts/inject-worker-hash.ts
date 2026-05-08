#!/usr/bin/env node
/**
 * Post-build script: Calculates SHA-256 of the built synthesis worker
 * and patches it directly into dist/control-asset-sw.js.
 *
 * Strategy: Direct artifact patching (single-build).
 * - Replaces the fixed 64-zero placeholder in the compiled dist artifact.
 * - Eliminates the need for a second vite build pass.
 * - Source placeholder: src/control-asset-sw.ts PROCESS_PIPER_SYNTHESIS_WORKER_SHA256
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER_DIST_PATH = path.join(ROOT, 'dist/process-piper-synthesis.worker.js');
const SW_DIST_PATH = path.join(ROOT, 'dist/control-asset-sw.js');

/**
 * Fixed 64-character placeholder embedded in src/control-asset-sw.ts.
 * Must be unique within the bundle — no other SHA-256 slot uses all zeros.
 */
const PLACEHOLDER = '0000000000000000000000000000000000000000000000000000000000000000';

function calculateWorkerHash(): string {
  if (!fs.existsSync(WORKER_DIST_PATH)) {
    console.error(`[inject-worker-hash] Worker artifact not found at: ${WORKER_DIST_PATH}`);
    console.error('[inject-worker-hash] Run a build first.');
    process.exit(1);
  }
  const buffer = fs.readFileSync(WORKER_DIST_PATH);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function patchDist(hash: string): void {
  if (!fs.existsSync(SW_DIST_PATH)) {
    console.error(`[inject-worker-hash] Service Worker artifact not found at: ${SW_DIST_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(SW_DIST_PATH, 'utf-8');

  if (!content.includes(PLACEHOLDER)) {
    console.error(`[inject-worker-hash] Placeholder not found in dist/control-asset-sw.js.`);
    console.error(`[inject-worker-hash] Expected placeholder: "${PLACEHOLDER}"`);
    console.error('[inject-worker-hash] Ensure src/control-asset-sw.ts uses the 64-zero placeholder, not a stale hash.');
    process.exit(1);
  }

  const patched = content.replace(PLACEHOLDER, hash);
  fs.writeFileSync(SW_DIST_PATH, patched, 'utf-8');
  console.log(`[inject-worker-hash] Patched dist/control-asset-sw.js: 00000000... → ${hash.slice(0, 8)}...`);

  // Verify the patch was applied and the placeholder is gone.
  const verification = fs.readFileSync(SW_DIST_PATH, 'utf-8');
  if (verification.includes(PLACEHOLDER)) {
    console.error('[inject-worker-hash] Patch verification FAILED: placeholder still present.');
    process.exit(1);
  }
  console.log('[inject-worker-hash] Patch verified: placeholder absent, hash present.');
}

const hash = calculateWorkerHash();
patchDist(hash);
