import type { 
  PiperWorkerFarm, 
  FarmConfig, 
  DownloadState,
  RequestStatusPayload,
  WorkerLogPayload,
  PiperModelDefinition
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { createAssetDownloadController } from "../farm/control-asset-download";
import { clearModelCache, deletePiperModel, clearInfraCache } from "../utils/resolve-cache-clearing";
import { setupAssetSW } from "../utils/setup-asset-sw";
import { GATEWAY_ROOT } from "../utils/resolve-gateway-path";

/**
 * Piper Provider with background model switching.
 * 
 * Logic:
 * 1. Tracks current active model.
 * 2. If a new model is requested during active synthesis, it downloads 
 *    and verifies it in the background while the current model continues 
 *    processing the queue.
 * 3. Once provisioned, it performs a re-initialization (reinit).
 * 4. Speaker ID flows per-request without infrastructure changes.
 */
export function createPiperProvider(options?: { debug?: boolean }): Omit<PiperWorkerFarm, 'reinit'> & { 
  getActiveModelId: () => string | null;
  cancelDownload: (modelId: string) => Promise<void>;
  deletePiperModel: (modelId: string) => Promise<void>;
  getDownloadState: () => Map<string, DownloadState>;
  onLog: (listener: (log: WorkerLogPayload) => void) => () => void;
} {
  let farm: PiperWorkerFarm | null = null;
  let activeModelId: string | null = null;
  let activeNumSpeakers: number = 1;
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let activeCallbackPath: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let activeDefaultSpeakerId: number | undefined = undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let loadingModelId: string | null = null;
  
  let lastTransitionId = 0;
  const downloader = createAssetDownloadController();
  const queueListeners = new Set<(status: RequestStatusPayload) => void>();
  const logListeners = new Set<(log: WorkerLogPayload) => void>();
  let farmUnsubscribe: (() => void) | null = null;
  let farmLogUnsubscribe: (() => void) | null = null;
  
  // Early SW Registration: Mandatory in the browser. 
  // If this fails, init() will throw an error.
  let swRegistrationPromise: Promise<ServiceWorkerRegistration | undefined> = Promise.resolve(undefined);
  if (typeof window !== 'undefined') {
    swRegistrationPromise = setupAssetSW();
  }

  return {
    async init(config: FarmConfig) {
      const transitionId = ++lastTransitionId;
      const { modelId, useCallback } = config;

      // 0. Ensure Service Worker is active and controlling the page
      if (typeof window !== 'undefined') {
        await swRegistrationPromise;
      }

      // 1. Resolve model metadata from the model cards via the Service Worker
      // The SW SHA-256 verifies piper-model-cards.json before responding.
      const modelCardsResponse = await fetch(`${GATEWAY_ROOT}infra/piper-model-cards.json`);
      if (!modelCardsResponse.ok) {
        throw new Error(`Model cards fetch failed: ${modelCardsResponse.status}`);
      }
      const models: PiperModelDefinition[] = await modelCardsResponse.json();
      const modelEntry = models.find(m => m.id === modelId);

      loadingModelId = modelId;
      
      // 2. Download & Verify via the Service Worker gateway
      // URL and SHA-256 resolution is handled exclusively by the Service Worker.
      try {
        await downloader.request(
          modelId,
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
        farm = createPiperWorkerFarm(options);
        farmUnsubscribe = farm.onQueueStatus((status) => queueListeners.forEach(l => l(status)));
        farmLogUnsubscribe = farm.onLog((log) => logListeners.forEach(l => l(log)));
        await farm.init(config);
      } else {
        // If switching models, prepare the transition (queues current model)
        if (activeModelId !== modelId) {
          farm.prepareTransition(modelId);
        }

        try {
          activeNumSpeakers = modelEntry?.numSpeakers ?? 1;
          await farm.reinit({ ...config, numSpeakers: activeNumSpeakers });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          throw err;
        }
      }

      // Final stale check before committing state
      if (transitionId !== lastTransitionId) return;

      activeModelId = modelId;
      activeNumSpeakers = modelEntry?.numSpeakers ?? 1;
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

    updatePendingOptions(options) {
      farm?.updatePendingOptions(options, { numSpeakers: activeNumSpeakers });
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

    /** Delete a specific model's cached OPFS files via the Service Worker. */
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
