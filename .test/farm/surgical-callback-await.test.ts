import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerPool } from '../../src/farm/control-worker-pool';

describe('Surgical Callback Handshake', () => {
  let pool: any;
  let mockWorker: any;
  
  beforeEach(() => {
    const listeners = new Set<(e: any) => void>();
    mockWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      addEventListener: vi.fn((type, handler) => {
        if (type === 'message') listeners.add(handler);
      }),
      removeEventListener: vi.fn((type, handler) => {
        if (type === 'message') listeners.delete(handler);
      }),
      _dispatch: (data: any) => {
        listeners.forEach(l => l({ data }));
        if (mockWorker.onmessage) mockWorker.onmessage({ data });
      },
      onmessage: null,
    };
    
    const MockWorker = vi.fn().mockImplementation(function() {
      return mockWorker;
    });
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (pool) pool.terminate();
  });

  it('reinit() should resolve immediately for surgical updates (non-blocking)', async () => {
    const onReady = vi.fn();
    pool = createWorkerPool(onReady, vi.fn(), vi.fn());

    const initPromise = pool.init({
      modelId: 'test-model',
      onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
      piperPaths: { piperWasm: '', piperJs: '', piperData: '' , piperJsSha256: '' }
    }, 1);

    mockWorker._dispatch({ type: 'ready', instanceId: 0, configCounter: 1 });
    await initPromise;

    // Path A
    const reinitPromise = pool.reinit({
      modelId: 'test-model',
      useCallback: true
    });

    // Should resolve immediately without waiting for callback-loaded/on
    await reinitPromise;
    expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load-callback', configCounter: 2 }));
  });

  it('getNextAvailable() should return null while activeCounter < poolTargetCounter', async () => {
    pool = createWorkerPool(vi.fn(), vi.fn(), vi.fn());

    const initPromise = pool.init({
      modelId: 'test-model',
      onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
      piperPaths: { piperWasm: '', piperJs: '', piperData: '' , piperJsSha256: '' }
    }, 1);
    mockWorker._dispatch({ type: 'ready', instanceId: 0, configCounter: 1 });
    await initPromise;

    // Start Surgical Load (poolTargetCounter becomes 2)
    pool.reinit({
      modelId: 'test-model',
      useCallback: true
    });

    // activeCounter is still 1, targetCounter is 2
    expect(pool.getNextAvailable()).toBe(null);

    // Worker responds with configCounter 2
    mockWorker._dispatch({ type: 'callback-on', instanceId: 0, configCounter: 2 });
    
    // Should be free now
    expect(pool.getNextAvailable()).not.toBe(null);
  });
});
