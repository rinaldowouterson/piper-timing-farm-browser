import { describe, it, expect, vi } from 'vitest';
import { createWorkerPool } from '../../src/farm/control-worker-pool';
import type { PiperWorkerConfig, WorkerState } from '../../src/types';

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
        voiceId: 'en_US-bryce-medium',
        modelId: 'en_US-bryce-medium',
        instanceId: 0,
        onnxRuntimePaths: {
            wasm: '/assets/ort-wasm-simd-threaded.wasm',
            mjs: '/assets/ort.all.min.mjs',
            mjsHelper: '/assets/ort-wasm-simd-threaded.mjs'
        },
        piperPaths: {
            piperData: '/assets/piper_phonemize.data',
            piperJs: '/assets/piper_phonemize.js',
            piperWasm: '/assets/piper_phonemize.wasm'
        }
    };

    it('should terminate idle workers immediately during reinit', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const onReady = vi.fn();
        const onResult = vi.fn();
        const pool = createWorkerPool(onReady, onResult);
        await pool.init(baseConfig, 2);
        
        expect(pool.getWorkerCount()).toBe(2);
        expect(pool.getBusyCount()).toBe(0);
        
        // Reinit with new model - idle workers should be terminated immediately
        const newConfig = { modelId: 'en_US-amy-medium', voiceId: 'en_US-amy-medium' };
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
        const pool = createWorkerPool(onReady, onResult);
        await pool.init(baseConfig, 2);
        
        // Mark a worker as busy (simulating active synthesis)
        const workers = pool.getWorkers();
        workers[0].busy = true;
        
        expect(pool.getBusyCount()).toBe(1);
        
        // Reinit - busy worker should not be terminated immediately
        const newConfig = { modelId: 'en_US-amy-medium', voiceId: 'en_US-amy-medium' };
        
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
        const pool = createWorkerPool(onReady, onResult);
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
        const pool = createWorkerPool(onReady, onResult);
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
        const pool = createWorkerPool(onReady, onResult);
        await pool.init(baseConfig, 2);
        
        // Set target model for transition
        pool.setTargetModelId('en_US-amy-medium');
        pool.setTargetSpeakerId(5);
        
        expect(pool.getTargetModelId()).toBe('en_US-amy-medium');
        expect(pool.getTargetSpeakerId()).toBe(5);
        
        spy.mockRestore();
        pool.terminate();
    });
});