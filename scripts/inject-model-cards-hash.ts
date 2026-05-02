#!/usr/bin/env node
/**
 * Build-time script: Calculates SHA-256 of piper-model-cards.json
 * and injects it into control-asset-sw.ts as the PIPER_MODEL_CARDS_SHA256 constant.
 *
 * Execution: npx tsx scripts/inject-model-cards-hash.ts
 * Automated: Runs as part of the build pipeline (prebuild hook).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'src/piper-model-cards.json');
const SW_PATH = path.join(ROOT, 'src/control-asset-sw.ts');

/**
 * Pattern matches the PIPER_MODEL_CARDS_SHA256 constant declaration.
 * Captures the line for replacement while preserving surrounding code.
 */
const HASH_PATTERN = /^(const PIPER_MODEL_CARDS_SHA256\s*=\s*')([a-f0-9]{64})(';)$/m;

function calculateCardsHash(): string {
	const buffer = fs.readFileSync(INDEX_PATH);
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

function injectHash(hash: string): void {
	const swContent = fs.readFileSync(SW_PATH, 'utf-8');
	const match = swContent.match(HASH_PATTERN);

	if (!match) {
		console.error('[inject-model-cards-hash] PIPER_MODEL_CARDS_SHA256 constant not found in control-asset-sw.ts');
		console.error('[inject-model-cards-hash] Expected pattern: const PIPER_MODEL_CARDS_SHA256 = \'<64-char-hex>\';');
		process.exit(1);
	}

	const currentHash = match[2];
	if (currentHash === hash) {
		console.log(`[inject-model-cards-hash] Hash unchanged: ${hash}`);
		return;
	}

	const updatedContent = swContent.replace(HASH_PATTERN, `$1${hash}$3`);
	fs.writeFileSync(SW_PATH, updatedContent, 'utf-8');
	console.log(`[inject-model-cards-hash] Updated PIPER_MODEL_CARDS_SHA256: ${currentHash} → ${hash}`);
}

const hash = calculateCardsHash();
injectHash(hash);
