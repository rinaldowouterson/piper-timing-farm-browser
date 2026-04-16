import type { OnnxRuntimePaths } from '../types';

/**
 * ONNX Runtime asset URLs for Tier 1 (npm bundled) entry.
 *
 * Uses static path identifiers resolved at runtime by the consumer's
 * bundler or by the Unified CLI provisioning tool.
 * Build-time asset placement is handled by viteStaticCopy in vite.config.ts.
 */

export const ONNX_ASSET_URLS: OnnxRuntimePaths = {
  wasm: '/assets/',
  /** SHA-256 for onnxruntime-web@1.24.3 (ort-wasm-simd-threaded.wasm) */
  wasmSha256: 'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17',
  
  mjs: '/assets/ort.wasm.min.mjs',
  /** SHA-256 for onnxruntime-web@1.24.3 (ort.wasm.min.mjs) */
  mjsSha256: 'd5a6d7bc8ee587648fb3742dde8c0094d17cbd3822a68bbec8ddfcd4f2adb88e',
  
  mjsHelper: '/assets/ort-wasm-simd-threaded.mjs',
  /** SHA-256 for onnxruntime-web@1.24.3 (ort-wasm-simd-threaded.mjs) */
  mjsHelperSha256: '5687566b1bc1c8cf628d76c2ddb16b2a3b81a7997273d4666564880495088e57',
};
