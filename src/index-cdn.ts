/**
 * Piper Timing Farm - Tier 2 CDN Entry Point
 * 
 * Specifically designed for direct use in web applications without 
 * npm setup. Resolves all assets (WASM, JS, Data) from unpkg/jsDelivr.
 */

export { createPiperProvider } from './providers/create-piper-provider-cdn';
export { PIPER_MODELS, PIPER_REPO_BASE_URL } from './expose-piper-models';
export type * from './types';
