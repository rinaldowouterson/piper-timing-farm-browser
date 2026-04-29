import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        }, 10);
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

describe('Worker Pool Resizing (Option C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should perform hotswap during resize (count increase)', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init(mockConfig);
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);

    // Resize via init (Option C)
    await farm.init({ 
      ...mockConfig,
      cpuInstances: 4
    });
    
    // Total workers spawned should be 6 (2 initial + 4 shadow)
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(6);
    
    // Check pool size is promoted
    expect(farm.metrics.totalWorkers).toBe(4);
    
    farm.terminate();
  });

  it('should perform hotswap during resize (count decrease)', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init({ ...mockConfig, cpuInstances: 4 });
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(4);

    // Resize via init (Option C)
    await farm.init({ 
      ...mockConfig,
      cpuInstances: 2
    });
    
    // Total workers spawned should be 6 (4 initial + 2 shadow)
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(6);
    
    // Check pool size is promoted
    expect(farm.metrics.totalWorkers).toBe(2);
    
    farm.terminate();
  });

  it('should remain idempotent when same count is passed', async () => {
    const farm = createPiperWorkerFarm();
    
    await farm.init(mockConfig);
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);

    // Redundant init with same count
    await farm.init(mockConfig);
    
    // No new workers spawned
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2);
    
    farm.terminate();
  });
});
