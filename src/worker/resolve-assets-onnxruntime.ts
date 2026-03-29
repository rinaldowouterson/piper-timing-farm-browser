import type { OnnxRuntimePaths } from '../types';

/**
 * ONNX Runtime asset URLs for Tier 1 (npm bundled) entry.
 *
 * This implementation uses static path identifiers. These are 
 * resolution-agnostic and are finalized by the consumer's 
 * bundler or by our Unified CLI provisioning.
 *
 * Caches in OPFS on first load.
 */

export const ONNX_ASSET_URLS: OnnxRuntimePaths = {
  wasm: '/assets/ort-wasm-simd-threaded.wasm',
  mjs:  '/assets/ort.all.min.mjs',
};
