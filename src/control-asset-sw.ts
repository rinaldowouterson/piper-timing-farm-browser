/**
 * Asset-intercepting Service Worker for Piper Timing Farm.
 *
 * Intercepts all `/assets/*` requests from workers and the main app.
 * Resolution chain: OPFS cache → Local server → CDN fallback.
 * On CDN fetch, writes to OPFS for subsequent offline serving.
 *
 * Identity PATH_MAP: /assets/X maps to /assets/X (unified dist structure).
 * The consumer serves all assets from their own public/assets directory via
 * `npx piper-farm init`.
 */

// Cast to ServiceWorkerGlobalScope to resolve the dual DOM+WebWorker lib conflict
// (tsconfig includes both libs for other source files).
const sw = self as unknown as ServiceWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPFS_INFRA_DIR = 'infra';

/** CDN fallback URLs, keyed by bare filename. */
const CDN_REGISTRY: Record<string, string> = {
  'ort-wasm-simd-threaded.wasm': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.wasm',
  'ort.wasm.min.mjs':            'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs':  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.mjs',
  'piper_phonemize.data':        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
  'piper_phonemize.js':          'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js',
  'piper_phonemize.wasm':        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm',
};

const MIME_REGISTRY: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs':  'text/javascript',
  '.js':   'text/javascript',
  '.data': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

sw.addEventListener('install', () => {
  sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Bypass mechanism for debugging: ?bypass-sw=true
  if (url.searchParams.has('bypass-sw')) return;

  // Only intercept same-origin /assets/* requests
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/assets/')) return;

  const filename = url.pathname.slice('/assets/'.length);
  if (!filename) return;

  event.respondWith(resolveAsset(filename));
});

// ---------------------------------------------------------------------------
// Resolution chain
// ---------------------------------------------------------------------------

async function resolveAsset(filename: string): Promise<Response> {
  const mimeType = resolveMimeType(filename);

  // 1. OPFS cache (offline-first, highest performance)
  const cached = await readFromOpfs(filename);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: { 
        'Content-Type': mimeType,
        'x-piper-sw': 'intercepted'
      },
    });
  }

  // 2. Local server — fetch() inside SW does NOT re-trigger the fetch event,
  //    so this call goes directly to the network without recursion risk.
  try {
    const localResponse = await fetch(`/assets/${filename}`);
    if (localResponse.ok) {
      const data = await localResponse.arrayBuffer();
      await writeToOpfs(filename, data);
      return new Response(data, {
        status: 200,
        headers: { 
          'Content-Type': mimeType,
          'x-piper-sw': 'intercepted'
        },
      });
    }
  } catch {
    // Local assets not present — fall through to CDN
  }

  // 3. CDN fallback (cross-origin fetch is allowed from SW context)
  const cdnUrl = CDN_REGISTRY[filename];
  if (!cdnUrl) {
    console.error(`[control-asset-sw] No CDN URL registered for: ${filename}`);
    return new Response(`[control-asset-sw] Unknown asset: ${filename}`, { status: 404 });
  }

  let cdnResponse: Response;
  try {
    cdnResponse = await fetch(cdnUrl);
  } catch (err) {
    console.error(`[control-asset-sw] CDN fetch failed for ${filename}:`, err);
    return new Response(`[control-asset-sw] CDN unreachable for: ${filename}`, { status: 502 });
  }

  if (!cdnResponse.ok) {
    return new Response(
      `[control-asset-sw] CDN returned ${cdnResponse.status} for: ${filename}`,
      { status: 502 }
    );
  }

  const data = await cdnResponse.arrayBuffer();
  await writeToOpfs(filename, data);
  return new Response(data, {
    status: 200,
    headers: { 
      'Content-Type': mimeType,
      'x-piper-sw': 'intercepted'
    },
  });
}

// ---------------------------------------------------------------------------
// OPFS helpers
// ---------------------------------------------------------------------------

async function readFromOpfs(filename: string): Promise<ArrayBuffer | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_INFRA_DIR, { create: false });
    const handle = await dir.getFileHandle(filename, { create: false });
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch {
    // File doesn't exist yet — not an error condition
    return null;
  }
}

async function writeToOpfs(filename: string, data: ArrayBuffer): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_INFRA_DIR, { create: true });
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    // Non-fatal: next load will re-fetch from CDN
    console.warn('[control-asset-sw] OPFS write failed, continuing without cache:', err);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.'));
  return MIME_REGISTRY[ext] ?? 'application/octet-stream';
}
