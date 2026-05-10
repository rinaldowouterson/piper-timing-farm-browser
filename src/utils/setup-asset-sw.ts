/**
 * Registers the Asset Gateway Service Worker.
 *
 * The SW script (`control-asset-sw.js`) is served from root with scope `/`,
 * allowing consumers to expand interception to additional asset paths.
 * 
 * Use `npx piper-farm init` to provision the SW to `public/` (root).
 *
 * @param swUrl - Path to the SW script. Defaults to `./control-asset-sw.js` (sibling of entry).
 *                Override for non-standard deployments.
 */
export async function setupAssetSW(swUrl = './control-asset-sw.js'): Promise<ServiceWorkerRegistration> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.warn('[setup-asset-sw] Service Worker not supported in this environment');
    return Promise.reject(new Error('SW not supported'));
  }

  // Fast-path: If the Service Worker Gateway is already active and controlling the page, 
  // return the existing registration immediately.
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready;
  }

  // Derive scope from swUrl: e.g. './control-asset-sw.js' -> './'
  const scope = swUrl.substring(0, swUrl.lastIndexOf('/') + 1) || './';

  const reg = await navigator.serviceWorker.register(swUrl, {
    scope,
    type: 'module',
  });

  // Ensure the Service Worker is not just ready, but ACTIVE
  await navigator.serviceWorker.ready;

  // CRITICAL: Ensure the SW is actually CONTROLLING the page.
  // This is required for intercepting the very first fetch after registration.
  if (!navigator.serviceWorker.controller) {
    console.log('[setup-asset-sw] Waiting for Service Worker Gateway to take control...');
    
    // If the SW is already active, explicitly request a claim to trigger controllerchange
    if (reg.active) {
      reg.active.postMessage({ type: 'CLAIM' });
    }

    await new Promise<void>((resolve, reject) => {
      const handler = () => {
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.removeEventListener('controllerchange', handler);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', handler);
      
      // Safety timeout to prevent infinite hang if something goes wrong
      setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', handler);
        reject(new Error('[setup-asset-sw] Timeout waiting for Service Worker control (5000ms)'));
      }, 5000);
    });
  }

  console.log('[setup-asset-sw] Service Worker Gateway active and controlling:', reg.scope);
  return reg;
}
