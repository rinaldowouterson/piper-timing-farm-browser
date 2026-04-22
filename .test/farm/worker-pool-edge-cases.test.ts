import { describe, it, expect, vi } from 'vitest';
import { createWorkerPool } from '../../src/farm/control-worker-pool';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';
import type { PiperWorkerConfig, WorkerState, RequestStatusPayload } from '../../src/types';

/**
 * Worker Pool Edge Cases Test
 * 
 * Coverage targets:
 * - Busy worker retirement during reinit (lines 96-109)
 * - Worker error handling (lines 146-148)
 * - getNextAvailable() with transitioning workers (line 113)
 */

describe('Worker Pool Edge Cases', () => {
    const baseConfig: PiperWorkerConfig = {
        modelId: 'en_US-bryce-medium',
        instanceId: 0,
        onnxRuntimePaths: {
            wasm: '/piper-gate/infra/',
            mjs: '/piper-gate/infra/ort.wasm.min.mjs',
            mjsHelper: '/piper-gate/infra/ort-wasm-simd-threaded.mjs'
        },
        piperPaths: {
            piperData: '/piper-gate/infra/piper_phonemize.data',
            piperJs: '/piper-gate/infra/piper_phonemize.js',
            piperWasm: '/piper-gate/infra/piper_phonemize.wasm',
            piperJsSha256: '' 
        }
    };

    it('should terminate idle workers immediately during reinit', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        expect(pool.getWorkerCount()).toBe(2);
        expect(pool.getBusyCount()).toBe(0);
        
        // Reinit with new model - idle workers should be terminated immediately
        const newConfig = { modelId: 'en_US-amy-medium' };
        await pool.reinit(newConfig);
        
        // Pool should have new workers
        expect(pool.getActiveModelId()).toBe('en_US-amy-medium');
        expect(pool.getWorkerCount()).toBe(2);
        
        spy.mockRestore();
        pool.terminate();
    });

    it('should wait for busy workers to finish before terminating during reinit', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        // Mark a worker as busy (simulating active synthesis)
        const workers = pool.getWorkers();
        workers[0].busy = true;
        
        expect(pool.getBusyCount()).toBe(1);
        
        // Reinit - busy worker should not be terminated immediately
        const newConfig = { modelId: 'en_US-amy-medium' };
        
        // Start reinit (it will wait for busy worker)
        const reinitPromise = pool.reinit(newConfig);
        
        // Simulate worker completing its task
        // The worker should have a cleanup handler attached
        setTimeout(() => {
            // Simulate success message from busy worker
            workers[0].worker.postMessage({ type: 'synthesize' });
        }, 50);
        
        await reinitPromise;
        
        // After busy worker completes, pool should have new workers
        expect(pool.getActiveModelId()).toBe('en_US-amy-medium');
        
        spy.mockRestore();
        pool.terminate();
    });

    it('should handle worker error during synthesis', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        // Get a worker
        const workers = pool.getWorkers();
        const worker = workers[0];
        
        // Simulate worker error by dispatching an error event
        const errorEvent = new ErrorEvent('error', { message: 'Worker crashed' });
        worker.worker.dispatchEvent(errorEvent);
        
        // Pool should still be functional (error logged via onResult)
        // The onResult callback should have been called with an error message
        expect(onResult).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error' })
        );
        
        errorSpy.mockRestore();
        pool.terminate();
    });

    it('should skip transitioning workers in getNextAvailable()', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        // Mark all workers as transitioning
        const workers = pool.getWorkers();
        workers.forEach((w: WorkerState) => {
            w.busy = false;
            w.transitioning = true;
        });
        
        // getNextAvailable should return null (no available workers)
        const available = pool.getNextAvailable();
        expect(available).toBeNull();
        
        // Mark one as not transitioning
        workers[0].transitioning = false;
        
        // Now should find an available worker
        const nextAvailable = pool.getNextAvailable();
        expect(nextAvailable).toBe(workers[0]);
        
        spy.mockRestore();
        pool.terminate();
    });

    it('should track target model and speaker ID for transitions', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        // Set target model for transition
        pool.setTargetModelId('en_US-amy-medium');
        pool.setTargetSpeakerId(5);
        
        expect(pool.getTargetModelId()).toBe('en_US-amy-medium');
        expect(pool.getTargetSpeakerId()).toBe(5);
        
        spy.mockRestore();
        pool.terminate();
    });

    it('should abort pending transitions when rapid reinit is called (Atomic Supersession)', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const onLog = vi.fn();
        const pool = createWorkerPool(onReady, onResult, onLog);
        await pool.init(baseConfig, 2);
        
        expect(pool.getActiveModelId()).toBe('en_US-bryce-medium');

        // Fire 5 rapid reinit() calls — only the last should succeed
        const models = [
            'en_US-amy-medium',
            'uk_UA-ukrainian_tts-medium',
            'de_DE-thorsten-medium',
            'fr_FR-siwis-medium',
            'es_ES-davefx-medium'
        ];

        const results = await Promise.allSettled(
            models.map(modelId => pool.reinit({ modelId }))
        );

        // First 4 should be rejected with AbortError (superseded)
        for (let i = 0; i < 4; i++) {
            expect(results[i].status).toBe('rejected');
            if (results[i].status === 'rejected') {
                const reason = (results[i] as PromiseRejectedResult).reason;
                expect(reason).toBeInstanceOf(DOMException);
                expect(reason.name).toBe('AbortError');
            }
        }

        // Last should succeed
        expect(results[4].status).toBe('fulfilled');

        // Only the final model should be active
        expect(pool.getActiveModelId()).toBe('es_ES-davefx-medium');

        // Worker count should be exactly the original count (no orphaned workers)
        expect(pool.getWorkerCount()).toBe(2);
        
        spy.mockRestore();
        pool.terminate();
    });

    describe('Self-Healing Worker Replacement (replaceWorker)', () => {
        it('should terminate old worker and spawn a ready replacement', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const onReady = vi.fn();
            const onResult = vi.fn();
            const onLog = vi.fn();
            const pool = createWorkerPool(onReady, onResult, onLog);
            await pool.init(baseConfig, 2);

            const oldWorkers = pool.getWorkers();
            const oldId = oldWorkers[0].id;

            // Replace the first worker
            pool.replaceWorker(oldId);

            // The new worker should have a different ID
            const newWorkers = pool.getWorkers();
            expect(newWorkers[0].id).not.toBe(oldId);
            expect(newWorkers.length).toBe(2);

            // Initially marked as transitioning (not ready yet)
            expect(newWorkers[0].transitioning).toBe(true);

            // Wait for the mock worker to fire its 'ready' event (10ms setTimeout in mock)
            await new Promise(resolve => setTimeout(resolve, 50));

            // After ready, transitioning should be cleared
            expect(pool.getWorkers()[0].transitioning).toBe(false);

            spy.mockRestore();
            pool.terminate();
        });

        it('should maintain pool size after multiple rapid replacements', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const onReady = vi.fn();
            const onResult = vi.fn();
            const onLog = vi.fn();
            const pool = createWorkerPool(onReady, onResult, onLog);
            await pool.init(baseConfig, 3);

            expect(pool.getWorkerCount()).toBe(3);

            // Replace all workers in rapid succession
            const ids = pool.getWorkers().map(w => w.id);
            for (const id of ids) {
                pool.replaceWorker(id);
            }

            // Pool size must remain constant
            expect(pool.getWorkerCount()).toBe(3);

            // All new workers should be transitioning
            const workers = pool.getWorkers();
            for (const w of workers) {
                expect(w.transitioning).toBe(true);
            }

            // Wait for all ready events
            await new Promise(resolve => setTimeout(resolve, 50));

            // All should now be available
            for (const w of pool.getWorkers()) {
                expect(w.transitioning).toBe(false);
            }

            spy.mockRestore();
            pool.terminate();
        });

        it('should exclude transitioning replacement from getNextAvailable()', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const onReady = vi.fn();
            const onResult = vi.fn();
            const onLog = vi.fn();
            const pool = createWorkerPool(onReady, onResult, onLog);
            await pool.init(baseConfig, 1);

            const oldId = pool.getWorkers()[0].id;
            pool.replaceWorker(oldId);

            // While transitioning, no worker should be available
            expect(pool.getNextAvailable()).toBeNull();

            // Wait for ready
            await new Promise(resolve => setTimeout(resolve, 50));

            // Now the replacement should be available
            expect(pool.getNextAvailable()).not.toBeNull();

            spy.mockRestore();
            pool.terminate();
        });

        it('should be a no-op for invalid worker id', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const onReady = vi.fn();
            const onResult = vi.fn();
            const onLog = vi.fn();
            const pool = createWorkerPool(onReady, onResult, onLog);
            await pool.init(baseConfig, 2);

            const countBefore = pool.getWorkerCount();

            // Replace with a non-existent ID — should silently no-op
            pool.replaceWorker(99999);

            expect(pool.getWorkerCount()).toBe(countBefore);

            spy.mockRestore();
            pool.terminate();
        });

        it('should be a no-op before pool initialization', () => {
            const onReady = vi.fn();
            const onResult = vi.fn();
            const onLog = vi.fn();
            const pool = createWorkerPool(onReady, onResult, onLog);

            // No init called — replaceWorker should silently return
            pool.replaceWorker(0);

            expect(pool.getWorkerCount()).toBe(0);
        });
    });

    describe('Queue Observability', () => {
        it('should strictly emit queued -> processing -> completed events', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const events: RequestStatusPayload[] = [];
            
            const farm = createPiperWorkerFarm();
            farm.onQueueStatus(status => events.push(status));

            await farm.init(baseConfig);
            
            // Wait for workers to be ready
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const promise = farm.synthesize('hello world');
            
            // queued and processing happen synchronously in the synthesize call
            expect(events.length).toBe(2);
            expect(events[0]).toMatchObject({ text: 'hello world', state: 'queued' });
            expect(events[1]).toMatchObject({ text: 'hello world', state: 'processing' });
            
            await promise;
            
            // completed happens asynchronously
            expect(events.length).toBe(3);
            expect(events[2]).toMatchObject({ text: 'hello world', state: 'completed' });
            
            farm.terminate();
            spy.mockRestore();
        });

        it('should emit cancelled event upon cancelSynthesis', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const events: RequestStatusPayload[] = [];
            
            const farm = createPiperWorkerFarm();
            farm.onQueueStatus(status => events.push(status));

            await farm.init(baseConfig);
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const promise = farm.synthesize('hello cancellation', { requestId: 'cancel-test' });
            
            farm.cancelSynthesis('cancel-test');
            
            try { await promise; } catch (e) {}
            
            // queued -> processing -> cancelled (since the worker was fast enough to pick it up)
            expect(events.length).toBe(3);
            expect(events[2]).toMatchObject({ requestId: 'cancel-test', state: 'cancelled' });
            
            farm.terminate();
            spy.mockRestore();
        });
    });
});