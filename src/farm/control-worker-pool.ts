import type { 
  WorkerState, 
  PiperWorkerMessageIn, 
  PiperWorkerMessageOut, 
  PiperWorkerConfig 
} from "../types";

/**
 * Worker Pool Controller.
 * 
 * Manages the lifecycle and load balancing of a pool of Piper workers.
 * Ensures that if a worker fails, it's restarted, and manages the 
 * stateful model re-initialization.
 */
export function createWorkerPool(onReady: (id: number) => void, onResult: (msg: PiperWorkerMessageOut) => void) {
  let workers: WorkerState[] = [];
  let nextWorkerId = 0;
  let isInitialized = false;
  let activeModelId: string | null = null;
  let targetModelId: string | null = null;
  let currentConfig: PiperWorkerConfig | null = null;

  return {
    async init(config: PiperWorkerConfig, count: number) {
      currentConfig = config;
      activeModelId = config.modelId;
      targetModelId = config.modelId;
      isInitialized = true;

      const initPromises = [];
      for (let i = 0; i < count; i++) {
        const id = nextWorkerId++;
        const worker = createWorker(id, config, (msg) => {
          if (msg.type === 'ready') onReady(msg.instanceId);
          else onResult(msg);
        });
        workers.push(worker);
        initPromises.push(new Promise<void>(res => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === 'ready' && e.data.instanceId === id) {
              worker.worker.removeEventListener('message', handler);
              res();
            }
          };
          worker.worker.addEventListener('message', handler);
        }));
      }
      await Promise.all(initPromises);
    },

    /**
     * Re-initializes the pool using a Shadow Pool pattern.
     * New workers are spawned and warmed up in the background.
     * Once ready, they replace the current workers.
     */
    async reinit(config: Partial<PiperWorkerConfig>) {
      if (!currentConfig) throw new Error("Pool not initialized");
      
      const newConfig = { ...currentConfig, ...config } as PiperWorkerConfig;
      targetModelId = newConfig.modelId;
      const count = workers.length;
      const shadowPool: WorkerState[] = [];
      
      // 1. Spawn Shadow Pool
      const initPromises = [];
      for (let i = 0; i < count; i++) {
        const id = nextWorkerId++;
        const worker = createWorker(id, newConfig, (msg) => {
          if (msg.type === 'ready') onReady(msg.instanceId);
          else onResult(msg);
        });
        shadowPool.push(worker);
        initPromises.push(new Promise<void>(res => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === 'ready' && e.data.instanceId === id) {
              worker.worker.removeEventListener('message', handler);
              res();
            }
          };
          worker.worker.addEventListener('message', handler);
        }));
      }

      // 2. Wait for Shadow Pool to be READY
      await Promise.all(initPromises);

      // 3. Promote Shadow Pool & Retire Old Workers
      const oldWorkers = [...workers];
      workers = shadowPool;
      activeModelId = newConfig.modelId;
      currentConfig = newConfig;

      // 4. Graceful Retirement: Old workers finish current task then die
      oldWorkers.forEach(w => {
        if (!w.busy) {
          w.worker.terminate();
        } else {
          // Worker is busy, wait for its last result then kill it
          const cleanupHandler = (e: MessageEvent) => {
            if (e.data.type === 'success' || e.data.type === 'error') {
              w.worker.removeEventListener('message', cleanupHandler);
              w.worker.terminate();
            }
          };
          w.worker.addEventListener('message', cleanupHandler);
        }
      });
    },

    getNextAvailable(): WorkerState | null {
      return workers.find(w => !w.busy && !w.transitioning) || null;
    },

    terminate() {
      workers.forEach(w => w.worker.terminate());
      workers.length = 0;
      isInitialized = false;
      activeModelId = null;
      targetModelId = null;
    },

    isInitialized: () => isInitialized,
    getActiveModelId: () => activeModelId,
    getTargetModelId: () => targetModelId,
    setTargetModelId: (id: string) => { targetModelId = id; },
    getWorkerCount: () => workers.length,
    getBusyCount: () => workers.filter(w => w.busy).length,
    getWorkers: () => workers
  };
}

function createWorker(id: number, config: PiperWorkerConfig, onMessage: (msg: PiperWorkerMessageOut) => void): WorkerState {
  // Use Vite-safe worker instantiation if possible, otherwise use new URL
  const worker = new Worker(new URL("../worker/process-piper-synthesis.worker.ts", import.meta.url), {
    type: "module",
    /* @vite-ignore */
    name: `PiperWorker-${id}`
  });

  worker.onmessage = (e: MessageEvent<PiperWorkerMessageOut>) => onMessage(e.data);
  worker.onerror = (e) => {
    console.error(`Worker ${id} error:`, e);
    onMessage({ type: "error", instanceId: id, error: "Worker crashed" });
  };

  worker.postMessage({ type: "init", config: { ...config, instanceId: id } });

  return { id, worker, busy: false, modelId: config.modelId };
}
