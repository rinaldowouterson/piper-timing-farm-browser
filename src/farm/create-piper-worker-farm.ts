import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  PendingRequest, 
  PiperWorkerMessageOut,
  RequestStatusPayload,
  WorkerLogPayload,
  PiperWorkerConfig
} from "../types";
import { createWorkerPool } from "./control-worker-pool";
import { clearModelCache, clearInfraCache } from "../utils/resolve-cache-clearing";
import { transformPendingQueue } from "../utils/process-queue-transform";


// ---------------------------------------------------------------------------
// Piper Worker Farm Orchestrator
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker Farm Implementation
// ---------------------------------------------------------------------------

/**
 * Creates the Piper worker farm.
 * 
 * Logic:
 * 1. Tracks multiple workers and distributes synthesis requests.
 * 2. Implements a Parallel FIFO queue for deterministic synthesis order.
 * 3. Supports live model re-initialization (reinit).
 */
export function createPiperWorkerFarm(options?: { debug?: boolean }): PiperWorkerFarm {
  const queue: PendingRequest[] = [];
  /** Maps requestId → worker id for actively processing requests. */
  const activeRequests = new Map<string, number>();
  const listeners = new Set<(status: RequestStatusPayload) => void>();
  const logListeners = new Set<(log: WorkerLogPayload) => void>();
  const pool = createWorkerPool(onReady, onResult, onLogMessage);
  const debug = options?.debug ?? false;

  function emit(payload: RequestStatusPayload) {
    listeners.forEach(l => l(payload));
  }

  function onLogMessage(payload: WorkerLogPayload) {
    logListeners.forEach(l => l(payload));
  }

  function onReady(_id: number) {
    // console.log(`Worker ${id} ready, checking queue...`);
    processQueue();
  }

  function onResult(msg: PiperWorkerMessageOut) {
    if (msg.type === 'success') {
      const { requestId, instanceId, result, callbackResult } = msg;

      // 1. Free the worker
      const worker = pool.getWorkers().find(w => w.id === instanceId);
      if (worker) worker.busy = false;

      // 2. Clear processing status
      activeRequests.delete(requestId);

      // 3. Update sequencer
      const pending = queue.find(r => r.requestId === requestId);
      if (pending) {
        emit({ requestId, text: pending.text, state: 'completed', modelId: pool.getActiveModelId() || undefined });
        pending.result = { ...result, requestId, callbackResult };
        processQueue();
      } else {
        // Request was logically aborted and removed from queue, but worker is now free.
        processQueue();
      }
    } else if (msg.type === 'error') {
      const { instanceId, error, originalRequest } = msg;
      if (debug) console.error(`Worker ${instanceId} error:`, error);
      
      // Determine if this was a physical crash (worker already purged by pool) or logical error
      const worker = pool.getWorkers().find(w => w.id === instanceId);
      const isPhysicalCrash = !worker;

      if (worker) worker.busy = false;

      // Map physical crash back to the active request it was processing
      let activeRequestId: string | undefined;
      for (const [reqId, wId] of activeRequests.entries()) {
        if (wId === instanceId) {
          activeRequestId = reqId;
          break;
        }
      }

      const requestId = (originalRequest && originalRequest.type === 'synthesize') 
        ? originalRequest.requestId 
        : activeRequestId;

      if (requestId) {
        const pending = queue.find(r => r.requestId === requestId);

        if (pending) {
          activeRequests.delete(requestId);

          if (isPhysicalCrash) {
            // Task Retry Logic:
            // If a worker crashes, the task is retried once on a different worker instance.
            // If it crashes a second time, the task is rejected to prevent recursive failures.
            pending.crashCount = (pending.crashCount || 0) + 1;

            if (pending.crashCount >= 2) {
              emit({ 
                requestId: pending.requestId, 
                text: pending.text, 
                state: 'error', 
                modelId: pool.getActiveModelId() || undefined,
                error: `Worker Termination (Retry Exhausted): ${error}` 
              });
              pending.reject(new Error(`Worker Termination (Retry Exhausted): ${error}`));
              queue.splice(queue.indexOf(pending), 1);
            } else {
              if (debug) console.warn(`[Farm] Worker ${instanceId} terminated during task ${requestId}. Retrying on next available worker.`);
              // Note: We don't splice from queue, so processQueue() will pick it up again
            }
          } else {
            // LOGICAL ERROR: Worker is still alive. Reject the task immediately.
            emit({ 
              requestId: pending.requestId, 
              text: pending.text, 
              state: 'error', 
              modelId: pool.getActiveModelId() || undefined,
              error: error 
            });
            pending.reject(new Error(error));
            queue.splice(queue.indexOf(pending), 1);
          }
        }
      } else {
        // HANDSHAKE / LOG / READY: 
        // Ensure the queue processor runs to pick up new workers or newly-synced workers (Surgical Path A).
        processQueue();
      }
    }
    processQueue();
  }

  function processQueue() {
    // 1. Resolve completed FIFO requests
    while (queue.length > 0 && queue[0].result) {
      const first = queue.shift()!;
      if (first.result) {
        first.resolve(first.result);
      }
    }

    // 2. Sample current pool state
    const activeModel = pool.getActiveModelId();
    const isTransitioning = pool.getTargetModelId() !== activeModel;

    // 3. Find the first task the CURRENT pool is capable of handling
    const nextRequest = queue.find(r => 
      !r.result && 
      !activeRequests.has(r.requestId) && 
      (!isTransitioning || r.modelId === activeModel)
    );

    if (nextRequest && pool.getWorkerCount() === 0) {
      // FARM EXHAUSTION: All workers have crashed.
      emit({ 
        requestId: nextRequest.requestId, 
        text: nextRequest.text, 
        state: 'error', 
        modelId: pool.getActiveModelId() || undefined,
        error: "Farm Exhausted: All workers terminated due to fatal crashes." 
      });
      nextRequest.reject(new Error("Farm Exhausted"));
      queue.splice(queue.indexOf(nextRequest), 1);
      return;
    }

    const worker = pool.getNextAvailable();
    if (nextRequest && worker) {
      worker.busy = true;
      activeRequests.set(nextRequest.requestId, worker.id);
      emit({ requestId: nextRequest.requestId, text: nextRequest.text, state: 'processing', modelId: activeModel || undefined });
      
      worker.worker.postMessage({
        type: 'synthesize',
        text: nextRequest.text,
        requestId: nextRequest.requestId,
        speed: nextRequest.speed,
        volume: nextRequest.volume,
        speakerId: nextRequest.speakerId
      });
    }
  }



  return {
    async init(config: FarmConfig) {
      const piperConfig: PiperWorkerConfig = {
        modelId: config.modelId,
        useCallback: config.useCallback,
        defaultSpeakerId: config.defaultSpeakerId,
        debug
      };
      const cpuInstances = config.cpuInstances ?? 2;
      await pool.init(piperConfig, cpuInstances);

      // Broadcast debug state to the Service Worker gateway
      const debugChannel = new BroadcastChannel('piper-gate-debug');
      debugChannel.postMessage({ debug });
      debugChannel.close();

      processQueue();
    },

    async reinit(config) {
      // 1. Scrub config to ensure only worker-relevant properties are passed to the pool
      // This prevents onProgress functions from leaking into postMessage calls
      const workerConfig: Partial<PiperWorkerConfig> = {};
      
      if (config.modelId) workerConfig.modelId = config.modelId;
      if (config.useCallback !== undefined) workerConfig.useCallback = config.useCallback;
      if (config.defaultSpeakerId !== undefined) workerConfig.defaultSpeakerId = config.defaultSpeakerId;
      workerConfig.debug = debug;

      await pool.reinit(workerConfig, config.cpuInstances);

      // 2. Handover Scrubbing (Double-Gated Validation)
      // Ensure that all requests remaining in the queue are compatible with 
      // the new model's speaker limits before they are dispatched.
      const targetModelId = pool.getTargetModelId();
      if (targetModelId) {
        const numSpeakers = config.numSpeakers ?? 1;

        const pending = queue.filter(r => !activeRequests.has(r.requestId));
        transformPendingQueue(pending, {}, { numSpeakers });
      }

      processQueue();
    },

    updatePendingOptions(options, constraints) {
      const numSpeakers = constraints?.numSpeakers ?? 1;

      // Apply transformation to the waiting buffer
      const pending = queue.filter(r => !activeRequests.has(r.requestId));
      transformPendingQueue(pending, options, { numSpeakers });
    },

    prepareTransition(targetModelId: string) {
      pool.setTargetModelId(targetModelId);
    },

    synthesize(text, options = {}) {
      return new Promise((resolve, reject) => {
        const requestId = options.requestId || crypto.randomUUID();
        const signal = options.signal;

        if (signal?.aborted) {
          return reject(new DOMException(signal.reason || 'Synthesis cancelled', 'AbortError'));
        }

        const farm = this;
        function onAbort() {
          farm.cancelSynthesis(requestId);
          signal?.removeEventListener('abort', onAbort);
        }

        if (signal) {
          signal.addEventListener('abort', onAbort);
        }

        queue.push({
          requestId,
          text,
          speed: options.speed ?? 1.0,
          volume: options.volume ?? 1.0,
          speakerId: options.speakerId ?? pool.getTargetSpeakerId(),
          modelId: pool.getTargetModelId() ?? undefined,
          resolve: (res) => {
            activeRequests.delete(requestId);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(res);
          },
          reject: (err) => {
            activeRequests.delete(requestId);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
          }
        });
        emit({ requestId, text, state: 'queued', modelId: pool.getTargetModelId() || undefined });
        processQueue();
      });
    },

    cancelSynthesis(requestId: string) {
      const idx = queue.findIndex(r => r.requestId === requestId);
      if (idx === -1) return;

      const req = queue[idx];
      const workerId = activeRequests.get(requestId);
      queue.splice(idx, 1);
      activeRequests.delete(requestId);
      emit({ requestId, text: req.text, state: 'cancelled', modelId: pool.getActiveModelId() || undefined });
      req.reject(new DOMException('Synthesis cancelled', 'AbortError'));

      // If the request was actively being processed by a worker,
      // forcefully terminate that worker to halt the WASM execution
      // and spawn a fresh replacement (self-healing).
      if (workerId !== undefined) {
        pool.replaceWorker(workerId);
      }
    },

    cancelAllSynthesis() {
      // Snapshot active worker IDs before clearing state
      const activeWorkerIds = [...activeRequests.values()];
      const allReqs = [...queue];
      queue.length = 0;
      activeRequests.clear();

      // Reject all queued promises
      for (const req of allReqs) {
        emit({ requestId: req.requestId, text: req.text, state: 'cancelled', modelId: pool.getActiveModelId() || undefined });
        req.reject(new DOMException('Synthesis cancelled', 'AbortError'));
      }

      // Forcefully terminate and replace all workers that were mid-synthesis
      for (const workerId of activeWorkerIds) {
        pool.replaceWorker(workerId);
      }
    },

    terminate() {
      pool.terminate();
      queue.length = 0;
      activeRequests.clear();
    },

    async clearPiperModelCache() {
      // 1. Force release all OPFS locks by killing workers
      pool.terminate();
      queue.length = 0;
      activeRequests.clear();

      // 2. Perform the nuke
      await clearModelCache();
    },

    async clearPiperInfraCache() {
      // 1. Force release all OPFS locks by killing workers
      pool.terminate();
      queue.length = 0;
      activeRequests.clear();

      // 2. Perform the nuke
      await clearInfraCache();
    },

    isInitialized: () => pool.isInitialized(),
    getActiveModelId: () => pool.getActiveModelId(),

    get metrics() {
      return {
        queueLength: queue.length,
        busyWorkers: pool.getBusyCount(),
        totalWorkers: pool.getWorkerCount()
      };
    },
    
    onQueueStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    }
  };
}
