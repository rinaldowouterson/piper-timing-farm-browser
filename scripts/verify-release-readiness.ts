#!/usr/bin/env node
/**
 * Release Readiness Gate
 * 
 * Runs the full verification pipeline before npm publish.
 * Wired as "prepublishOnly" in package.json — npm blocks publish on non-zero exit.
 *
 * Checks:
 * 1. Type resolution (tsc --noEmit)
 * 2. Test suite (vitest run)
 * 3. Production build (vite build + hash injection)
 * 4. Critical dist artifacts exist
 * 5. Hash placeholders are absent (injection succeeded)
 * 6. Public API declaration contains expected exports
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let failures = 0;

function run(label: string, command: string): void {
  process.stdout.write(`\n[verify] ${label}...\n`);
  try {
    execSync(command, { cwd: ROOT, stdio: 'inherit' });
    process.stdout.write(`[verify] ✓ ${label}\n`);
  } catch {
    process.stderr.write(`[verify] ✗ ${label} FAILED\n`);
    failures++;
  }
}

function check(label: string, condition: boolean): void {
  if (condition) {
    process.stdout.write(`[verify] ✓ ${label}\n`);
  } else {
    process.stderr.write(`[verify] ✗ ${label} FAILED\n`);
    failures++;
  }
}

// --- Phase 1: Source Verification ---
run('Typecheck (tsc --noEmit)', 'npx tsc --noEmit');
run('Test suite (vitest run)', 'npx vitest run');

// --- Phase 2: Build ---
run('Production build', 'npm run build');

// --- Phase 3: Dist Artifact Validation ---
process.stdout.write('\n[verify] Validating dist artifacts...\n');

const requiredFiles = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'dist/control-asset-sw.js',
  'dist/process-piper-synthesis.worker.js',
  'dist/worker.d.ts',
  'dist/assets/piper-model-cards.json',
];

for (const file of requiredFiles) {
  const absPath = path.join(ROOT, file);
  check(`Artifact exists: ${file}`, fs.existsSync(absPath));
}

// --- Phase 4: Hash Placeholder Absence ---
const swPath = path.join(ROOT, 'dist/control-asset-sw.js');
if (fs.existsSync(swPath)) {
  const swContent = fs.readFileSync(swPath, 'utf-8');
  const zeroPlaceholder = '0000000000000000000000000000000000000000000000000000000000000000';
  const onesPlaceholder = '1111111111111111111111111111111111111111111111111111111111111111';
  check('Worker hash injected (no zero-placeholder)', !swContent.includes(zeroPlaceholder));
  check('Model cards hash injected (no ones-placeholder)', !swContent.includes(onesPlaceholder));
}

// --- Phase 5: Declaration Export Verification ---
const dtsPath = path.join(ROOT, 'dist/index.d.ts');
if (fs.existsSync(dtsPath)) {
  const dtsContent = fs.readFileSync(dtsPath, 'utf-8');
  check('Declaration exports createPiperProvider', dtsContent.includes('createPiperProvider'));
  check('Declaration exports clearModelCache', dtsContent.includes('clearModelCache'));
  check('Declaration exports PiperModelDefinition', dtsContent.includes('PiperModelDefinition'));
}

// --- Verdict ---
process.stdout.write('\n');
if (failures > 0) {
  process.stderr.write(`[verify] ✗ RELEASE BLOCKED — ${failures} check(s) failed.\n\n`);
  process.exit(1);
} else {
  process.stdout.write(`[verify] ✓ All checks passed. Safe to publish.\n\n`);
}
