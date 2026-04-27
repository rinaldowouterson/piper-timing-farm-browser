import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult,
  DownloadState,
  RequestStatusPayload,
  WorkerLogPayload
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { createAssetDownloadController } from "../farm/control-asset-download";
import { PIPER_MODELS } from "../expose-piper-models";
import { clearModelCache, deletePiperModel, clearInfraCache } from "../utils/resolve-cache-clearing";
import { setupAssetSW } from "../utils/setup-asset-sw";

/**
 * High-level Piper Provider with stress-test-proof background model switching.
 * 
 * Logic:
 * 1. Tracks current active model.
 * 2. If a new model is requested during active synthesis, it downloads 
 *    and verifies it in the background while the current model continues 
 *    processing the queue.
 * 3. Once fully provisioned, it performs an atomic handoff (reinit).
 * 4. Speaker ID flows per-request without triggering infrastructure changes.
 */
export function createPiperProvider(): Omit<PiperWorkerFarm, 'reinit'> & { 
  getActiveModelId: () => string | null;
  cancelDownload: (modelId: string) => Promise<void>;
  deletePiperModel: (modelId: string) => Promise<void>;
  getDownloadState: () => Map<string, DownloadState>;
  onLog: (listener: (log: WorkerLogPayload) => void) => () => void;
} {
  let farm: PiperWorkerFarm | null = null;
  let activeModelId: string | null = null;
  let activeCallbackPath: string | null = null;
  let activeDefaultSpeakerId: number | undefined = undefined;
  let loadingModelId: string | null = null;
  let lastTransitionId = 0;
  const downloader = createAssetDownloadController();
  const queueListeners = new Set<(status: RequestStatusPayload) => void>();
  const logListeners = new Set<(log: WorkerLogPayload) => void>();
  let farmUnsubscribe: (() => void) | null = null;
  let farmLogUnsubscribe: (() => void) | null = null;
  
  // Early SW Registration: Mandatory in the browser. 
  // If this fails, init() will throw a fatal error to protect integrity.
  let swRegistrationPromise: Promise<ServiceWorkerRegistration | undefined> = Promise.resolve(undefined);
  if (typeof window !== 'undefined') {
    swRegistrationPromise = setupAssetSW();
  }

  return {
    async init(config: FarmConfig) {
      const transitionId = ++lastTransitionId;
      const { modelId, modelUrls, useCallback } = config;

      // 0. Ensure Service Worker is active and controlling the page
      if (typeof window !== 'undefined') {
        await swRegistrationPromise;
      }

      // 1. Ensure asset integrity and cache in OPFS
      const modelEntry = PIPER_MODELS.find(m => m.id === modelId);
      const onnxUrl = modelUrls?.onnx || modelEntry?.modelUrl;
      const jsonUrl = modelUrls?.config || modelEntry?.configUrl;

      if (!onnxUrl || !jsonUrl) throw new Error(`Model urls missing for ${modelId}`);

      loadingModelId = modelId;
      
      // 2. Download & Verify via the sovereign gateway (SW)
      try {
        await downloader.request(
          modelId, 
          { onnx: onnxUrl, config: jsonUrl },
          { 
            onnx: config.modelSha256 || modelEntry?.modelSha256, 
            config: config.configSha256 || modelEntry?.configSha256 
          },
          { onProgress: config.onProgress }
        );
      } catch (err) {
        if (transitionId === lastTransitionId) loadingModelId = null;
        throw err;
      }

      // STALE CHECK: A newer init() was called during download — abandon
      if (transitionId !== lastTransitionId) return;

      // 3. Farm Setup or Hotswap
      // The WorkerPool internally handles Surgical Updates vs Shadow Pool transitions.
      if (!farm) {
        farm = createPiperWorkerFarm();
        farmUnsubscribe = farm.onQueueStatus((status) => queueListeners.forEach(l => l(status)));
        farmLogUnsubscribe = farm.onLog((log) => logListeners.forEach(l => l(log)));
        await farm.init(config);
      } else {
        // If switching models, prepare the transition (queues current model)
        if (activeModelId !== modelId) {
          farm.prepareTransition(modelId);
        }

        try {
          await farm.reinit(config);
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          throw err;
        }
      }

      // Final stale check before committing state
      if (transitionId !== lastTransitionId) return;

      activeModelId = modelId;
      activeCallbackPath = useCallback ? 'piper-callback.js' : null;
      activeDefaultSpeakerId = config.defaultSpeakerId;
      loadingModelId = null;
    },



    prepareTransition(targetModelId: string) {
      farm?.prepareTransition(targetModelId);
    },

    synthesize(text, options) {
      if (!farm) throw new Error("Provider not initialized");
      return farm.synthesize(text, options);
    },

    cancelSynthesis(requestId: string) {
      farm?.cancelSynthesis(requestId);
    },

    cancelAllSynthesis() {
      farm?.cancelAllSynthesis();
    },

    terminate() {
      downloader.cancelAll();
      downloader.destroy();
      farmUnsubscribe?.();
      farmLogUnsubscribe?.();
      farm?.terminate();
      farm = null;
      activeModelId = null;
      loadingModelId = null;
    },

    async clearPiperModelCache() {
      // 1. Terminate active instance first to release OPFS locks
      if (farm) {
        farm.terminate();
        farm = null;
      }
      
      // 2. Wipe storage (safe after handles are closed)
      await clearModelCache();
      
      activeModelId = null;
      loadingModelId = null;
    },

    async clearPiperInfraCache() {
      // 1. Terminate active instance first to release OPFS locks
      if (farm) {
        farm.terminate();
        farm = null;
      }

      // 2. Wipe storage (safe after handles are closed)
      await clearInfraCache();

      activeModelId = null;
      loadingModelId = null;
    },

    isInitialized: () => farm?.isInitialized() ?? false,
    getActiveModelId: () => activeModelId,

    /** Cancel a specific model's in-flight download. Does not touch OPFS. */
    async cancelDownload(modelId: string) {
      await downloader.cancel(modelId);
    },

    /** Delete a specific model's cached OPFS files via the Sovereign Gateway. */
    deletePiperModel,

    /** Returns a snapshot of every model's download lifecycle. */
    getDownloadState() {
      return downloader.getState();
    },

    onQueueStatus(listener) {
      queueListeners.add(listener);
      return () => {
        queueListeners.delete(listener);
      };
    },

    onLog(listener) {
      logListeners.add(listener);
      return () => {
        logListeners.delete(listener);
      };
    },

    get metrics() {
      return farm?.metrics || { queueLength: 0, busyWorkers: 0, totalWorkers: 0 };
    }
  };
}
