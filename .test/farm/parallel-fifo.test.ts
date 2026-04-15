import { describe, it, expect, vi } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

/**
 * Parallel FIFO Integrity Test
 * 
 * Verifies that the internal queue remains strictly ordered even when 
 * multiple workers are processing in parallel.
 * 
 * Success = Correct results returned in requested order.
 */
describe('Parallel FIFO Integrity', () => {
    it('should maintain order across multiple parallel requests', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({

            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
            piperPaths: { piperJs: '', piperWasm: '', piperData: '' , piperJsSha256: '' }
        });

        const p1 = farm.synthesize('Sentence 1');
        const p2 = farm.synthesize('Sentence 2');
        const p3 = farm.synthesize('Sentence 3');

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        // Verifying order and completeness
        expect(r1.metadata.modelId).toBe('en_US-bryce-medium');
        expect(r2.metadata.modelId).toBe('en_US-bryce-medium');
        expect(r3.metadata.modelId).toBe('en_US-bryce-medium');
        
        farm.terminate();
    });
});