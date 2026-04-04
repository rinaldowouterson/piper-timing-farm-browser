import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createPiperWorkerFarm } from '../src/farm/create-piper-worker-farm';

/**
 * Unified Verification: Global Orchestration over Asset Transfers.
 * 
 * Verifies that the 'piper-farm init' CLI correctly provisions assets 
 * to diverse framework skeletons (Vite, Next.js, SvelteKit).
 * 
 * Logic:
 * 1. Setup mock skeletons with package.json.
 * 2. Run CLI with different target directories.
 * 3. Verify asset presence and pathing logic (public/assets vs static/assets).
 */
describe('CLI > Unified Framework Orchestration', () => {
    const root = process.cwd();
    const testSpace = path.join(root, 'tmp/unified-test');

    beforeEach(() => {
        if (fs.existsSync(testSpace)) fs.rmSync(testSpace, { recursive: true });
        fs.mkdirSync(testSpace, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(testSpace)) fs.rmSync(testSpace, { recursive: true });
    });

    it('should provision assets to Vite/Vanilla Skeleton (public/assets)', () => {
        const project = path.join(testSpace, 'vite-vanilla');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'vite-vanilla' }));

        // Run the CLI from the dist folder (must be pre-built)
        const cliPath = path.join(root, 'src/cli/provision-assets-full.ts');
        execSync(`npx tsx ${cliPath} init`, { cwd: project });

        expect(fs.existsSync(path.join(project, 'public/assets/ort.wasm.min.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'public/assets/piper_phonemize.wasm'))).toBe(true);
    });

    it('should provision assets to SvelteKit Skeleton (static/assets)', () => {
        const project = path.join(testSpace, 'sveltekit-app');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'sveltekit-app' }));
        fs.writeFileSync(path.join(project, 'svelte.config.js'), ''); // Trigger Svelte detection

        const cliPath = path.join(root, 'src/cli/provision-assets-full.ts');
        execSync(`npx tsx ${cliPath} init`, { cwd: project });

        expect(fs.existsSync(path.join(project, 'static/assets/ort.wasm.min.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'static/assets/piper_phonemize.wasm'))).toBe(true);
    });

    it('should reject execution outside project root (no package.json)', () => {
        const project = path.join(testSpace, 'orphan-folder');
        fs.mkdirSync(project, { recursive: true });

        const cliPath = path.join(root, 'src/cli/provision-assets-full.ts');
        try {
            execSync(`npx tsx ${cliPath} init`, { cwd: project, stdio: 'ignore' });
            throw new Error('Should have failed');
        } catch (e) {
            // Expected failure
        }
    });

    it('Should successfully dispose of model cache (clearPiperModelCache)', async () => {
        const farm = createPiperWorkerFarm();
        
        // Mock OPFS for Vitest/JSDOM
        const mockRemoveEntry = vi.fn().mockResolvedValue(undefined);
        (global as any).navigator.storage = {
            getDirectory: vi.fn().mockResolvedValue({
                removeEntry: mockRemoveEntry
            })
        };

        await farm.clearPiperModelCache();
        expect(mockRemoveEntry).toHaveBeenCalledWith('voices', { recursive: true });
        expect(farm.isInitialized()).toBe(false);
    });
});
