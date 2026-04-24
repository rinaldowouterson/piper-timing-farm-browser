/**
 * Piper Timing Farm - Official ESM Entry Point
 * 
 * High-performance, multi-threaded Piper TTS for the browser.
 * Features Worker Farm parallelization, Worker-Thread callbacks, 
 * and stress-test-proof background model switching.
 */

export { createPiperWorkerFarm } from './farm/create-piper-worker-farm';
export { createPiperProvider } from './providers/create-piper-provider';
export { createAssetDownloadController } from './farm/control-asset-download';
export { clearModelCache, deletePiperModel } from './utils/resolve-cache-clearing';
export { PIPER_MODELS, PIPER_REPO_BASE_URL } from './expose-piper-models';
export type { PiperModelDefinition } from './expose-piper-models';
export type * from './types';
