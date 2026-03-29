#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;

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
  const sourceDir = path.resolve(__dirname, 'worker/assets');

  if (!fs.existsSync(sourceDir)) {
    // Development fallback (if running directly from src for some reason)
    const devSourceDir = path.resolve(__dirname, '../../src/worker/assets');
    if (!fs.existsSync(devSourceDir)) {
      console.error(`Error: Could not find source assets. Checked: \n- ${sourceDir}\n- ${devSourceDir}`);
      process.exit(1);
    }
    // Use dev source if found
    copyFiles(devSourceDir, absTargetDir, targetDir);
  } else {
    copyFiles(sourceDir, absTargetDir, targetDir);
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
