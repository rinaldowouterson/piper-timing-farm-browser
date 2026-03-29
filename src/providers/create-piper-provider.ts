import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  AudioSynthesisResult 
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";
import { FULL_ASSET_URLS } from "../worker/resolve-assets-full";
import { PIPER_MODELS } from "../expose-piper-models";

/**
 * High-level Piper Provider with "Asshole-Proof" background model switching.
 * 
 * Logic:
 * 1. Tracks current active model.
 * 2. If a new model is requested during active synthesis, it downloads 
 *    and verifies it in the background while the current model continues 
 *    processing the queue.
 * 3. Once fully provisioned, it performs an atomic handoff (reinit).
 */
export function createPiperProvider(): PiperWorkerFarm & { getActiveModelId: () => string | null } {
  let farm: PiperWorkerFarm | null = null;
  let activeModelId: string | null = null;
  let loadingModelId: string | null = null;

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
        farm.prepareTransition();
      }

      // 1. Download & Verify in background
      await Promise.all([
        resolveOpfsAsset(onnxUrl, modelId, "onnx"),
        resolveOpfsAsset(jsonUrl, modelId, "onnx.json")
      ]);

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

    prepareTransition() {
      farm?.prepareTransition();
    },

    synthesize(text, options) {
      if (!farm) throw new Error("Provider not initialized");
      return farm.synthesize(text, options);
    },

    terminate() {
      farm?.terminate();
      farm = null;
      activeModelId = null;
      loadingModelId = null;
    },

    isInitialized: () => farm?.isInitialized() ?? false,
    getActiveModelId: () => activeModelId,

    get metrics() {
      return farm?.metrics || { queueLength: 0, busyWorkers: 0, totalWorkers: 0 };
    }
  };
}
