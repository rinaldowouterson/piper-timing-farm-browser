import type { 
  DownloadState,
  FarmConfig,
  PiperWorkerFarm 
} from "../types";
import { createPiperProvider as createBaseProvider } from "./create-piper-provider";
import { ONNX_CDN_URLS, PIPER_CDN_URLS } from "../worker/resolve-assets-cdn";

/**
 * CDN-Optimized Piper Provider.
 * 
 * Automatically resolves all WASM/Binary dependencies from jsdelivr/unpkg.
 * Ideal for "The Whole Nine Yards" of quick integration without local infrastructure.
 */
export function createPiperProvider(): Omit<PiperWorkerFarm, 'reinit'> & { 
  getActiveModelId: () => string | null;
  cancelDownload: (modelId: string) => Promise<void>;
  getDownloadState: () => Map<string, DownloadState>;
} {
  const provider = createBaseProvider();
  const baseInit = provider.init;

  provider.init = async (config: FarmConfig) => {
    return baseInit({
      ...config,
      onnxRuntimePaths: config.onnxRuntimePaths || ONNX_CDN_URLS,
      piperPaths: config.piperPaths || PIPER_CDN_URLS
    });
  };

  return provider;
}
