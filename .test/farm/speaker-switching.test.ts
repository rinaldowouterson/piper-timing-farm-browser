import { describe, it, expect } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

/**
 * Speaker Switching Test (Scenario A)
 * 
 * Verifies that speakerId flows through the synthesis pipeline
 * as a per-request parameter without triggering any infrastructure changes.
 * 
 * Success = Different speakerIds on the same model, no reinit, correct metadata.
 */
describe('Speaker Switching (Scenario A)', () => {
    it('should pass different speakerIds through to results', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({
            voiceId: 'en_US-libritts-high',
            modelId: 'en_US-libritts-high',
            cpuInstances: 2,
            onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
            piperPaths: { piperJs: '', piperWasm: '', piperData: '' }
        });

        const p1 = farm.synthesize('Hello', { speakerId: 0 });
        const p2 = farm.synthesize('World', { speakerId: 1 });
        const p3 = farm.synthesize('Again', { speakerId: 0 });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(r1.metadata.speakerId).toBe(0);
        expect(r2.metadata.speakerId).toBe(1);
        expect(r3.metadata.speakerId).toBe(0);

        // All should be on the same model
        expect(r1.metadata.modelId).toBe('en_US-libritts-high');
        expect(r2.metadata.modelId).toBe('en_US-libritts-high');
        expect(r3.metadata.modelId).toBe('en_US-libritts-high');

        farm.terminate();
    });

    it('should default speakerId to 0 when omitted', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 1,
            onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
            piperPaths: { piperJs: '', piperWasm: '', piperData: '' }
        });

        const result = await farm.synthesize('No speaker specified');
        
        expect(result.metadata.speakerId).toBe(0);

        farm.terminate();
    });
});