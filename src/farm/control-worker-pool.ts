import type { 
  WorkerState, 
  PiperWorkerMessageIn, 
  PiperWorkerMessageOut, 
  PiperWorkerConfig,
  WorkerLogPayload
} from "../types";

/**
 * Worker Pool Controller.
 * 
 * Manages the lifecycle and load balancing of a pool of Piper workers.
 * Ensures that if a worker fails, it's restarted, and manages the 
 * stateful model re-initialization.
 */

function removeUndefined<T extends object>(obj: T): T {
  const result = { ...obj };
  Object.keys(result).forEach(key => {
    if ((result as any)[key] === undefined) {
      delete (result as any)[key];
    }
  });
  return result;
}

function isConfigSame(a: PiperWorkerConfig, b: PiperWorkerConfig): boolean {
  return a.modelId === b.modelId && 
         a.voiceId === b.voiceId && 
         JSON.stringify(a.onnxRuntimePaths) === JSON.stringify(b.onnxRuntimePaths) &&
         JSON.stringify(a.piperPaths) === JSON.stringify(b.piperPaths) &&
         JSON.stringify(a.callbackModule) === JSON.stringify(b.callbackModule);
}

function isSurgicalCandidate(oldConfig: PiperWorkerConfig, newConfig: PiperWorkerConfig): boolean {
  // Candidate for surgical update if ONLY callbackModule changed
  return oldConfig.modelId === newConfig.modelId &&
         oldConfig.voiceId === newConfig.voiceId &&
         JSON.stringify(oldConfig.onnxRuntimePaths) === JSON.stringify(newConfig.onnxRuntimePaths) &&
         JSON.stringify(oldConfig.piperPaths) === JSON.stringify(newConfig.piperPaths) &&
         JSON.stringify(oldConfig.callbackModule) !== JSON.stringify(newConfig.callbackModule);
}
export function createWorkerPool(
  onReady: (id: number) => void, 
  onResult: (msg: PiperWorkerMessageOut) => void,
  onLog: (log: WorkerLogPayload) => void
) {
  let workers: WorkerState[] = [];
  let nextWorkerId = 0;
  let isInitialized = false;
  let activeModelId: string | null = null;
  let targetModelId: string | null = null;
  let targetSpeakerId: number = 0;
  let currentConfig: PiperWorkerConfig | null = null;
  let pendingTransition: { abort: () => void; shadowPool: WorkerState[] } | null = null;
  let activeInit: Promise<void> | null = null;

  return {
    async init(config: PiperWorkerConfig, count: number) {
      if (activeInit) return activeInit;

      activeInit = (async () => {
        try {
          if (isInitialized && currentConfig && isConfigSame(currentConfig, config) && workers.length === count) {
            return;
          }

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
            }, onLog);
            workers.push(worker);
            initPromises.push(new Promise<void>((res, rej) => {
              const handler = (e: MessageEvent<PiperWorkerMessageOut>) => {
                const msg = e.data;
                if (msg.type === 'log') return;
                if (msg.instanceId !== id) return;
                
                if (msg.type === 'ready') cleanup(res);
                else if (msg.type === 'error') cleanup(() => rej(new Error(`Worker ${id} failed to initialize: ${msg.error}`)));
              };
              const errHandler = (e: ErrorEvent) => cleanup(() => rej(new Error(`Worker ${id} crashed during initialization`)));
              
              const cleanup = (cb: () => void) => {
                worker.worker.removeEventListener('message', handler);
                worker.worker.removeEventListener('error', errHandler);
                cb();
              };

              worker.worker.addEventListener('message', handler);
              worker.worker.addEventListener('error', errHandler);
            }));
          }
          await Promise.all(initPromises);
        } finally {
          activeInit = null;
        }
      })();

      return activeInit;
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
      
      const normalizedPartial = removeUndefined(config);
      const newConfig = { ...currentConfig, ...normalizedPartial } as PiperWorkerConfig;

      // 1. Idempotency Check: Skip if requested config is identical to current
      if (isConfigSame(currentConfig, newConfig)) {
        targetModelId = newConfig.modelId; // Ensure target is synced
        onLog({
          level: 'info',
          message: `[WorkerPool] Idempotent reinit detected for model: ${newConfig.modelId}. Skipping.`,
          workerId: -1,
          timestamp: Date.now()
        });
        return;
      }

      // 2. Abort any pending transition (supersede intermediate pools)
      if (pendingTransition) {
        pendingTransition.abort();
        pendingTransition.shadowPool.forEach(w => w.worker.terminate());
        pendingTransition = null;
      }

      // 3. Path A: Surgical Bypass for callback-only updates
      if (isSurgicalCandidate(currentConfig, newConfig)) {
        onLog({
          level: 'info',
          message: `[WorkerPool] Choosing Path A (Surgical): Reusing workers for callback update.`,
          workerId: -1,
          timestamp: Date.now()
        });
        workers.forEach(w => {
          w.worker.postMessage({
            type: "load-callback",
            modulePath: newConfig.callbackModule!.path,
            functionName: newConfig.callbackModule!.functionName
          });
        });
        currentConfig = newConfig;
        return;
      }

      // 4. Path B: Full Hotswap (Shadow Pool) for core asset changes
      onLog({
        level: 'info',
        message: `[WorkerPool] Choosing Path B (Hotswap): Configuration mismatch detected. Spawning shadow pool...`,
        workerId: -1,
        timestamp: Date.now()
      });
      targetModelId = newConfig.modelId;
      const count = workers.length;
      const shadowPool: WorkerState[] = [];
      const abortController = new AbortController();

      // 2. Register this transition so future reinit() calls can abort it
      pendingTransition = {
        abort: () => abortController.abort(),
        shadowPool
      };

      // Spawn Shadow Pool
      const initPromises = [];
      for (let i = 0; i < count; i++) {
        if (abortController.signal.aborted) break;
        const id = nextWorkerId++;
        const worker = createWorker(id, newConfig, (msg) => {
          if (msg.type === 'ready') onReady(msg.instanceId);
          else onResult(msg);
        }, onLog);
        shadowPool.push(worker);
        initPromises.push(new Promise<void>((res, rej) => {
          const handler = (e: MessageEvent<PiperWorkerMessageOut>) => {
            const msg = e.data;
            if (msg.type === 'log') return;
            if (msg.instanceId !== id) return;
            
            if (msg.type === 'ready') cleanup(res);
            else if (msg.type === 'error') cleanup(() => rej(new Error(`Worker ${id} failed to initialize: ${msg.error}`)));
          };
          const errHandler = (e: ErrorEvent) => cleanup(() => rej(new Error(`Worker ${id} crashed during initialization`)));

          const cleanup = (cb: () => void) => {
            worker.worker.removeEventListener('message', handler);
            worker.worker.removeEventListener('error', errHandler);
            cb();
          };

          worker.worker.addEventListener('message', handler);
          worker.worker.addEventListener('error', errHandler);
        }));
      }

      // Wait for Shadow Pool to be READY
      await Promise.all(initPromises);

      // Check if this transition was superseded by a newer reinit() call
      if (abortController.signal.aborted) {
        shadowPool.forEach(w => w.worker.terminate());
        throw new DOMException("Transition superseded by newer request", "AbortError");
      }

      // Promote Shadow Pool & Retire Old Workers
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
      }, onLog);
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

function createWorker(
  id: number, 
  config: PiperWorkerConfig, 
  onMessage: (msg: PiperWorkerMessageOut) => void,
  onLog: (log: WorkerLogPayload) => void
): WorkerState {
  // Use Vite-safe worker instantiation if possible, otherwise use new URL
  const worker = new Worker(new URL("../worker/process-piper-synthesis.worker.ts", import.meta.url), {
    type: "module",
    /* @vite-ignore */
    name: `PiperWorker-${id}`
  });

  worker.onmessage = (e: MessageEvent<PiperWorkerMessageOut>) => {
    if (e.data.type === 'log') {
      onLog(e.data.payload);
    } else {
      onMessage(e.data);
    }
  };
  worker.onerror = (e) => {
    console.error(`Worker ${id} error:`, e);
    onMessage({ type: "error", instanceId: id, error: "Worker crashed" });
  };

  console.log(`[WorkerPool] Spawning worker ${id} with callback:`, config.callbackModule?.path);
  worker.postMessage({ type: "init", config: { ...config, instanceId: id } });

  return { id, worker, busy: false, modelId: config.modelId };
}
