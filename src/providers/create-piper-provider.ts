import type { 
  AudioSynthesisResult, 
  PiperWorkerFarm, 
  FarmConfig 
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";

export interface ProviderConfig extends FarmConfig {
  /** Map of model IDs to their remote URL locations. */
  modelUrls?: {
    onnx: string;
    config: string;
  };
}

/**
 * Browser-based Piper provider with OPFS caching and farm management.
 */
export function createPiperProvider() {
  let farm: PiperWorkerFarm | null = null;
  let isReady = false;
  let initPromise: Promise<void> | null = null;

  const init = async (config: ProviderConfig): Promise<void> => {
    if (isReady) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const voicesDir = await root.getDirectoryHandle("voices", { create: true });

        // Check if model exists in OPFS
        let exists = false;
        try {
          await voicesDir.getFileHandle(`${config.modelId}.onnx`);
          exists = true;
        } catch {}

        // Download if not found in OPFS
        if (!exists && config.modelUrls) {
          const [modelRes, configRes] = await Promise.all([
            fetch(config.modelUrls.onnx),
            fetch(config.modelUrls.config)
          ]);

          if (!modelRes.ok || !configRes.ok) {
            throw new Error("Failed to download model files");
          }

          const [modelBlob, configBlob] = await Promise.all([
            modelRes.blob(),
            configRes.blob()
          ]);

          const writeToOpfs = async (name: string, blob: Blob) => {
            const handle = await voicesDir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
          };

          await Promise.all([
            writeToOpfs(`${config.modelId}.onnx`, modelBlob),
            writeToOpfs(`${config.modelId}.onnx.json`, configBlob)
          ]);
        }

        farm = createPiperWorkerFarm();
        await farm.init(config);
        isReady = true;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();

    return initPromise;
  };

  const synthesize = async (
    text: string,
    options: { speed?: number; pitch?: number; volume?: number } = {}
  ): Promise<AudioSynthesisResult & { callbackResult?: any }> => {
    if (!farm) throw new Error("Provider not initialized. Call init() first.");
    return farm.synthesize(text, options);
  };

  const terminate = () => {
    if (farm) {
      farm.terminate();
      farm = null;
    }
    isReady = false;
    initPromise = null;
  };

  return {
    init,
    synthesize,
    terminate,
    get ready() { return isReady; },
    get metrics() { return farm?.metrics; }
  };
}
