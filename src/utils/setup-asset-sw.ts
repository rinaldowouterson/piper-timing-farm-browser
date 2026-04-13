/**
 * Registers the asset-intercepting Service Worker.
 *
 * The SW script (`control-asset-sw.js`) must be served from your site root
 * (or above the `/assets/` path it needs to intercept). Use `npx piper-farm init`
 * to copy it to `public/` alongside the other binary assets.
 *
 * @param swUrl - Path to the SW script. Defaults to `/control-asset-sw.js`.
 *                Override for subpath deployments (e.g. `/myapp/control-asset-sw.js`).
 */
export async function setupAssetSW(swUrl = '/control-asset-sw.js'): Promise<ServiceWorkerRegistration> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.warn('[setup-asset-sw] Service Worker not supported in this environment');
    return Promise.reject(new Error('SW not supported'));
  }

  const reg = await navigator.serviceWorker.register(swUrl, {
    scope: '/',
    type: 'module',
  });

  await navigator.serviceWorker.ready;
  console.log('[setup-asset-sw] Service Worker active:', reg.scope);
  return reg;
}
