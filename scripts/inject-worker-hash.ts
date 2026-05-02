#!/usr/bin/env node
/**
 * Post-build script: Calculates SHA-256 of the built synthesis worker
 * and injects it into control-asset-sw.ts as the PROCESS_PIPER_SYNTHESIS_WORKER_SHA256 constant.
 * 
 * Logic:
 * - This script tracks the ACTUAL built artifact in dist/.
 * - Injection into the SW source triggers a secondary build pass to embed the hash.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER_DIST_PATH = path.join(ROOT, 'dist/process-piper-synthesis.worker.js');
const SW_PATH = path.join(ROOT, 'src/control-asset-sw.ts');

const HASH_PATTERN = /^(const PROCESS_PIPER_SYNTHESIS_WORKER_SHA256\s*=\s*')([a-f0-9]{0,64})(';)$/m;

function calculateWorkerHash(): string {
  if (!fs.existsSync(WORKER_DIST_PATH)) {
    console.error(`[inject-worker-hash] Worker artifact not found at: ${WORKER_DIST_PATH}`);
    console.error('Make sure to run a build first.');
    process.exit(1);
  }
  const buffer = fs.readFileSync(WORKER_DIST_PATH);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function injectHash(hash: string): void {
  const swContent = fs.readFileSync(SW_PATH, 'utf-8');
  const match = swContent.match(HASH_PATTERN);

  if (!match) {
    console.error('[inject-worker-hash] PROCESS_PIPER_SYNTHESIS_WORKER_SHA256 constant not found in control-asset-sw.ts');
    process.exit(1);
  }

  const currentHash = match[2];
  if (currentHash === hash) {
    console.log(`[inject-worker-hash] Worker hash unchanged: ${hash.slice(0, 8)}...`);
    return;
  }

  const updatedContent = swContent.replace(HASH_PATTERN, `$1${hash}$3`);
  fs.writeFileSync(SW_PATH, updatedContent, 'utf-8');
  console.log(`[inject-worker-hash] Updated PROCESS_PIPER_SYNTHESIS_WORKER_SHA256: ${currentHash.slice(0, 8)} → ${hash.slice(0, 8)}`);
}

const hash = calculateWorkerHash();
injectHash(hash);
