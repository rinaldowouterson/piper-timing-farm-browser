import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult,
  DownloadState
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";
import { createAssetDownloadController } from "../farm/control-asset-download";
import { FULL_ASSET_URLS } from "../worker/resolve-assets-full";
import { PIPER_MODELS } from "../expose-piper-models";
import { resolveCacheClearing } from "../utils/resolve-cache-clearing";

/**
 * High-level Piper Provider with "Asshole-Proof" background model switching.
 * 
 * Logic:
 * 1. Tracks current active model.
 * 2. If a new model is requested during active synthesis, it downloads 
 *    and verifies it in the background while the current model continues 
 *    processing the queue.
 * 3. Once fully provisioned, it performs an atomic handoff (reinit).
 * 4. Download prioritization ensures the last-selected model loads first.
 * 5. Speaker ID flows per-request without triggering infrastructure changes.
 */
export function createPiperProvider(): PiperWorkerFarm & { 
  getActiveModelId: () => string | null;
  cancelDownload: (modelId: string) => Promise<void>;
  getDownloadState: () => Map<string, DownloadState>;
} {
  let farm: PiperWorkerFarm | null = null;
  let activeModelId: string | null = null;
  let loadingModelId: string | null = null;
  const downloader = createAssetDownloadController();

  return {
    async init(config: FarmConfig) {
      const { modelId, modelUrls } = config;
      
      // If already initialized and requesting same model, skip
      if (farm && activeModelId === modelId) return;

      // Ensure asset integrity and cache in OPFS
      const modelEntry = PIPER_MODELS.find(m => m.id === modelId);
      const onnxUrl = modelUrls?.onnx || modelEntry?.modelUrl;
      const jsonUrl = modelUrls?.config || modelEntry?.configUrl;

      if (!onnxUrl || !jsonUrl) throw new Error(`Model urls missing for ${modelId}`);

      loadingModelId = modelId;

      // LOCK the farm if we are switching models to ensure subsequent requests 
      // are queued for the NEW model that is currently being provisioned.
      if (farm && activeModelId !== modelId) {
        farm.prepareTransition(modelId);
      }

      // Prioritize this model's download (pauses others)
      downloader.prioritize(modelId);

      // 1. Download & Verify via the download controller
      await downloader.request(modelId, { onnx: onnxUrl, config: jsonUrl });

      // 2. Initial Setup or Handoff
      if (!farm) {
        farm = createPiperWorkerFarm();
        await farm.init({
          ...config,
          onnxRuntimePaths: FULL_ASSET_URLS.onnxRuntime,
          piperPaths: FULL_ASSET_URLS.piper
        });
      } else {
        // ASSHOLE OPTIMIZATION: Non-blocking re-init while queue is running
        await farm.reinit({ 
          modelId, 
          voiceId: config.voiceId,
          modelUrls: config.modelUrls
        });
      }

      activeModelId = modelId;
      loadingModelId = null;
    },

    reinit(config) {
      if (!farm) throw new Error("Provider not initialized");
      return farm.reinit(config);
    },

    prepareTransition(targetModelId: string) {
      farm?.prepareTransition(targetModelId);
    },

    synthesize(text, options) {
      if (!farm) throw new Error("Provider not initialized");
      return farm.synthesize(text, options);
    },

    terminate() {
      downloader.cancelAll();
      farm?.terminate();
      farm = null;
      activeModelId = null;
      loadingModelId = null;
    },

    async clearPiperModelCache() {
      // 1. Wipe storage (session-independent)
      await resolveCacheClearing();

      // 2. Terminate active instance if it exists
      if (farm) {
        farm.terminate();
        farm = null;
      }
      
      activeModelId = null;
      loadingModelId = null;
    },

    isInitialized: () => farm?.isInitialized() ?? false,
    getActiveModelId: () => activeModelId,

    /** Cancel a specific model's download. Purges OPFS partial files. */
    async cancelDownload(modelId: string) {
      await downloader.cancel(modelId);
    },

    /** Returns a snapshot of every model's download lifecycle. */
    getDownloadState() {
      return downloader.getState();
    },

    get metrics() {
      return farm?.metrics || { queueLength: 0, busyWorkers: 0, totalWorkers: 0 };
    }
  };
}
