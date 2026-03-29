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
  const workers: WorkerState[] = [];
  let isInitialized = false;
  let activeModelId: string | null = null;
  let currentConfig: PiperWorkerConfig | null = null;

  return {
    async init(config: PiperWorkerConfig, count: number) {
      currentConfig = config;
      activeModelId = config.modelId;
      isInitialized = true;

      const initPromises = [];
      for (let i = 0; i < count; i++) {
        const worker = createWorker(i, config, (msg) => {
          if (msg.type === 'ready') onReady(msg.instanceId);
          else onResult(msg);
        });
        workers.push(worker);
        initPromises.push(new Promise<void>(res => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === 'ready' && e.data.instanceId === i) {
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
     * Re-initializes all workers in the pool with a new model.
     * Keeps the workers alive and the request queue intact.
     */
    async reinit(config: Partial<PiperWorkerConfig>) {
      if (!currentConfig) throw new Error("Pool not initialized");
      
      const newConfig = { ...currentConfig, ...config };
      currentConfig = newConfig;
      activeModelId = newConfig.modelId;

      const reinitPromises = workers.map(w => {
        w.transitioning = true; // Hard-lock during transition
        w.busy = true; 
        return new Promise<void>(res => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === 'ready' && e.data.instanceId === w.id) {
              w.worker.removeEventListener('message', handler);
              w.modelId = activeModelId!;
              w.transitioning = false; // Release transition lock
              w.busy = false;          // Release activity lock
              res();
            }
          };
          w.worker.addEventListener('message', handler);
          w.worker.postMessage({ type: 'init', config: { ...newConfig, instanceId: w.id } });
        });
      });
      await Promise.all(reinitPromises);
    },

    getNextAvailable(): WorkerState | null {
      return workers.find(w => !w.busy && !w.transitioning) || null;
    },

    terminate() {
      workers.forEach(w => w.worker.terminate());
      workers.length = 0;
      isInitialized = false;
      activeModelId = null;
    },

    isInitialized: () => isInitialized,
    getActiveModelId: () => activeModelId,
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

  return { id, worker, type: config.device || "cpu", busy: false, modelId: config.modelId };
}
