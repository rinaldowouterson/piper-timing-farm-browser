import type { PiperPaths } from '../types';

/**
 * Piper asset URLs for phonemization.
 * 
 * This implementation uses static path identifiers. These are 
 * resolution-agnostic and are finalized by the consumer's 
 * bundler or by our Unified CLI provisioning.
 */

export const PIPER_ASSET_URLS: PiperPaths = {
  piperData: '/assets/piper_phonemize.data',
  piperJs:   '/assets/piper_phonemize.js',
  piperWasm: '/assets/piper_phonemize.wasm',
};
