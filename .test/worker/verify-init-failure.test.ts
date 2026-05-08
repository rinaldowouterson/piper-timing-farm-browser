import { describe, it, expect, vi } from 'vitest';
import { createWorkerPool } from '../../src/farm/control-worker-pool';
import { PiperWorkerConfig } from '../../src/types';

describe('Worker Pool Initialization Rejection', () => {
  const mockConfig: PiperWorkerConfig = {
    modelId: 'test-model',
    instanceId: 0
  };

  it('init() should reject if a worker sends an error message instead of ready', async () => {
    // Capture worker instances as they are created
    const workerInstances: any[] = [];
    const OriginalWorker = globalThis.Worker;
    vi.stubGlobal('Worker', class extends (OriginalWorker as any) {
      constructor(url: URL, options: any) {
        super(url, options);
        this.postMessage = vi.fn();
        workerInstances.push(this);
      }
      // Expose emit for testing
      trigger(type: string, data: any) {
        (this as any).emit(type, data);
      }
    });

    const onReady = vi.fn();
    const onResult = vi.fn();
    const onLog = vi.fn();
    const pool = createWorkerPool(onReady, onResult, onLog);

    const initPromise = pool.init(mockConfig, 1);
    await new Promise(res => setTimeout(res, 0));

    const worker = workerInstances[0];
    worker.trigger('message', { type: 'error', instanceId: 0, error: 'Module not found' });

    await expect(initPromise).rejects.toThrow('Worker 0 failed to initialize: Module not found');
    vi.stubGlobal('Worker', OriginalWorker);
  });

  it('reinit() should reject if shadow workers fail to initialize', async () => {
    // Capture worker instances as they are created
    const workerInstances: any[] = [];
    const OriginalWorker = globalThis.Worker;
    vi.stubGlobal('Worker', class extends (OriginalWorker as any) {
      constructor(url: URL, options: any) {
        super(url, options);
        this.postMessage = vi.fn();
        workerInstances.push(this);
      }
      // Expose emit for testing
      trigger(type: string, data: any) {
        (this as any).emit(type, data);
      }
    });

    const onReady = vi.fn();
    const onResult = vi.fn();
    const onLog = vi.fn();
    const pool = createWorkerPool(onReady, onResult, onLog);

    // 1. Initial successful init
    const initTask = pool.init(mockConfig, 1);
    await new Promise(res => setTimeout(res, 0));
    workerInstances[0].trigger('message', { type: 'ready', instanceId: 0 });
    await initTask;

    // 2. Trigger reinit with error
    const reinitPromise = pool.reinit({ modelId: 'new-model' });
    await new Promise(res => setTimeout(res, 0));

    // The shadow worker is the second one created
    const shadowWorker = workerInstances[1];
    expect(shadowWorker).toBeDefined();

    shadowWorker.trigger('message', { type: 'error', instanceId: 1, error: 'WASM out of memory' });

    await expect(reinitPromise).rejects.toThrow('Worker 1 failed to initialize: WASM out of memory');
    
    // Cleanup
    vi.stubGlobal('Worker', OriginalWorker);
  });
});
