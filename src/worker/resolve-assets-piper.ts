import type { PiperPaths } from '../types';

/**
 * Piper asset URLs for phonemization.
 * 
 * Uses static path identifiers resolved at runtime by the consumer's
 * bundler or by the Unified CLI provisioning tool.
 * Build-time asset placement is handled by viteStaticCopy in vite.config.ts.
 */

export const PIPER_ASSET_URLS: PiperPaths = {
  piperData: '/assets/piper_phonemize.data',
  /** SHA-256 for @diffusionstudio/piper-wasm@1.0.0 */
  piperDataSha256: '29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c',
  
  piperJs:   '/assets/piper_phonemize.js',
  /** SHA-256 for @diffusionstudio/piper-wasm@1.0.0 */
  piperJsSha256: 'fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b',
  
  piperWasm: '/assets/piper_phonemize.wasm',
  /** SHA-256 for @diffusionstudio/piper-wasm@1.0.0 */
  piperWasmSha256: 'b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6'
};
