#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const __dirname = (import.meta as any).dirname;

/**
 * Universal Provisioning CLI for Piper Timing Farm.
 * 
 * Protocol: Action (Provision) / HC (Assets) / LC (Full).
 * Purpose: Allows developers to initialize their local environment with 
 * necessary WASM/Binary assets regardless of their bundler.
 */
async function provision() {
  const cwd = process.cwd();
  
  // FAIL FAST: Root check to prevent accidental sprawl
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    console.error('\nError: npx piper-farm must be run from your project root (containing package.json).');
    console.error('The Unified methodology requires project encapsulation to ensure stability.\n');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const command = args[0];

  // Intelligent Detection: SvelteKit uses 'static/', others use 'public/'
  const isSvelteKit = fs.existsSync(path.join(cwd, 'svelte.config.js'));
  const defaultDir = isSvelteKit ? 'static/assets' : 'public/assets';
  const targetDir = args[1] || defaultDir;

  if (command !== 'init') {
    console.log('\nPiper Timing Farm CLI');
    console.log('Usage: npx piper-farm init [target-path]');
    console.log('Default target: ./public/assets\n');
    process.exit(0);
  }

  const absTargetDir = path.resolve(cwd, targetDir);
  
  // Source resolution: Relative to the compiled cli.js in the dist folder
  // Structure: 
  //   node_modules/piper-timing-farm/dist/cli.js
  //   node_modules/piper-timing-farm/dist/worker/assets/
  const sourceBinDir = path.resolve(__dirname, 'worker/assets');
  const sourceScriptDir = path.resolve(__dirname, 'assets');

  // Unified Provisioning Strategy
  const copyJob = (srcDir: string) => {
    if (fs.existsSync(srcDir)) {
      copyFiles(srcDir, absTargetDir, targetDir);
    }
  };

  if (!fs.existsSync(sourceBinDir)) {
    // Development fallback (running from src)
    const devSourceBinDir = path.resolve(__dirname, '../../src/worker/assets');
    copyJob(devSourceBinDir);
  } else {
    // Production path (running from node_modules/dist)
    copyJob(sourceBinDir);
    copyJob(sourceScriptDir);
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

  console.log(`\nSuccess! ${files.length} assets provisioned.`);
  console.log('Next steps:');
  console.log(`1. Ensure your server serves ${relativeDisplayPath}`);
  console.log('2. Use the library normally: import { ... } from "piper-timing-farm"\n');
}

provision().catch(err => {
  console.error('\nProvisioning failed:', err);
  process.exit(1);
});
