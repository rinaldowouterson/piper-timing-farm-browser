import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Unified Verification: Global Orchestration over Asset Transfers.
 * 
 * Comprehensive integrity suite replacing legacy scripts/provision-skeletons.sh.
 * Verifies the 'piper-farm init' CLI across multiple framework project structures.
 */
describe('CLI > Provisioning Integrity (Unified Suite)', () => {
    const root = process.cwd();
    const testSpace = path.join(root, 'tmp/unified-test');
    const cliPath = path.join(root, 'dist/cli.js');

    const REQUIRED_INFRA = [
        'ort.wasm.min.mjs',
        'piper_phonemize.wasm',
        'process-piper-synthesis.worker.js',
        'piper-model-cards.json'
    ];

    beforeAll(() => {
        if (!fs.existsSync(cliPath)) {
            throw new Error(`CLI artifact not found at ${cliPath}. Run npm run build first.`);
        }
    });

    beforeEach(() => {
        if (fs.existsSync(testSpace)) fs.rmSync(testSpace, { recursive: true });
        fs.mkdirSync(testSpace, { recursive: true });
    });

    afterAll(() => {
        if (fs.existsSync(testSpace)) fs.rmSync(testSpace, { recursive: true });
        
        // Prune parent 'tmp' if it was created by us and is now empty
        const tmpDir = path.dirname(testSpace);
        if (fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length === 0) {
            fs.rmdirSync(tmpDir);
        }
    });

    const verifyProvisioning = (projectRoot: string, staticRootName: string) => {
        const staticRoot = path.join(projectRoot, staticRootName);
        const swPath = path.join(staticRoot, 'control-asset-sw.js');
        const infraPath = path.join(staticRoot, 'piper-gate/infra');

        expect(fs.existsSync(swPath), `Service Worker missing at ${swPath}`).toBe(true);
        for (const file of REQUIRED_INFRA) {
            const filePath = path.join(infraPath, file);
            expect(fs.existsSync(filePath), `Infra asset ${file} missing at ${filePath}`).toBe(true);
        }
    };

    it('should provision to Vite Vanilla (default: public/)', () => {
        const project = path.join(testSpace, 'vite-vanilla');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'vite-vanilla' }));

        execSync(`node ${cliPath} init`, { cwd: project });
        verifyProvisioning(project, 'public');
    });

    it('should provision to Vite React (default: public/)', () => {
        const project = path.join(testSpace, 'vite-react');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'vite-react' }));

        execSync(`node ${cliPath} init`, { cwd: project });
        verifyProvisioning(project, 'public');
    });

    it('should provision to Next.js (default: public/)', () => {
        const project = path.join(testSpace, 'nextjs-app');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'nextjs-app' }));
        fs.mkdirSync(path.join(project, 'public'), { recursive: true });

        execSync(`node ${cliPath} init`, { cwd: project });
        verifyProvisioning(project, 'public');
    });

    it('should provision to SvelteKit (detected: static/)', () => {
        const project = path.join(testSpace, 'sveltekit-app');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'sveltekit-app' }));
        fs.writeFileSync(path.join(project, 'svelte.config.js'), 'export default {}');

        execSync(`node ${cliPath} init`, { cwd: project });
        verifyProvisioning(project, 'static');
    });

    it('should provision to Custom Target Root', () => {
        const project = path.join(testSpace, 'custom-app');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'custom-app' }));

        execSync(`node ${cliPath} init custom-dist`, { cwd: project });
        verifyProvisioning(project, 'custom-dist');
    });

    it('should fail when package.json is missing (orphan directory protection)', () => {
        const project = path.join(testSpace, 'orphan-folder');
        fs.mkdirSync(project, { recursive: true });

        expect(() => {
            execSync(`node ${cliPath} init`, { cwd: project, stdio: 'pipe' });
        }).toThrow();
    });
});
