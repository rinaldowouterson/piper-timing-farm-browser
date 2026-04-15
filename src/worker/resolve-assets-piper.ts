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
  piperJs:   '/assets/piper_phonemize.js',
  piperWasm: '/assets/piper_phonemize.wasm',
  piperJsSha256: 'fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b'
};
