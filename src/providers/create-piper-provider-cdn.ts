import type { 
  PiperWorkerFarm, 
  FarmConfig 
} from "../types";
import { createPiperWorkerFarm } from "../farm/create-piper-worker-farm";
import { ONNX_CDN_URLS, PIPER_CDN_URLS } from "../worker/resolve-assets-cdn";

/**
 * CDN-Optimized Piper Provider.
 * 
 * Automatically resolves all WASM/Binary dependencies from jadelivr/unpkg.
 * Ideal for "The Whole Nine Yards" of quick integration without local infrastructure.
 */
export function createPiperProvider(): PiperWorkerFarm {
  const farm = createPiperWorkerFarm();
  const baseInit = farm.init;

  farm.init = async (config: FarmConfig) => {
    return baseInit({
      ...config,
      onnxRuntimePaths: ONNX_CDN_URLS,
      piperPaths: PIPER_CDN_URLS
    });
  };

  return farm;
}
