import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult,
  DownloadState,
  RequestStatusPayload,
  WorkerLogPayload
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";
import { createAssetDownloadController } from "../farm/control-asset-download";
import { PIPER_MODELS } from "../expose-piper-models";
import { resolveCacheClearing } from "../utils/resolve-cache-clearing";
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
  clearAndRedownloadModel: (modelId: string) => Promise<void>;
  getDownloadState: () => Map<string, DownloadState>;
  onLog: (listener: (log: WorkerLogPayload) => void) => () => void;
} {
  let farm: PiperWorkerFarm | null = null;
  let activeModelId: string | null = null;
  let activeCallbackPath: string | null = null;
  let loadingModelId: string | null = null;
  let lastTransitionId = 0;
  const downloader = createAssetDownloadController();
  const queueListeners = new Set<(status: RequestStatusPayload) => void>();
  const logListeners = new Set<(log: WorkerLogPayload) => void>();
  let farmUnsubscribe: (() => void) | null = null;
  let farmLogUnsubscribe: (() => void) | null = null;

  return {
    async init(config: FarmConfig) {
      const transitionId = ++lastTransitionId;
      const { modelId, modelUrls, callbackModule } = config;

      // Ensure the asset-intercepting Service Worker is registered before
      // any /assets/* requests are issued. Non-fatal if SW is unsupported.
      if (typeof window !== 'undefined') {
        try {
          await setupAssetSW();
        } catch {
          console.warn('[PiperProvider] Asset SW registration failed — falling back to direct asset URLs');
        }
      }

      // 1. Initial configuration check
      const isSameModel = activeModelId === modelId;
      const isSameCallback = activeCallbackPath === (callbackModule?.path || null);

      // If already initialized and configuration matches perfectly, skip
      if (farm && isSameModel && isSameCallback) return;

      // If same model but configuration changed (e.g. callback module), trigger a re-init
      if (farm && isSameModel && !isSameCallback) {
        try {
          await farm.reinit({ 
            modelId,
            voiceId: config.voiceId,
            callbackModule: callbackModule
          });
          activeCallbackPath = callbackModule?.path || null;
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          throw err;
        }
      }

      // Ensure asset integrity and cache in OPFS
      const modelEntry = PIPER_MODELS.find(m => m.id === modelId);
      const onnxUrl = modelUrls?.onnx || modelEntry?.modelUrl;
      const jsonUrl = modelUrls?.config || modelEntry?.configUrl;

      if (!onnxUrl || !jsonUrl) throw new Error(`Model urls missing for ${modelId}`);

      loadingModelId = modelId;
      
      // 1. Download & Verify via the download controller
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
        // Download failed or was cancelled — clean up loading state
        if (transitionId === lastTransitionId) {
          loadingModelId = null;
        }
        throw err;
      }

      // STALE CHECK: A newer init() was called during download — abandon this one
      if (transitionId !== lastTransitionId) return;

      // LOCK the farm if we are switching models to ensure subsequent requests 
      // are queued for the NEW model that is currently being provisioned.
      if (farm && activeModelId !== modelId) {
        farm.prepareTransition(modelId);
      }

      // 2. Initial Setup or Handoff
      if (!farm) {
        farm = createPiperWorkerFarm();
        
        farmUnsubscribe = farm.onQueueStatus((status) => {
          queueListeners.forEach(l => l(status));
        });

        farmLogUnsubscribe = farm.onLog((log) => {
          logListeners.forEach(l => l(log));
        });

        await farm.init({
          ...config,
        });
      } else {
        try {
          // SHADOW POOL OPTIMIZATION: Non-blocking re-init while queue is running
          await farm.reinit({ 
            modelId, 
            voiceId: config.voiceId,
            modelUrls: config.modelUrls,
            callbackModule: config.callbackModule
          });
        } catch (err) {
          // Transition was superseded by a newer reinit() — silently return
          if (err instanceof DOMException && err.name === 'AbortError') {
            return;
          }
          throw err;
        }
      }

      // Final stale check before committing state
      if (transitionId !== lastTransitionId) return;

      activeModelId = modelId;
      activeCallbackPath = callbackModule?.path || null;
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
      await resolveCacheClearing();
      
      activeModelId = null;
      loadingModelId = null;
    },

    isInitialized: () => farm?.isInitialized() ?? false,
    getActiveModelId: () => activeModelId,

    /** Cancel a specific model's download. Purges OPFS partial files. */
    async cancelDownload(modelId: string) {
      await downloader.cancel(modelId);
    },

    /** Purge cached OPFS files for a model and re-download from scratch. */
    async clearAndRedownloadModel(modelId: string) {
      await downloader.clearAndRedownloadModel(modelId);
    },

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
