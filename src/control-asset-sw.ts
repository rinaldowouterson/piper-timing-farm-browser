/**
 * Service Worker Proxy for Piper Timing Farm.
 *
 * Intercepts ALL `/piper-gate/*` requests with mandatory SHA-256 verification.
 * Resolution chain: OPFS cache (verify) → Local server → CDN fallback.
 *
 * Security Model: "Verify on Every Read"
 * - Every asset read from OPFS is SHA-256 verified (~50ms overhead)
 * - Corrupted files are deleted and re-downloaded
 * - No `.meta` markers needed — verification is mandatory, not optional
 *
 * Directory Structure:
 * - `/piper-gate/infra/*` — ORT WASM, Piper phonemize (hardcoded SHA-256)
 * - `/piper-gate/voices/*` — Voice ONNX models (hardcoded or HF API lookup)
 */

import { downloadFile } from "@huggingface/hub";

// Cast to ServiceWorkerGlobalScope to resolve the dual DOM+WebWorker lib conflict
const sw = self as unknown as ServiceWorkerGlobalScope;

// ---------------------------------------------------------------------------
// SHA-256 Verification (Browser-only: crypto.subtle always available)
// ---------------------------------------------------------------------------

/**
 * Calculates SHA-256 hash using Web Crypto API.
 * Service Workers are always Secure Contexts — crypto.subtle is guaranteed available.
 */
async function calculateSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies buffer against expected SHA-256 hash.
 * Returns true if valid, false if mismatch.
 */
async function verifySha256(buffer: ArrayBuffer, expected: string): Promise<boolean> {
  const actual = await calculateSha256(buffer);
  return actual.toLowerCase() === expected.toLowerCase();
}

// ---------------------------------------------------------------------------
// Constants: SHA-256 Hash Registry
// ---------------------------------------------------------------------------

const OPFS_INFRA_DIR = 'infra';
const OPFS_VOICES_DIR = 'voices';

/**
 * Single hardcoded hash — the only trust anchor in the Service Worker.
 * All voice model integrity is derived from the verified model cards.
 * Updated automatically by: scripts/inject-model-cards-hash.ts
 */

const PIPER_MODEL_CARDS_SHA256 = '1111111111111111111111111111111111111111111111111111111111111111'; // Patched post-build by scripts/inject-model-cards-hash.ts
const PROCESS_PIPER_SYNTHESIS_WORKER_SHA256 = '0000000000000000000000000000000000000000000000000000000000000000'; // Patched post-build by scripts/inject-worker-hash.ts


/**
 * Diagnostic Logging Configuration.
 * Toggled at runtime via BroadcastChannel('piper-gate-debug') from the farm.
 */
let DEBUG_GATE = false;

const debugChannel = new BroadcastChannel('piper-gate-debug');
debugChannel.onmessage = (e: MessageEvent<{ debug: boolean }>) => {
  DEBUG_GATE = e.data.debug;
};

function gateLog(level: 'log' | 'warn' | 'error', message: string, ...args: unknown[]) {
  if (!DEBUG_GATE && level === 'log') return;
  console[level](message, ...args);
}



/** Infra asset SHA-256 hashes (ORT WASM, Piper phonemize) — hardcoded for security */
const INFRA_SHA256_REGISTRY: Record<string, string> = {
  'ort-wasm-simd-threaded.wasm': 'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17',
  'ort.wasm.min.mjs':            'd5a6d7bc8ee587648fb3742dde8c0094d17cbd3822a68bbec8ddfcd4f2adb88e',
  'ort-wasm-simd-threaded.mjs':  '5687566b1bc1c8cf628d76c2ddb16b2a3b81a7997273d4666564880495088e57',
  'piper_phonemize.data':        '29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c',
  'piper_phonemize.js':          'fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b',
  'piper_phonemize.wasm':        'b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6',
  'process-piper-synthesis.worker.js': PROCESS_PIPER_SYNTHESIS_WORKER_SHA256,
  'piper-model-cards.json':     PIPER_MODEL_CARDS_SHA256,
  'piper-callback.js':           "",
};

/** CDN fallback URLs for infra assets */
const INFRA_CDN_REGISTRY: Record<string, string> = {
  'ort-wasm-simd-threaded.wasm': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.wasm',
  'ort.wasm.min.mjs':            'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs':  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.mjs',
  'piper_phonemize.data':        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
  'piper_phonemize.js':          'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js',
  'piper_phonemize.wasm':        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm',
};

// ---------------------------------------------------------------------------
// Dynamic Voice Registry (populated from verified index)
// ---------------------------------------------------------------------------

interface IndexModelEntry {
  id: string;
  modelUrl: string;
  configUrl: string;
  modelSha256: string;
  configSha256: string;
}

/** Populated at runtime from the verified index. */
const voiceSha256Registry = new Map<string, { onnx: string; config: string }>();
const voiceUrlRegistry = new Map<string, { onnx: string; config: string }>();

/** Tracks the index resolution state to prevent redundant fetches. */
let voiceRegistriesResolved = false;
let voiceRegistriesResolving: Promise<void> | null = null;

/**
 * Resolves the model cards via the standard infra pipeline (OPFS -> Local -> CDN).
 * Once verified, it populates the dynamic voice registries.
 */
async function resolveVoiceRegistries(): Promise<void> {
  if (voiceRegistriesResolved) return;
  if (voiceRegistriesResolving) return voiceRegistriesResolving;

  voiceRegistriesResolving = (async () => {
    const filename = 'piper-model-cards.json';
    
    // Use standard infra pipeline (handles OPFS, Local, CDN, and Verification)
    const response = await resolveInfraAsset(filename);
    if (!response.ok) {
      throw new Error(`[piper-gate] Index resolution failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.arrayBuffer();
    const models: IndexModelEntry[] = JSON.parse(new TextDecoder().decode(data));

    for (const model of models) {
      voiceSha256Registry.set(model.id, {
        onnx: model.modelSha256,
        config: model.configSha256,
      });
      voiceUrlRegistry.set(model.id, {
        onnx: model.modelUrl,
        config: model.configUrl,
      });
    }

    voiceRegistriesResolved = true;
    gateLog('log', `[piper-gate] Model cards verified and registries populated: ${models.length} models.`);
  })();

  voiceRegistriesResolving.catch(() => { voiceRegistriesResolving = null; });
  return voiceRegistriesResolving;
}


const MIME_REGISTRY: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs':  'text/javascript',
  '.js':   'text/javascript',
  '.data': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
};

// ---------------------------------------------------------------------------
// BroadcastChannel for Progress Reporting
// ---------------------------------------------------------------------------

const progressChannel = new BroadcastChannel('piper-download-progress');

/**
 * Broadcasts a detailed error message to the main thread.
 * Ensures the developer sees EXACTLY why a provision or fetch failed.
 */
function broadcastError(filename: string, error: unknown) {
  const isError = error instanceof Error;
  
  progressChannel.postMessage({
    type: 'error',
    filename,
    message: isError ? error.message : String(error),
    stack: isError ? error.stack : undefined,
    code: isError ? error.name : 'UNKNOWN_ERROR'
  });
}

// ---------------------------------------------------------------------------
// Diagnostic Helpers
// ---------------------------------------------------------------------------

/**
 * Identifies if a filename belongs to the Piper infra or voice registry.
 * Used for diagnostic path-deviation warnings.
 */
function isPiperAsset(filename: string): boolean {
  if (filename in INFRA_SHA256_REGISTRY) return true;
  // Check for voices (modelId.onnx or modelId.onnx.json)
  if (filename.endsWith('.onnx') || filename.endsWith('.onnx.json')) return true;
  return false;
}

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

  // Diagnostic: Catch Piper assets requested via non-standard paths
  if (url.origin === sw.location.origin && !url.pathname.startsWith('/piper-gate/')) {
    const filename = url.pathname.split('/').pop() || '';
    if (isPiperAsset(filename)) {
      gateLog('warn',
        `[piper-gate] [Path Deviation] Detected request for Piper asset '${filename}' at non-gateway path: ${url.pathname}. ` +
        `This request bypasses Service Worker integrity verification and OPFS caching. ` +
        `Please update the requester to use: /piper-gate/.../${filename}`
      );
    }
  }


  // Only intercept same-origin /piper-gate/* requests
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/piper-gate/')) return;

  const assetPath = url.pathname.slice('/piper-gate/'.length);
  if (!assetPath) return;

  // OPFS Deletion Coordination
  if (event.request.method === 'DELETE') {
    event.respondWith(processOpfsDeletion(assetPath));
    return;
  }

  event.respondWith(resolveAsset(assetPath, event.request));
});

// ---------------------------------------------------------------------------
// Fallback Logic: OPFS (verify) → Local → CDN
// ---------------------------------------------------------------------------

async function resolveAsset(assetPath: string, request: Request): Promise<Response> {
  try {

  // Parse path: either "infra/filename" or "voices/modelId.ext"
  const pathParts = assetPath.split('/');
  if (pathParts.length !== 2) {
    return new Response(`[piper-gate] Invalid path format: ${assetPath}`, { status: 400 });
  }

  const [directory, filename] = pathParts;


  if (directory === 'infra') {
    return await resolveInfraAsset(filename);
  } else if (directory === 'voices') {
    return await resolveVoiceAsset(filename, request);
  } else {
    return new Response(`[piper-gate] Unknown directory: ${directory}`, { status: 400 });
  }
  } catch (err: unknown) {
    // Generalized Error Gateway: Report EVERYTHING that fails in the SW
    broadcastError(assetPath, err);
    
    return new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
      statusText: 'Piper Gateway Resolver Error'
    });
  }
}

/**
 * Resolves infra assets (ORT WASM, Piper phonemize).
 * SHA-256 is hardcoded in INFRA_SHA256_REGISTRY.
 */
async function resolveInfraAsset(filename: string): Promise<Response> {
  const expectedSha256 = INFRA_SHA256_REGISTRY[filename];
  if (!expectedSha256) {
    return new Response(`[piper-gate] Unknown infra asset: ${filename}`, { status: 404 });
  }

  // 1. Check OPFS cache and verify
  const cached = await readFromOpfs(OPFS_INFRA_DIR, filename);
  if (cached) {
    const isValid = await verifySha256(cached, expectedSha256);
    if (isValid) {
      gateLog('log', `[piper-gate] [Cache Hit] '${filename}' verified from OPFS.`);
      return createVerifiedResponse(cached, { filename });
    } else {
      gateLog('log', `[piper-gate] [Stale Cache] OPFS integrity mismatch for '${filename}'. Deleting stale entry to trigger re-fetch.`);
      await deleteFromOpfs(OPFS_INFRA_DIR, filename);
    }
  }

  // 2. Try local server
  try {
    const localResponse = await fetch(`/piper-gate/infra/${filename}`);
    if (localResponse.ok) {
      const data = await localResponse.arrayBuffer();
      const isValid = await verifySha256(data, expectedSha256);
      if (isValid) {
        const cached = await writeToOpfs(OPFS_INFRA_DIR, filename, data);
        if (cached) {
          gateLog('log', `[piper-gate] [Cache Restored] '${filename}' verified and cached.`);
        } else {
          gateLog('warn',`[piper-gate] [Cache Miss] '${filename}' verified but not cached (storage issue).`);
        }
        return createVerifiedResponse(data, { filename });
      } else {
        gateLog('error', `[piper-gate] Local infra asset integrity mismatch: ${filename}`);
        // Fall through to CDN
      }
    }
  } catch {
    // Local not available, fall through to CDN
    gateLog('log', `[piper-gate] Local file '${filename}' unavailable. Fetching from CDN.`);
  }

  // 3. CDN fallback
  const cdnUrl = INFRA_CDN_REGISTRY[filename];
  if (!cdnUrl) {
    return new Response(`[piper-gate] No CDN URL for infra asset: ${filename}`, { status: 404 });
  }

  try {
    const cdnResponse = await fetch(cdnUrl);
    if (!cdnResponse.ok) {
      return new Response(`[piper-gate] CDN returned ${cdnResponse.status} for: ${filename}`, { status: 502 });
    }

    const data = await cdnResponse.arrayBuffer();
    const isValid = await verifySha256(data, expectedSha256);
    if (!isValid) {
      return new Response(`[piper-gate] CDN asset integrity mismatch: ${filename}`, { status: 403 });
    }

    const cached = await writeToOpfs(OPFS_INFRA_DIR, filename, data);
    if (cached) {
      gateLog('log', `[piper-gate] Infra asset from CDN verified and cached: ${filename}`);
    } else {
      gateLog('warn',`[piper-gate] Infra asset from CDN verified but not cached: ${filename}`);
    }
    return createVerifiedResponse(data, { filename });
  } catch (err: unknown) {
    gateLog('error', `[piper-gate] CDN fetch failed for ${filename}:`, err);
    return new Response(`[piper-gate] CDN unreachable for: ${filename}`, { status: 502 });
  }
}

/**
 * Resolves the user-provided callback script.
 * Enforces strict SHA-256 verification against the INFRA_SHA256_REGISTRY.
 */

/**
 * Resolves voice assets (ONNX models and configs).
 * SHA-256 lookup: model cards registry only.
 * Source URL lookup: model cards registry only.
 */
async function resolveVoiceAsset(filename: string, request: Request): Promise<Response> {
  // Parse filename: "modelId.onnx" or "modelId.onnx.json"
  const isConfig = filename.endsWith('.onnx.json');
  const modelId = isConfig ? filename.slice(0, -10) : filename.slice(0, -5);
  const extension = isConfig ? 'config' : 'onnx';
  const downloadForCacheOnly = request.headers.get('x-piper-cache-download') === 'true';

  // 0. Ensure model cards are resolved (populates dynamic registries)
  await resolveVoiceRegistries();

  // 1. Get expected SHA-256 from the verified model cards registry
  const voiceEntry = voiceSha256Registry.get(modelId);
  const expectedSha256 = voiceEntry
    ? (extension === 'onnx' ? voiceEntry.onnx : voiceEntry.config)
    : null;

  // SHA-256 is mandatory — reject if model is not in registry
  if (!expectedSha256) {
    gateLog('error', `[piper-gate] No SHA-256 available for voice: ${filename}`);
    return new Response(
      `[piper-gate] SHA-256 required for voice asset: ${filename}. ` +
      `Model must be present in piper-model-cards.json.`,
      { status: 403 }
    );
  }

  // 2. Check OPFS cache and verify
  const cached = await readFromOpfs(OPFS_VOICES_DIR, filename);
  if (cached) {
    const isValid = await verifySha256(cached, expectedSha256);
    if (isValid) {
      gateLog('log', `[piper-gate] [Cache Hit] Voice asset verified from OPFS: ${filename}`);
      return createVerifiedResponse(cached, { filename });
    } else {
      gateLog('log', `[piper-gate] [Stale Cache] Voice integrity mismatch for '${filename}'. Purging stale entry.`);
      await deleteFromOpfs(OPFS_VOICES_DIR, filename);
    }
  }

  // 3. Determine source URL from model cards registry
  const urlEntry = voiceUrlRegistry.get(modelId);
  const sourceUrl = urlEntry
    ? (extension === 'onnx' ? urlEntry.onnx : urlEntry.config)
    : null;

  if (!sourceUrl) {
    return new Response(`[piper-gate] No source URL for voice: ${filename}`, { status: 404 });
  }

  // 4. Download with progress broadcasting
  // Use @huggingface/hub for HF URLs (Xet Protocol optimization), standard fetch otherwise
  try {
    const hfInfo = extractHFRepoPath(sourceUrl);
    let data: ArrayBuffer;
    let contentLength = 0;

    if (hfInfo) {
      // Hugging Face Hub (Xet Protocol) — optimized CDN handling
      gateLog('log', `[piper-gate] Using HF Hub download for: ${filename}`);
      const blob = await downloadFile({
        repo: hfInfo.repo,
        revision: hfInfo.revision,
        path: hfInfo.path,
        fetch: (url, init) => fetch(url, { ...init, signal: request.signal })
      });
      if (!blob) {
        return new Response(`[piper-gate] HF Hub failed to resolve: ${filename}`, { status: 502 });
      }
      
      contentLength = blob.size;
      
      // Broadcast progress (single update for HF downloads — library handles internally)
      progressChannel.postMessage({
        type: 'progress',
        filename,
        downloaded: contentLength,
        total: contentLength,
      });
      
      data = await blob.arrayBuffer();
    } else {
      // Standard Fetch for non-HF URLs
    const response = await fetch(sourceUrl, { signal: request.signal });
    if (!response.ok) {
      return new Response(`[piper-gate] Source returned ${response.status} for: ${filename}`, { status: 502 });
    }

    contentLength = Number(response.headers.get('Content-Length')) || 0;

    // RAM-First: buffer fully, verify, then persist
    const reader = response.body?.getReader();
    if (!reader) {
      return new Response(`[piper-gate] No response body for: ${filename}`, { status: 502 });
    }

    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    let lastProgressTime = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        downloadedBytes += value.length;

        // Throttled progress broadcasting (100ms)
        const now = Date.now();
        if (now - lastProgressTime > 100) {
          progressChannel.postMessage({
            type: 'progress',
            filename,
            downloaded: downloadedBytes,
            total: contentLength || downloadedBytes,
          });
          lastProgressTime = now;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Concatenate chunks
    data = await new Blob(chunks as BlobPart[]).arrayBuffer();
  }

    // Verify integrity
    const isValid = await verifySha256(data, expectedSha256);
    if (!isValid) {
      gateLog('error', `[piper-gate] Voice asset integrity mismatch: ${filename}`);
      return new Response(`[piper-gate] Integrity mismatch for: ${filename}`, { status: 403 });
    }

    // Write to OPFS
    const cached = await writeToOpfs(OPFS_VOICES_DIR, filename, data);

    if (cached) {
      gateLog('log', `[piper-gate] [Cache Restored] Voice asset '${filename}' verified and cached.`);
    } else {
      gateLog('warn',`[piper-gate] [Cache Miss] Voice asset '${filename}' verified but not cached (storage issue).`);
    }

    // MEMORY FIX: If requester only wanted to trigger cache, return 204 No Content
    if (downloadForCacheOnly) {
      return createVerifiedResponse(null, { 
        status: 204, 
        extraHeaders: { 'x-piper-sha256': expectedSha256 } 
      });
    }
    
    return createVerifiedResponse(data, { filename });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(`[piper-gate] Download aborted: ${filename}`, { status: 499 });
    }
    gateLog('error', `[piper-gate] Download failed for ${filename}:`, err);
    return new Response(`[piper-gate] Download failed for: ${filename}`, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// HuggingFace API SHA-256 Lookup
// ---------------------------------------------------------------------------

/**
 * Extracts repo, revision, and path from HuggingFace URL.
 */
function extractHFRepoPath(url: string): { repo: string; revision: string; path: string } | null {
  const match = url.match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (match) {
    return { repo: match[1], revision: match[2], path: match[3] };
  }
  return null;
}



// ---------------------------------------------------------------------------
// OPFS Helpers
// ---------------------------------------------------------------------------

async function readFromOpfs(directory: string, filename: string): Promise<ArrayBuffer | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: false });
    const handle = await dir.getFileHandle(filename, { create: false });
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch (err: unknown) {
    gateLog('warn',`[piper-gate] OPFS read failed for ${directory}/${filename}:`, err);
    return null;
  }
}

async function writeToOpfs(directory: string, filename: string, data: ArrayBuffer): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: true });
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch (err: unknown) {
    gateLog('warn',`[piper-gate] OPFS write failed for ${directory}/${filename}:`, err);
    return false;
  }
}

async function deleteFromOpfs(directory: string, filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: false });
    await dir.removeEntry(filename);
  } catch (err: unknown) {
    // File doesn't exist — ignore
    gateLog('warn',`[piper-gate] OPFS delete failed for ${directory}/${filename}:`, err);
  }
}

/**
 * Processes OPFS deletion requests.
 * Supports recursive directory wipe (voices/) or specific model removal.
 */
async function processOpfsDeletion(assetPath: string): Promise<Response> {
  try {
    const root = await navigator.storage.getDirectory();

    // 1. Full Voices Wipe (e.g. DELETE /piper-gate/voices/)
    if (assetPath === 'voices/' || assetPath === 'voices') {
      try {
        await root.removeEntry('voices', { recursive: true });
        gateLog('log', '[piper-gate] Voice cache cleared (recursive)');
      } catch (err: unknown) {
        const isNotFound = err instanceof Error && (err.name === 'NotFoundError' || err.message.toLowerCase().includes('not found'));
        if (!isNotFound) throw err;
      }
      return new Response(null, { status: 204 });
    }

    // 2. Full Infra Wipe (e.g. DELETE /piper-gate/infra/)
    if (assetPath === 'infra/' || assetPath === 'infra') {
      try {
        await root.removeEntry('infra', { recursive: true });
        gateLog('log', '[piper-gate] Infra asset cache cleared (recursive)');
      } catch (err: unknown) {
        const isNotFound = err instanceof Error && (err.name === 'NotFoundError' || err.message.toLowerCase().includes('not found'));
        if (!isNotFound) throw err;
      }
      return new Response(null, { status: 204 });
    }

    // 2. Specific Model Wipe (e.g. DELETE /piper-gate/voices/model-id)
    if (assetPath.startsWith('voices/')) {
      const modelId = assetPath.slice('voices/'.length);
      if (!modelId) return new Response('[piper-gate] Missing modelId for deletion', { status: 400 });

      const voicesDir = await root.getDirectoryHandle('voices', { create: false }).catch(() => null);
      if (voicesDir) {
        // Atomic cleanup of both primary files
        for (const ext of ['.onnx', '.onnx.json']) {
          try {
            await voicesDir.removeEntry(`${modelId}${ext}`);
          } catch (err: unknown) {
            const isNotFound = err instanceof Error && (err.name === 'NotFoundError' || err.message.toLowerCase().includes('not found'));
            if (!isNotFound) throw err;
          }
        }
        gateLog('log', `[piper-gate] Model assets purged: ${modelId}`);
      }
      return new Response(null, { status: 204 });
    }

    return new Response(`[piper-gate] Unsupported deletion path: ${assetPath}`, { status: 400 });
  } catch (err: unknown) {
    gateLog('error', `[piper-gate] Deletion failed for ${assetPath}:`, err);
    return new Response(`[piper-gate] Internal OPFS Error`, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Factory for creating verified responses.
 * Enforces Cross-Origin Isolation (CORP) and library-specific integrity headers.
 */
function createVerifiedResponse(
  body: BodyInit | null, 
  options: { 
    filename?: string;
    status?: number; 
    extraHeaders?: Record<string, string>; 
  } = {}
): Response {
  const { filename, status = 200, extraHeaders = {} } = options;
  
  const headers: Record<string, string> = {
    'x-piper-sw': 'verified',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extraHeaders
  };
  
  if (filename) {
    const ext = filename.substring(filename.lastIndexOf('.'));
    headers['Content-Type'] = MIME_REGISTRY[ext] ?? 'application/octet-stream';
  }

  return new Response(body, { status, headers });
}
