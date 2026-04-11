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
  let targetSpeakerId: number = 0;
  let currentConfig: PiperWorkerConfig | null = null;
  let pendingTransition: { abort: () => void; shadowPool: WorkerState[] } | null = null;

  return {
    async init(config: PiperWorkerConfig, count: number) {
      currentConfig = config;
      activeModelId = config.modelId;
      targetModelId = config.modelId;
      targetSpeakerId = 0;
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
     * Re-initializes the pool using a Shadow Pool pattern with Atomic Supersession.
     *
     * If a previous transition is still in-flight (shadow pool initializing),
     * it is immediately aborted and its workers terminated to prevent
     * WebAssembly memory exhaustion during rapid model switching.
     *
     * @throws {DOMException} AbortError if this transition is superseded by a newer one.
     */
    async reinit(config: Partial<PiperWorkerConfig>) {
      if (!currentConfig) throw new Error("Pool not initialized");

      // 1. Abort any pending transition (supersede intermediate pools)
      if (pendingTransition) {
        pendingTransition.abort();
        pendingTransition.shadowPool.forEach(w => w.worker.terminate());
        pendingTransition = null;
      }

      const newConfig = { ...currentConfig, ...config } as PiperWorkerConfig;
      targetModelId = newConfig.modelId;
      const count = workers.length;
      const shadowPool: WorkerState[] = [];
      const abortController = new AbortController();

      // 2. Register this transition so future reinit() calls can abort it
      pendingTransition = {
        abort: () => abortController.abort(),
        shadowPool
      };

      // 3. Spawn Shadow Pool
      const initPromises = [];
      for (let i = 0; i < count; i++) {
        if (abortController.signal.aborted) break;
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

      // 4. Wait for Shadow Pool to be READY
      await Promise.all(initPromises);

      // 5. Check if this transition was superseded by a newer reinit() call
      if (abortController.signal.aborted) {
        shadowPool.forEach(w => w.worker.terminate());
        throw new DOMException("Transition superseded by newer request", "AbortError");
      }

      // 6. Promote Shadow Pool & Retire Old Workers
      pendingTransition = null;
      const oldWorkers = [...workers];
      workers = shadowPool;
      activeModelId = newConfig.modelId;
      currentConfig = newConfig;

      // 7. Graceful Retirement: Old workers finish current task then die
      oldWorkers.forEach(w => {
        if (!w.busy) {
          w.worker.terminate();
        } else {
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

    /**
     * Self-healing worker replacement.
     * 
     * Forcefully terminates a specific worker thread (killing any active WASM
     * execution) and spawns a fresh replacement with the current config.
     * The replacement is marked `transitioning` until its `ready` event fires,
     * preventing premature task dispatch.
     * 
     * This is the surgical middle-ground between:
     * - Doing nothing (phantom CPU drain from uninterruptible WASM)
     * - Full Shadow Pool rebuild (reinit — overkill for single-task cancellation)
     */
    replaceWorker(id: number) {
      if (!currentConfig) return;

      const idx = workers.findIndex(w => w.id === id);
      if (idx === -1) return;

      // 1. Forcefully terminate the old worker thread
      workers[idx].worker.terminate();

      // 2. Spawn a fresh replacement with a new unique ID
      const newId = nextWorkerId++;
      const replacement = createWorker(newId, currentConfig, (msg) => {
        if (msg.type === 'ready') {
          // 3. Clear transitioning flag when WASM is loaded and ready
          replacement.transitioning = false;
          onReady(msg.instanceId);
        } else {
          onResult(msg);
        }
      });
      replacement.transitioning = true;

      // 4. Swap into the same array position to maintain pool size
      workers[idx] = replacement;
    },

    getNextAvailable(): WorkerState | null {
      return workers.find(w => !w.busy && !w.transitioning) || null;
    },

    terminate() {
      // Abort any in-flight transition before total shutdown
      if (pendingTransition) {
        pendingTransition.abort();
        pendingTransition.shadowPool.forEach(w => w.worker.terminate());
        pendingTransition = null;
      }
      workers.forEach(w => w.worker.terminate());
      workers.length = 0;
      isInitialized = false;
      activeModelId = null;
      targetModelId = null;
      targetSpeakerId = 0;
    },

    isInitialized: () => isInitialized,
    getActiveModelId: () => activeModelId,
    getTargetModelId: () => targetModelId,
    setTargetModelId: (id: string) => { targetModelId = id; },
    getTargetSpeakerId: () => targetSpeakerId,
    setTargetSpeakerId: (id: number) => { targetSpeakerId = id; },
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
