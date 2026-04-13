import { describe, it, expect, vi } from 'vitest';

// Advanced Auto-Signaling Worker Mock
vi.stubGlobal('Worker', vi.fn().mockImplementation(function() {
  const listeners: { type: string; handler: Function }[] = [];
  return {
    postMessage: vi.fn((msg) => {
      if (msg.type === 'init') {
        // Auto-signal ready after a short delay to simulate async init
        setTimeout(() => {
          listeners.forEach(l => {
            if (l.type === 'message') l.handler({ data: { type: 'ready', instanceId: msg.config.instanceId } });
          });
        }, 10);
      }
    }),
    terminate: vi.fn(),
    addEventListener: vi.fn((type, handler) => {
      listeners.push({ type, handler });
    }),
    removeEventListener: vi.fn(),
    onmessage: null,
    onerror: null
  };
}));

import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

const mockConfig = {
  voiceId: 'test-voice',
  modelId: 'test-model',
  cpuInstances: 2,
  onnxRuntimePaths: { wasm: 'w', mjs: 'm', mjsHelper: 'h' },
  piperPaths: { piperJs: 'j', piperWasm: 'w', piperData: 'd' }
};

describe('Idempotent Init & Surgical Reinit', () => {
  it('should not spawn new workers on redundant init', async () => {
    const farm = createPiperWorkerFarm();
    const workerSpy = vi.spyOn(global, 'Worker');
    
    await farm.init(mockConfig);
    expect(workerSpy).toHaveBeenCalledTimes(2);
    
    // Second redundant init
    await farm.init(mockConfig);
    expect(workerSpy).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should handle simultaneous identical init calls', async () => {
    const farm = createPiperWorkerFarm();
    const workerSpy = vi.spyOn(global, 'Worker');
    
    // Fire two inits at once
    const p1 = farm.init(mockConfig);
    const p2 = farm.init(mockConfig);
    
    await Promise.all([p1, p2]);
    
    // Should ONLY have spawned 2 workers total, not 4
    expect(workerSpy).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should reuse workers during surgical reinit (callback only)', async () => {
    const farm = createPiperWorkerFarm();
    const workerSpy = vi.spyOn(global, 'Worker');
    
    await farm.init(mockConfig);
    const workerInstances = workerSpy.mock.results.map(r => r.value);
    const firstWorker0 = workerInstances[0];
    
    // Surgical reinit (callback change)
    // Pass partial config with undefined to test removeUndefined resilience
    await farm.reinit({ 
      callbackModule: { path: 'new-path', functionName: 'new-fn' },
      voiceId: mockConfig.voiceId,
      modelId: mockConfig.modelId
    });
    
    // Verify load-callback was sent to existing worker
    expect(firstWorker0.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'load-callback',
      modulePath: 'new-path'
    }));
    
    // Verify NO new workers were spawned
    expect(workerSpy).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });

  it('should perform hotswap during full reinit (model change)', async () => {
    const farm = createPiperWorkerFarm();
    const workerSpy = vi.spyOn(global, 'Worker');
    
    await farm.init(mockConfig);
    expect(workerSpy).toHaveBeenCalledTimes(2);

    // Full reinit (model change)
    await farm.reinit({ 
      modelId: 'new-model',
      voiceId: mockConfig.voiceId
    });
    
    // Total workers spawned should be 4 (2 initial + 2 shadow)
    expect(workerSpy).toHaveBeenCalledTimes(4);
    expect(farm.getActiveModelId()).toBe('new-model');
    
    farm.terminate();
  });
});
