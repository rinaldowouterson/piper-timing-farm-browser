import { describe, it, expect, vi } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

describe('Double-Tap Poison Pill Protocol', () => {
    const baseConfig = {
        modelId: 'en_US-bryce-medium',
        instanceId: 0,
        onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
        piperPaths: { piperData: '', piperJs: '', piperWasm: '', piperJsSha256: '' }
    };

    it('should retry a physical crash once', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({ ...baseConfig, cpuInstances: 2 });
        
        // Start synthesis
        const promise = farm.synthesize('hello retry', { requestId: 'req-1' });
        
        // Wait for worker to pick it up and process
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // MockWorker instances are globally tracked in setup.ts
        const mockWorkers = (globalThis as any).Worker.instances;
        expect(mockWorkers.length).toBeGreaterThan(0);
        
        // Trigger a crash on the first worker
        const worker1 = mockWorkers[0];
        worker1.dispatchEvent(new ErrorEvent('error', { message: 'Out of memory' }));
        
        // The farm should retry it, meaning another worker should pick it up and resolve it
        const result = await promise;
        expect(result).toBeDefined();
        expect(result.requestId).toBe('req-1');
        
        // Pool should have 1 active worker remaining out of the 2 initialized
        expect(farm.metrics.totalWorkers).toBe(1);
        
        farm.terminate();
    });

    it('should reject a physical crash after retry exhaustion', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({ ...baseConfig, cpuInstances: 2 });
        
        const promise = farm.synthesize('hello poison', { requestId: 'req-poison' });
        
        const mockWorkers = (globalThis as any).Worker.instances;
        
        // Crash the first worker immediately (next tick so postMessage has been called)
        await Promise.resolve();
        mockWorkers[0].dispatchEvent(new ErrorEvent('error', { message: 'Poison Pill' }));
        
        // Wait just a tick to let the farm re-queue and dispatch to second worker
        await Promise.resolve();
        
        // Crash the second worker
        mockWorkers[1].dispatchEvent(new ErrorEvent('error', { message: 'Poison Pill Again' }));
        
        // The promise should reject with the Fatal Crash error
        await expect(promise).rejects.toThrow('Worker Termination (Retry Exhausted): Poison Pill Again');
        
        // Pool should be empty since both crashed
        expect(farm.metrics.totalWorkers).toBe(0);
        
        farm.terminate();
    });

    it('should reject pending tasks with Farm Exhaustion if pool is empty', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({ ...baseConfig, cpuInstances: 1 });
        
        const mockWorkers = (globalThis as any).Worker.instances;
        
        // Crash the only worker while idle
        mockWorkers[0].dispatchEvent(new ErrorEvent('error', { message: 'Random background crash' }));
        
        // Wait for pool to process the removal
        await Promise.resolve();
        expect(farm.metrics.totalWorkers).toBe(0);
        
        // Now try to synthesize
        const promise = farm.synthesize('hello exhaustion', { requestId: 'req-ex' });
        
        // Should reject immediately due to farm exhaustion
        await expect(promise).rejects.toThrow('Farm Exhausted');
        
        farm.terminate();
    });

    it('should reject immediately if the error is logical (worker still alive)', async () => {
        const farm = createPiperWorkerFarm();
        await farm.init({ ...baseConfig, cpuInstances: 1 });
        
        const mockWorkers = (globalThis as any).Worker.instances;
        
        // We simulate a logical error by intercepting postMessage BEFORE calling synthesize
        const originalPostMessage = mockWorkers[0].postMessage;
        mockWorkers[0].postMessage = function(msg: any) {
            if (msg.type === 'synthesize') {
                setTimeout(() => {
                    const event = { data: { 
                        type: 'error', 
                        instanceId: this.instanceId,
                        error: 'Voice not found',
                        originalRequest: msg 
                    } };
                    if (this.onmessage) this.onmessage(event as any);
                }, 10);
            } else {
                originalPostMessage.call(this, msg);
            }
        };

        const promise2 = farm.synthesize('hello logical 2', { requestId: 'req-logic-2' });

        await expect(promise2).rejects.toThrow('Voice not found');
        
        // Worker should still be alive since it was a logical error
        expect(farm.metrics.totalWorkers).toBe(1);
        
        farm.terminate();
    });
});
