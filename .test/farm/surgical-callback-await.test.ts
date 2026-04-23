import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerPool } from '../../src/farm/control-worker-pool';

describe('Surgical Callback Handshake', () => {
  let pool: any;
  let mockWorker: any;
  
  beforeEach(() => {
    // Mock the global Worker class
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
      // Helper to dispatch messages in the test
      _dispatch: (data: any) => {
        listeners.forEach(l => l({ data }));
        if (mockWorker.onmessage) mockWorker.onmessage({ data });
      },
      onmessage: null,
    };
    
    // Stub as a constructor function
    const MockWorker = vi.fn().mockImplementation(function() {
      return mockWorker;
    });
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (pool) pool.terminate();
  });

  it('reinit() should resolve ONLY after all workers send callback-loaded', async () => {
    const onReady = vi.fn();
    pool = createWorkerPool(onReady, vi.fn(), vi.fn());

    // 1. Initial Init 
    const initPromise = pool.init({
      modelId: 'test-model',
      onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
      piperPaths: { piperWasm: '', piperJs: '', piperData: '' , piperJsSha256: '' }
    }, 1);

    // Simulate worker ready
    mockWorker._dispatch({ type: 'ready', instanceId: 0 });
    await initPromise;

    // 2. Surgical Reinit (Path A)
    const reinitPromise = pool.reinit({
      modelId: 'test-model', // Same model -> Path A
      useCallback: true
    });

    // Verify it is still pending
    let resolved = false;
    reinitPromise.then(() => { resolved = true; });
    
    await new Promise(r => setTimeout(r, 100));
    expect(resolved).toBe(false);
    expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load-callback' }));

    // 3. Simulate Worker Success
    mockWorker._dispatch({ type: 'callback-loaded', instanceId: 0 });
    
    await reinitPromise;
    expect(resolved).toBe(true);
  });

  it('reinit() should fall back to Path B (Hotswap) if surgical update fails', async () => {
    const onReady = vi.fn();
    const onLog = vi.fn();
    pool = createWorkerPool(onReady, vi.fn(), onLog);

    // 1. Initial Init
    const initPromise = pool.init({
      modelId: 'test-model',
      onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
      piperPaths: { piperWasm: '', piperJs: '', piperData: '' , piperJsSha256: '' }
    }, 1);
    mockWorker._dispatch({ type: 'ready', instanceId: 0 });
    await initPromise;

    // 2. Surgical Reinit triggers Path A first
    const reinitPromise = pool.reinit({
      modelId: 'test-model',
      useCallback: true
    });

    // 3. Simulate Worker Failure
    mockWorker._dispatch({ type: 'callback-failed', instanceId: 0, error: 'Import failed' });

    // 4. Verify Fallback to Path B (Shadow Pool) started
    // Poll for the second Worker call
    await vi.waitFor(() => {
      if (vi.mocked(Worker).mock.results.length < 2) throw new Error("Shadow worker not yet created");
    }, { timeout: 2000 });

    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ 
      level: 'warn', 
      message: expect.stringContaining('Falling back to Path B') 
    }));

    // Path B creates a NEW worker. The global mocked Worker will be called again.
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    // Simulate Shadow Worker ready
    const shadowWorker = vi.mocked(Worker).mock.results[1].value;
    shadowWorker._dispatch({ type: 'ready', instanceId: 1 }); 

    await reinitPromise;
    expect(onReady).toHaveBeenCalledWith(1);
  });

  it('getNextAvailable() should return null while callbacks are loading', async () => {
    pool = createWorkerPool(vi.fn(), vi.fn(), vi.fn());

    // 1. Init
    const initPromise = pool.init({
      modelId: 'test-model',
      onnxRuntimePaths: { wasm: '', mjs: '', mjsHelper: '' },
      piperPaths: { piperWasm: '', piperJs: '', piperData: '' , piperJsSha256: '' }
    }, 1);
    mockWorker._dispatch({ type: 'ready', instanceId: 0 });
    await initPromise;

    // 2. Start Surgical Load
    pool.reinit({
      modelId: 'test-model',
      useCallback: true
    });

    // 3. Check Availability (should be blocked)
    expect(pool.getNextAvailable()).toBe(null);

    // 4. Resolve Load
    mockWorker._dispatch({ type: 'callback-loaded', instanceId: 0 });
    
    // 5. Check Availability (should be free)
    expect(pool.getNextAvailable()).not.toBe(null);
  });
});
