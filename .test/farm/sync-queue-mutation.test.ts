import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';
import modelsJson from '../../src/piper-model-cards.json';

/**
 * Race Condition Reproduction (Proof of Defect)
 * 
 * This test simulates a high-load scenario where a worker becomes available
 * during the exact window that updatePendingOptions is yielded awaiting 
 * model metadata.
 */
describe('Race Condition Reproduction (PoD)', () => {

    it('should NOT leak old speakerId when a worker becomes ready during the async yield', async () => {
        let resolveFetch: (value: any) => void;
        let currentFetchPromise: Promise<any>;

        const nextFetch = () => {
            currentFetchPromise = new Promise((resolve) => {
                resolveFetch = resolve;
            });
            return currentFetchPromise;
        };

        // 1. Mock fetch to be controllable
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('piper-model-cards.json')) {
                return currentFetchPromise;
            }
            return Promise.resolve({ 
                ok: true, 
                status: 200,
                json: async () => ({}) 
            });
        }));

        const farm = createPiperWorkerFarm();
        
        // 2. Initialize
        nextFetch();
        const initPromise = farm.init({
            modelId: 'uk_UA-tetiana-medium',
            cpuInstances: 1
        });

        resolveFetch!({
            ok: true,
            status: 200,
            json: async () => modelsJson
        });
        await initPromise;

        // @ts-ignore
        const workerInstance = window.Worker.instances[0];
        const postMessageSpy = vi.spyOn(workerInstance, 'postMessage');

        // 3. Busy out the worker with Task 1
        const p1 = farm.synthesize('Task 1', { speakerId: 0 });
        
        // 4. Queue Task 2 (stays in queue because worker is busy)
        const p2 = farm.synthesize('Task 2', { speakerId: 0 });

        // 7. Resolve the fetch to let the mutation complete (though it's sync now, 
        // the provider call happens after the fetch resolved in our test logic)
        // Wait, in the FIXED version, updatePendingOptions is sync and doesn't fetch.
        // So we call it, it completes immediately.
        
        // 5. Trigger PIVOT to Speaker 2. 
        // In the fixed version, this is SYNC and does NOT call nextFetch().
        farm.updatePendingOptions({ speakerId: 2 }, { numSpeakers: 3 });

        // 6. SIMULATE A WORKER BECOMING READY:
        // Even if a worker becomes ready right after the call, the queue is already mutated.
        workerInstance.onmessage({ 
            data: { 
                type: 'success', 
                instanceId: workerInstance.instanceId, 
                requestId: 'req-1', 
                result: { 
                    audioData: new Float32Array(0),
                    metadata: { speakerId: 0 }
                } 
            } 
        });

        // 8. Verify the result
        const task2Call = postMessageSpy.mock.calls.find(call => call[0].text === 'Task 2');
        
        if (!task2Call) {
            throw new Error("Task 2 was never dispatched");
        }

        expect(task2Call[0].speakerId).toBe(2);
    });
});
