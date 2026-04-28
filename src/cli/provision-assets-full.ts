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
 * Directory Structure (Anchored to static-root):
 * - Defaults to 'static/' for SvelteKit, 'public/' for others.
 * - Service Worker → [static-root]/control-asset-sw.js (root, scope: /)
 * - Infra assets   → [static-root]/piper-gate/infra/ (WASM, Workers, data)
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

  switch (command) {
    case undefined:
    case 'init':
    case 'provision':
      await handleProvisionCommand(args[1]);
      break;

    case 'hash':
      await handleHashCommand(args[1]);
      break;

    default:
      console.error(`\nError: Unknown command "${command}"`);
      console.log('Usage:');
      console.log('  npx piper-farm                 (Provision to default public/ or static/ folder)');
      console.log('  npx piper-farm init [root]     (Provision to custom static root)');
      console.log('  npx piper-farm hash [file]     (Calculate SHA-256 sidecar)\n');
      console.log('Note: [root] is your web server\'s static root. The Service Worker will be');
      console.log('placed in this root, and assets in [root]/piper-gate/infra/.\n');
      process.exit(1);
  }
}

/**
 * Handles the 'hash' command with isolated parameters.
 */
async function handleHashCommand(filePath: string) {
  const cwd = process.cwd();
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
  } catch (err: any) {
    console.error(`\nError hashing file: ${err.message}\n`);
    process.exit(1);
  }
}

/**
 * Handles the 'provision'/'init' command with anchored path resolution.
 */
async function handleProvisionCommand(overrideRoot?: string) {
  const cwd = process.cwd();
  
  // 1. ANCHOR: Resolve the Static Root (where the web server starts)
  const isSvelteKit = fs.existsSync(path.join(cwd, 'svelte.config.js'));
  const dirStaticRoot = overrideRoot || (isSvelteKit ? 'static' : 'public');
  const pathStaticRoot = path.resolve(cwd, dirStaticRoot);
  
  // 2. DERIVE: Infrastructure target is always relative to the Static Root
  const pathInfraTarget = path.join(pathStaticRoot, 'piper-gate', 'infra');

  console.log(`\nProvisioning Sovereign Gateway to ${dirStaticRoot}...`);

  // Ensure directories exist
  if (!fs.existsSync(pathInfraTarget)) {
    fs.mkdirSync(pathInfraTarget, { recursive: true });
  }

  const sourceDir = __dirname; 
  let filesProvisioned = 0;

  // Tier 1: Pattern-based discovery in dist root (Workers & Service Workers)
  const rootFiles = fs.readdirSync(sourceDir);
  
  const patterns = [
    { regex: /sw\.js$/, target: pathStaticRoot, label: 'Service Worker' },
    { regex: /\.worker\.js$/, target: pathInfraTarget, label: 'Infrastructure Worker' }
  ];

  for (const file of rootFiles) {
    const fullSourcePath = path.join(sourceDir, file);
    if (fs.statSync(fullSourcePath).isDirectory()) continue;

    for (const { regex, target, label } of patterns) {
      if (regex.test(file)) {
        const destPath = path.join(target, file);
        fs.copyFileSync(fullSourcePath, destPath);
        console.log(`  [OK] ${label}: ${path.relative(cwd, destPath)}`);
        filesProvisioned++;
      }
    }
  }

  // Tier 2: Recursive binary asset copy (WASM, data)
  const assetsDir = path.join(sourceDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    filesProvisioned += copyFiles(assetsDir, pathInfraTarget);
  }

  console.log(`\nSuccess: ${filesProvisioned} assets provisioned to ${path.relative(cwd, pathStaticRoot)}/`);
  console.log('Sovereign Gateway is now ready.\n');
}

function copyFiles(sourceDir: string, absTargetDir: string): number {
  if (!fs.existsSync(absTargetDir)) {
    fs.mkdirSync(absTargetDir, { recursive: true });
  }

  const files = fs.readdirSync(sourceDir);
  console.log(`\nProvisioning infrastructure assets to ${path.basename(absTargetDir)}...`);

  for (const file of files) {
    const src = path.join(sourceDir, file);
    if (fs.lstatSync(src).isDirectory()) continue;
    
    const dest = path.join(absTargetDir, file);
    fs.copyFileSync(src, dest);
    console.log(`  [OK] ${file}`);
  }

  return files.length;
}

provision().catch((err: unknown) => {
  console.error('\nProvisioning failed:', err);
  process.exit(1);
});
