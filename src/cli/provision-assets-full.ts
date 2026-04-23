#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateSidecarHash } from '../utils/resolve-sha256-node';

const __dirname = (import.meta as any).dirname;

/**
 * Asset Provisioning CLI for Piper Timing Farm.
 * 
 * Provisions WASM/Binary assets and Service Worker for the integrity gateway.
 * 
 * Directory Structure:
 * - Infra assets (ORT WASM, Piper phonemize) → public/piper-gate/infra/
 * - Service Worker → public/control-asset-sw.js (root, scope: /)
 */
async function provision() {
  const cwd = process.cwd();
  
  // FAIL FAST: Root check to prevent accidental sprawl
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    console.error('\nError: npx piper-farm must be run from your project root (containing package.json).');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const command = args[0];

  // Intelligent Detection: SvelteKit uses 'static/', others use 'public/'
  const isSvelteKit = fs.existsSync(path.join(cwd, 'svelte.config.js'));
  const publicDir = isSvelteKit ? 'static' : 'public';
  const defaultDir = `${publicDir}/piper-gate/infra`;
  const targetDir = args[1] || defaultDir;

  if (command === 'hash') {
    const filePath = args[1];
    if (!filePath) {
      console.error('\nError: Please specify a file path to hash.');
      console.log('Usage: npx piper-farm hash <path-to-file>\n');
      process.exit(1);
    }

    const absPath = path.resolve(cwd, filePath);
    if (!fs.existsSync(absPath)) {
      console.error(`\nError: File not found at ${absPath}\n`);
      process.exit(1);
    }

    try {
      console.log(`\nCalculating SHA-256 for ${path.relative(cwd, absPath)}...`);
      const sidecar = generateSidecarHash(absPath);
      console.log(`  [OK] Hash: ${sidecar.sha256}`);
      console.log(`  [OK] Created sidecar: ${path.basename(absPath)}.json`);
      console.log(`  [OK] Timestamp: ${new Date(sidecar.generatedAt).toISOString()}\n`);
      process.exit(0);
    } catch (err) {
      console.error('\nHashing failed:', err);
      process.exit(1);
    }
  }

  if (command !== 'init') {
    console.log('\nPiper Timing Farm CLI');
    console.log('Usage:');
    console.log('  npx piper-farm init [target-path]  - Provision assets to /piper-gate/infra/');
    console.log('  npx piper-farm hash <file-path>    - Generate sidecar integrity hash\n');
    console.log('Default paths:');
    console.log(`  SvelteKit: static/piper-gate/infra/`);
    console.log(`  Others:    public/piper-gate/infra/`);
    console.log(`  Service Worker: public/control-asset-sw.js (root, scope: /)\n`);
    process.exit(0);
  }

  const absTargetDir = path.resolve(cwd, targetDir);

  // Source resolution: Resolved relative to this compiled script in dist/.
  // All assets live in dist/assets/ — a sibling of cli.js.
  const sourceAssetsDir = path.resolve(__dirname, 'assets');

  if (!fs.existsSync(sourceAssetsDir)) {
    console.error(
      '\nError: Cannot locate asset directory at ' + sourceAssetsDir +
      '\nThis directory is part of the published package and should never be missing.' +
      '\nIf you are developing piper-timing-farm itself, run `npm run build` first.\n'
    );
    process.exit(1);
  }

  copyFiles(sourceAssetsDir, absTargetDir, targetDir);

  // PROVISION SERVICE WORKER: Copy to root (public/ or static/) for scope: /
  // Root scope allows consumers to expand interception to additional paths
  const swSource = path.join(__dirname, 'control-asset-sw.js');
  const swTargetDir = publicDir; // e.g., public/ or static/
  const swTarget = path.join(swTargetDir, 'control-asset-sw.js');

  if (fs.existsSync(swSource)) {
    console.log(`\nProvisioning Service Worker to ${path.relative(cwd, swTargetDir)}...`);
    fs.copyFileSync(swSource, swTarget);
    console.log(`  [OK] control-asset-sw.js`);
    console.log(`  [OK] SW scope: / (root)`);
  } else {
    console.warn(`\n[Warning] Could not find Service Worker source at ${swSource}. Skipping SW provisioning.`);
  }
}

function copyFiles(sourceDir: string, absTargetDir: string, relativeDisplayPath: string) {
  if (!fs.existsSync(absTargetDir)) {
    fs.mkdirSync(absTargetDir, { recursive: true });
  }

  const files = fs.readdirSync(sourceDir);
  console.log(`\nProvisioning Piper Timing Farm assets to ${relativeDisplayPath}...`);

  for (const file of files) {
    const src = path.join(sourceDir, file);
    // Ignore internal metadata files if any
    if (fs.lstatSync(src).isDirectory()) continue;
    
    const dest = path.join(absTargetDir, file);
    fs.copyFileSync(src, dest);
    console.log(`  [OK] ${file}`);
  }

  console.log(`\nSuccess! ${files.length} infra assets provisioned.`);
  console.log('Next steps:');
  console.log(`1. Ensure your server serves /piper-gate/ directory`);
  console.log('2. Service Worker registered at /control-asset-sw.js (scope: /)');
  console.log('3. Use the library: import { ... } from "piper-timing-farm"\n');
}

provision().catch(err => {
  console.error('\nProvisioning failed:', err);
  process.exit(1);
});
