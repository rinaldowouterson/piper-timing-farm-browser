import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult, 
  PendingRequest, 
  PiperWorkerMessageOut,
  RequestStatusPayload
} from "../types";
import { createWorkerPool } from "./control-worker-pool";
import { ONNX_ASSET_URLS } from "../worker/resolve-assets-onnxruntime";
import { PIPER_ASSET_URLS } from "../worker/resolve-assets-piper";
import { resolveCacheClearing } from "../utils/resolve-cache-clearing";

/**
 * Creates the high-performance Piper worker farm.
 * 
 * Logic:
 * 1. Tracks multiple workers and distributes synthesis requests.
 * 2. Implements a Parallel FIFO queue for deterministic synthesis order.
 * 3. Supports live model re-initialization (reinit).
 */
export function createPiperWorkerFarm(): PiperWorkerFarm {
  const queue: PendingRequest[] = [];
  /** Maps requestId → worker id for actively processing requests. */
  const activeRequests = new Map<string, number>();
  const listeners = new Set<(status: RequestStatusPayload) => void>();
  const pool = createWorkerPool(onReady, onResult);

  function emit(payload: RequestStatusPayload) {
    listeners.forEach(l => l(payload));
  }

  function onReady(id: number) {
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
      console.error(`Worker ${instanceId} error:`, error);
      const worker = pool.getWorkers().find(w => w.id === instanceId);
      if (worker) worker.busy = false;
      if (originalRequest && originalRequest.type === 'synthesize') {
        const pending = queue.find(r => r.requestId === originalRequest.requestId);
        if (pending) {
          activeRequests.delete(originalRequest.requestId);
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
      processQueue();
    }
  }

  function processQueue() {
    // 1. Resolve completed FIFO requests
    while (queue.length > 0 && queue[0].result) {
      const first = queue.shift()!;
      first.resolve(first.result as any);
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
      // Intelligent Architecture Defaults (Tier 3 FALLBACK)
      const onnxRuntimePaths = config.onnxRuntimePaths || ONNX_ASSET_URLS;
      const piperPaths = config.piperPaths || PIPER_ASSET_URLS;

      const piperConfig = {
        modelId: config.modelId,
        voiceId: config.voiceId,
        onnxRuntimePaths,
        piperPaths,
        callbackModule: config.callbackModule
      };
      const cpuInstances = config.cpuInstances ?? 2;
      await pool.init(piperConfig, cpuInstances);
      processQueue();
    },

    async reinit(config) {
      await pool.reinit(config);
      processQueue();
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
      await resolveCacheClearing();
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
    }
  };
}
