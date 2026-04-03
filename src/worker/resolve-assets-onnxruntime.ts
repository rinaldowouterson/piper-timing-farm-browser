import type { OnnxRuntimePaths } from '../types';

/**
 * ONNX Runtime asset URLs for Tier 1 (npm bundled) entry.
 *
 * Uses static path identifiers resolved at runtime by the consumer's
 * bundler or by the Unified CLI provisioning tool.
 * Build-time asset placement is handled by viteStaticCopy in vite.config.ts.
 */

export const ONNX_ASSET_URLS: OnnxRuntimePaths = {
  wasm: '/assets/ort-wasm-simd-threaded.wasm',
  mjs:  '/assets/ort.all.min.mjs',
};
