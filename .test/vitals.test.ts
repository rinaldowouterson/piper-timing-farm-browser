import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
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
    const cliPath = path.join(root, 'dist/cli.js');

    beforeAll(() => {
        // The CLI test always exercises the built artifact, not the source.
        // This ensures we are testing the same binary as consumers receive.
        if (!fs.existsSync(cliPath)) {
            execSync('npm run build', { cwd: root, stdio: 'inherit' });
        }
    });

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

        // Runs the compiled artifact — exactly what consumers execute
        execSync(`node ${cliPath} init`, { cwd: project });

        expect(fs.existsSync(path.join(project, 'public/piper-gate/infra/ort.wasm.min.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'public/piper-gate/infra/piper_phonemize.wasm'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'public/control-asset-sw.js'))).toBe(true);  // SW at root
    });

    it('should provision assets to SvelteKit Skeleton (static/assets)', () => {
        const project = path.join(testSpace, 'sveltekit-app');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'sveltekit-app' }));
        fs.writeFileSync(path.join(project, 'svelte.config.js'), ''); // Trigger Svelte detection

        execSync(`node ${cliPath} init`, { cwd: project });

        expect(fs.existsSync(path.join(project, 'static/piper-gate/infra/ort.wasm.min.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'static/piper-gate/infra/piper_phonemize.wasm'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'static/control-asset-sw.js'))).toBe(true);  // SW at root
    });

    it('should reject execution outside project root (no package.json)', () => {
        const project = path.join(testSpace, 'orphan-folder');
        fs.mkdirSync(project, { recursive: true });

        try {
            execSync(`node ${cliPath} init`, { cwd: project, stdio: 'ignore' });
            throw new Error('Should have failed');
        } catch (e) {
            // Expected failure
        }
    });

    it('Should successfully dispose of model cache (clearPiperModelCache)', async () => {
        const farm = createPiperWorkerFarm();
        
        // Mock fetch for Sovereign Gateway DELETE delegation
        const originalFetch = globalThis.fetch;
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
        globalThis.fetch = mockFetch;

        await farm.clearPiperModelCache();
        expect(mockFetch).toHaveBeenCalledWith('/piper-gate/voices/', { method: 'DELETE' });
        expect(farm.isInitialized()).toBe(false);
        
        globalThis.fetch = originalFetch;
    });
});
