import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult, 
  PendingRequest, 
  PiperWorkerMessageOut 
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
  const processingRequestIds = new Set<string>();
  const pool = createWorkerPool(onReady, onResult);

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
      processingRequestIds.delete(requestId);

      // 3. Update sequencer
      const pending = queue.find(r => r.requestId === requestId);
      if (pending) {
        pending.result = { ...result, callbackResult };
        processQueue();
      }
    } else if (msg.type === 'error') {
      const { instanceId, error } = msg;
      console.error(`Worker ${instanceId} error:`, error);
      const worker = pool.getWorkers().find(w => w.id === instanceId);
      if (worker) worker.busy = false;
    }
  }

  function processQueue() {
    // 1. Resolve completed FIFO requests
    while (queue.length > 0 && queue[0].result) {
      const first = queue.shift()!;
      first.resolve(first.result as any);
    }

    // 2. Assign pending requests to idle workers
    const nextRequest = queue.find(r => !r.result && !isCurrentlyProcessing(r.requestId));
    if (nextRequest) {
      // Adaptive Handoff: If the pool has completed a transition,
      // un-started requests adopt the new active model and speaker.
      const activeModel = pool.getActiveModelId();
      const targetModel = pool.getTargetModelId();
      const isTransitioning = targetModel !== activeModel;

      if (nextRequest.modelId && nextRequest.modelId !== activeModel) {
        if (isTransitioning) {
          // Pool is still transitioning — wait, don't block
          return;
        }
        // Transition complete: adopt the new active config
        nextRequest.modelId = activeModel ?? undefined;
        nextRequest.speakerId = pool.getTargetSpeakerId();
      }

      const worker = pool.getNextAvailable();
      if (worker) {
        worker.busy = true;
        processingRequestIds.add(nextRequest.requestId);
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
  }

  function isCurrentlyProcessing(requestId: string) {
    return processingRequestIds.has(requestId);
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
        const requestId = crypto.randomUUID();
        queue.push({
          requestId,
          text,
          speed: options.speed ?? 1.0,
          volume: options.volume ?? 1.0,
          speakerId: options.speakerId ?? pool.getTargetSpeakerId(),
          modelId: pool.getTargetModelId() ?? undefined,
          resolve: (res) => {
            processingRequestIds.delete(requestId);
            resolve(res);
          },
          reject: (err) => {
            processingRequestIds.delete(requestId);
            reject(err);
          }
        });
        processQueue();
      });
    },

    terminate() {
      pool.terminate();
      queue.length = 0;
      processingRequestIds.clear();
    },

    async clearPiperModelCache() {
      // 1. Force release all OPFS locks by killing workers
      pool.terminate();
      queue.length = 0;
      processingRequestIds.clear();

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
    }
  };
}
