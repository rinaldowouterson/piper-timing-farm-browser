/**
 * Registers the Sovereign Gateway Service Worker.
 *
 * The SW script (`control-asset-sw.js`) must be served from `/piper-gate/`
 * to correctly intercept all `/piper-gate/*` requests.
 * 
 * Use `npx piper-farm init` to provision the SW to `public/piper-gate/`.
 *
 * @param swUrl - Path to the SW script. Defaults to `/piper-gate/control-asset-sw.js`.
 *                Override for subpath deployments (e.g. `/myapp/piper-gate/control-asset-sw.js`).
 */
export async function setupAssetSW(swUrl = '/piper-gate/control-asset-sw.js'): Promise<ServiceWorkerRegistration> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.warn('[setup-asset-sw] Service Worker not supported in this environment');
    return Promise.reject(new Error('SW not supported'));
  }

  const reg = await navigator.serviceWorker.register(swUrl, {
    scope: '/piper-gate/',
    type: 'module',
  });

  await navigator.serviceWorker.ready;
  console.log('[setup-asset-sw] Sovereign Gateway Service Worker active:', reg.scope);
  return reg;
}
