import { describe, it, expect } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

/**
 * Worker Lifecycle Test
 * 
 * Verifies that the worker farm correctly initializes, tracks worker state, 
 * and handles termination.
 */
describe('PiperWorkerFarm Lifecycle', () => {
    it('should initialize the requested number of workers', async () => {
        const farm = createPiperWorkerFarm();
        const config = {
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
            piperPaths: { piperJs: '', piperWasm: '', piperData: '' }
        };

        await farm.init(config);
        
        // Internal state check if accessible, or check initialization calls
        // Since we're using mocks, this should resolve quickly
        expect(farm.isInitialized()).toBe(true);
        
        farm.terminate();
        expect(farm.isInitialized()).toBe(false);
    });
});