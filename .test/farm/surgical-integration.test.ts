import { describe, it, expect, vi } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

describe('Surgical Update Integration', () => {
    const baseConfig = {
        modelId: 'en_US-bryce-medium',
        onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
        piperPaths: { piperData: '', piperJs: '', piperWasm: '', piperJsSha256: '' }
    };

    it('should NOT hang synthesis after a surgical callback toggle', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({ ...baseConfig, cpuInstances: 1 });
        
        const mockWorkers = (globalThis as any).Worker.instances;
        expect(mockWorkers.length).toBe(1);
        
        const postMessageSpy = vi.spyOn(mockWorkers[0], 'postMessage');
        
        // 1. Initial ready signal
        mockWorkers[0].onmessage({ data: { type: 'ready', instanceId: 0, configCounter: 1 } });
        
        // 2. Perform surgical reinit (toggle callback ON)
        const reinitPromise = farm.init({ ...baseConfig, useCallback: true, cpuInstances: 1 });
        await reinitPromise;
        
        // 3. At this point, poolTargetCounter is 2, but worker.activeCounter is still 1.
        // Synthesis should be queued but not dispatched yet.
        const synthesisPromise = farm.synthesize('test text', { requestId: 'req-1' });
        
        // Let microtasks run
        await Promise.resolve();
        
        // Check if postMessage was called (it shouldn't be yet, because worker is not "ready" for counter 2)
        const synthesizeCalls = postMessageSpy.mock.calls.filter((c: any) => c[0].type === 'synthesize');
        expect(synthesizeCalls.length).toBe(0);
        
        // 4. Worker sends 'callback-on' for counter 2
        mockWorkers[0].onmessage({ data: { type: 'callback-on', instanceId: 0, configCounter: 2 } });
        
        // 5. NOW synthesis should be dispatched!
        // We wait for microtasks to see if processQueue was triggered.
        await Promise.resolve();
        
        const synthesizeCallsAfter = postMessageSpy.mock.calls.filter((c: any) => c[0].type === 'synthesize');
        
        // EXPECTATION: It should have been dispatched.
        // ACTUAL (BUG): It will be 0 because onResult doesn't call processQueue for callback-on.
        expect(synthesizeCallsAfter.length).toBe(1);
        
        farm.terminate();
    });
});
