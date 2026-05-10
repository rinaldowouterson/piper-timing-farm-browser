/**
 * Centralized utility for location-agnostic gateway path resolution.
 * 
 * Derives the deployment base from the library bundle's own location.
 * Assumes a "Flat Build" where the bundle and 'piper-gate/' are siblings.
 */

const BASE = (typeof document !== 'undefined' && document.baseURI)
  ? new URL('./', document.baseURI).href
  : (typeof self !== 'undefined' ? new URL('./', self.location.href).href : '/'); 

export const GATEWAY_ROOT = `${BASE}piper-gate/`;
