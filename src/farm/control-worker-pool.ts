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
  const keys = Object.keys(result) as Array<keyof T>;
  keys.forEach(key => {
    if (result[key] === undefined) {
      delete result[key];
    }
  });
  return result;
}

function isConfigSame(a: PiperWorkerConfig, b: PiperWorkerConfig): boolean {
  return a.modelId === b.modelId && 
         a.defaultSpeakerId === b.defaultSpeakerId &&
         a.useCallback === b.useCallback;
}

function isSurgicalCandidate(oldConfig: PiperWorkerConfig, newConfig: PiperWorkerConfig): boolean {
  // Candidate for surgical update if ONLY useCallback or defaultSpeakerId changed
  // (Both are lightweight worker-side state updates)
  const isCoreSame = oldConfig.modelId === newConfig.modelId;
  
  if (!isCoreSame) return false;

  const isCallbackChanged = oldConfig.useCallback !== newConfig.useCallback;
  const isSpeakerChanged = oldConfig.defaultSpeakerId !== newConfig.defaultSpeakerId;

  return isCallbackChanged || isSpeakerChanged;
}
export function createWorkerPool(
  onReady: (id: number) => void, 
  onResult: (msg: PiperWorkerMessageOut) => void,
  onLog: (log: WorkerLogPayload) => void
) {
  let workers: WorkerState[] = [];
  let nextWorkerId = 0;
  let poolTargetCounter = 0;
  let isInitialized = false;
  let activeModelId: string | null = null;
  let targetModelId: string | null = null;
  let targetSpeakerId: number = 0;
  let currentConfig: PiperWorkerConfig | null = null;
  let pendingTransition: { abort: () => void; shadowPool: WorkerState[] } | null = null;
  let activeInit: Promise<void> | null = null;

  const removeWorker = (id: number) => {
    const index = workers.findIndex(w => w.id === id);
    if (index !== -1) {
      workers.splice(index, 1);
    }
  };

  return {
    async init(config: PiperWorkerConfig, count: number) {
      if (activeInit) return activeInit;

      // If already initialized, delegate to reinit for any state changes (config or count)
      // to ensure a clean atomic transition (Shadow Pool) instead of leaking workers.
      if (isInitialized && currentConfig) {
        if (!isConfigSame(currentConfig, config) || workers.length !== count) {
          return this.reinit(config, count);
        }
        return;
      }

      activeInit = (async () => {
        try {

          currentConfig = config;
          activeModelId = config.modelId;
          targetModelId = config.modelId;
          targetSpeakerId = config.defaultSpeakerId || 0;
          isInitialized = true;
          poolTargetCounter++;

          const initPromises = [];
          for (let i = 0; i < count; i++) {
            const id = nextWorkerId++;
            const worker = createWorker(id, config, poolTargetCounter, (msg) => {
              if (msg.type === 'ready') onReady(msg.instanceId);
              else onResult(msg);
            }, onLog, removeWorker);
            
            // Mark as transitioning to prevent getNextAvailable from picking it up
            // until the WASM module is fully ready.
            worker.transitioning = true;
            workers.push(worker);

            initPromises.push(new Promise<void>((res, rej) => {
              const handler = (e: MessageEvent<PiperWorkerMessageOut>) => {
                const msg = e.data;
                if (msg.type === 'log') return;
                if (msg.instanceId !== id) return;
                
                if (msg.type === 'ready') {
                  worker.transitioning = false;
                  cleanup(res);
                }
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
     * Re-initializes the pool using a Shadow Pool pattern with transition abort.
     *
     * If a previous transition is still in-flight (shadow pool initializing),
     * it is immediately aborted and its workers terminated to prevent
     * WebAssembly memory exhaustion during rapid model switching.
     *
     * @throws {DOMException} AbortError if this transition is superseded by a newer one.
     */
    async reinit(config: Partial<PiperWorkerConfig>, count?: number) {
      if (!currentConfig) throw new Error("Pool not initialized");
      
      const normalizedPartial = removeUndefined(config);
      const newConfig = { ...currentConfig, ...normalizedPartial } as PiperWorkerConfig;

      // 1. Idempotency Check: Skip if requested config and count are identical to current
      if (isConfigSame(currentConfig, newConfig) && (count === undefined || workers.length === count)) {
        targetModelId = newConfig.modelId; // Ensure target is synced
        targetSpeakerId = newConfig.defaultSpeakerId || 0;
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

      // Optimistic Target Update: New requests added to the queue during 
      // the transition should use the NEW target model and speaker.
      targetModelId = newConfig.modelId;
      targetSpeakerId = newConfig.defaultSpeakerId || 0;

      // 3. Path A: Surgical Bypass for callback-only updates
      if (isSurgicalCandidate(currentConfig, newConfig)) {
        onLog({
          level: 'info',
          message: `[WorkerPool] Choosing Path A (Surgical): Reusing workers for callback update.`,
          workerId: -1,
          timestamp: Date.now()
        });

        
        
        poolTargetCounter++;
        workers.forEach(w => {
          w.targetCounter = poolTargetCounter;
          w.worker.postMessage({
            type: "load-callback",
            useCallback: newConfig.useCallback || false,
            configCounter: poolTargetCounter
          });
        });
        currentConfig = newConfig;
        return;
      }

      // 4. Path B: Full Hotswap (Shadow Pool) for core asset changes, resizing, or Path A recovery
      onLog({
        level: 'info',
        message: `[WorkerPool] Choosing Path B (Hotswap): Configuration or size mismatch detected. Spawning shadow pool...`,
        workerId: -1,
        timestamp: Date.now()
      });
      poolTargetCounter++;
      targetModelId = newConfig.modelId;
      const finalCount = count ?? workers.length;
      const shadowPool: WorkerState[] = [];
      const abortController = new AbortController();

      // 2. Register this transition so future reinit() calls can abort it
      pendingTransition = {
        abort: () => abortController.abort(),
        shadowPool
      };

      // Spawn Shadow Pool
      const initPromises = [];
      for (let i = 0; i < finalCount; i++) {
        if (abortController.signal.aborted) break;
        const id = nextWorkerId++;
        const worker = createWorker(id, newConfig, poolTargetCounter, (msg) => {
          if (msg.type === 'ready') onReady(msg.instanceId);
          else onResult(msg);
        }, onLog, removeWorker);
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
          const abortHandler = () => cleanup(() => rej(new DOMException("Transition superseded by newer request", "AbortError")));

          const cleanup = (cb: () => void) => {
            worker.worker.removeEventListener('message', handler);
            worker.worker.removeEventListener('error', errHandler);
            abortController.signal.removeEventListener('abort', abortHandler);
            cb();
          };

          worker.worker.addEventListener('message', handler);
          worker.worker.addEventListener('error', errHandler);
          abortController.signal.addEventListener('abort', abortHandler);
        }));
      }

      // Wait for Shadow Pool to be READY
      try {
        await Promise.all(initPromises);
      } catch (e: any) {
        if (e.name === 'AbortError') {
          // Expected rejection when superseded
        } else {
          throw e;
        }
      }

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
      const replacement = createWorker(newId, currentConfig, poolTargetCounter, (msg) => {
        if (msg.type === 'ready') {
          // 3. Clear transitioning flag when WASM is loaded and ready
          replacement.transitioning = false;
          onReady(msg.instanceId);
        } else {
          onResult(msg);
        }
      }, onLog, removeWorker);
      replacement.transitioning = true;

      // 4. Swap into the same array position to maintain pool size
      workers[idx] = replacement;
    },

    getNextAvailable(): WorkerState | null {
      return workers.find(w => !w.busy && !w.transitioning && w.activeCounter === poolTargetCounter) || null;
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
    getWorkers: () => workers,

    /**
     * Physically removes a worker from the pool.
     * Used when a worker crashes to ensure the farm shrinks deterministically.
     */
    removeWorker
  };
}

function createWorker(
  id: number, 
  config: PiperWorkerConfig, 
  targetCounter: number,
  onMessage: (msg: PiperWorkerMessageOut) => void,
  onLog: (log: WorkerLogPayload) => void,
  onCrash: (id: number) => void
): WorkerState {
  // Use Vite-safe worker instantiation if possible, otherwise use new URL
  const worker = new Worker('/piper-gate/infra/process-piper-synthesis.worker.js', {
    type: "module",
    /* @vite-ignore */
    name: `PiperWorker-${id}`
  });

  const state: WorkerState = { id, worker, busy: false, transitioning: false, activeCounter: -1, targetCounter, modelId: config.modelId };

  worker.onmessage = (e: MessageEvent<PiperWorkerMessageOut>) => {
    const msg = e.data;
    if ('configCounter' in msg) {
      state.activeCounter = msg.configCounter;
    }
    
    if (msg.type === 'log') {
      onLog(msg.payload);
    } else {
      onMessage(msg);
    }
  };
  worker.onerror = (e) => {
    let errorMessage = "Worker crashed unexpectedly";
    if (e instanceof ErrorEvent) {
      errorMessage = e.message || `Runtime error in ${e.filename}:${e.lineno}`;
    } else {
      errorMessage = "Worker failed to initialize or load (possible MIME mismatch or Network Error)";
    }
    console.error(`[WorkerPool] [Worker Error] Instance ${id}: ${errorMessage}`, e);
    
    // Physically terminate and remove before notifying the orchestrator
    worker.terminate();
    onCrash(id);
    
    onMessage({ type: "error", instanceId: id, error: errorMessage });
  };

  console.log(`[WorkerPool] Spawning worker ${id} with useCallback:`, config.useCallback || false);
  
  // SCRUB CONFIG: Ensure no functions (like onProgress) are sent to worker (DataCloneError)
  const workerConfig = {
    modelId: config.modelId,
    instanceId: id,
    useCallback: config.useCallback,
    defaultSpeakerId: config.defaultSpeakerId
  };

  worker.postMessage({ type: "init", config: workerConfig, configCounter: targetCounter });

  return state;
}
