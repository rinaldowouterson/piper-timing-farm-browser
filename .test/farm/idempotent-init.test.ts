import { describe, it, expect, vi } from 'vitest';

// Advanced Auto-Signaling Worker Mock
vi.stubGlobal('Worker', vi.fn().mockImplementation(function() {
  const listeners: { type: string; handler: Function }[] = [];
  let instanceId: number | undefined;

  const instance = {
    postMessage: vi.fn((msg: any) => {
      if (msg.type === 'init') {
        instanceId = msg.config.instanceId;
        // Auto-signal ready after a short delay to simulate async init
        setTimeout(() => {
          const response = { data: { type: 'ready', instanceId: instanceId } };
          if (instance.onmessage) (instance as any).onmessage(response as MessageEvent);
          listeners.forEach(l => {
            if (l.type === 'message') l.handler(response);
          });
        }, 10);
      } else if (msg.type === 'load-callback') {
        // Auto-signal callback-loaded to complete the atomic handshake
        setTimeout(() => {
          const response = { data: { type: 'callback-loaded', instanceId: instanceId } };
          if (instance.onmessage) (instance as any).onmessage(response as MessageEvent);
          listeners.forEach(l => {
            if (l.type === 'message') l.handler(response);
          });
        }, 100); // 100ms for callback load simulation
      }
    }),
    terminate: vi.fn(),
    addEventListener: vi.fn((type, handler) => {
      listeners.push({ type, handler });
    }),
    removeEventListener: vi.fn(),
    onmessage: null as any,
    onerror: null as any
  };

  return instance;
}));

import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

const mockConfig = {

  modelId: 'test-model',
  cpuInstances: 2,
  onnxRuntimePaths: { wasm: 'w', mjs: 'm', mjsHelper: 'h' },
  piperPaths: { piperJs: 'j', piperWasm: 'w', piperData: 'd' , piperJsSha256: '' }
};

describe('Idempotent Init & Surgical Reinit', () => {
  it('should not spawn new workers on redundant init', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init(mockConfig);
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    // Second redundant init
    await farm.init(mockConfig);
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should handle simultaneous identical init calls', async () => {
    const farm = createPiperWorkerFarm();
    
    // Fire two inits at once
    const p1 = farm.init(mockConfig);
    const p2 = farm.init(mockConfig);
    
    await Promise.all([p1, p2]);
    
    // Should ONLY have spawned 2 workers total, not 4
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should reuse workers during surgical reinit (callback only)', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init(mockConfig);
    const workerInstances = vi.mocked(Worker).mock.results.map(r => r.value);
    const firstWorker0 = workerInstances[0];
    
    // Surgical reinit (callback change)
    // Pass partial config with undefined to test removeUndefined resilience
    await farm.reinit({ 
      useCallback: true,
      modelId: mockConfig.modelId
    });
    
    // Verify load-callback was sent to existing worker
    expect(firstWorker0.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load-callback',
      useCallback: true
    }));
    
    // Verify NO new workers were spawned
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should perform hotswap during full reinit (model change)', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init(mockConfig);
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);

    // Full reinit (model change)
    await farm.reinit({ 
      modelId: 'new-model',
    });
    
    // Total workers spawned should be 4 (2 initial + 2 shadow)
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(4);
    expect(farm.getActiveModelId()).toBe('new-model');
    
    farm.terminate();
  });
});
