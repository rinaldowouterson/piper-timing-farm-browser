/**
 * Sovereign Service Worker Gateway for Piper Timing Farm.
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
// Constants: Hardcoded Integrity Manifest
// ---------------------------------------------------------------------------

const OPFS_INFRA_DIR = 'infra';
const OPFS_VOICES_DIR = 'voices';

/** Infra asset SHA-256 hashes (ORT WASM, Piper phonemize) — hardcoded for security */
const INFRA_SHA256_REGISTRY: Record<string, string> = {
  'ort-wasm-simd-threaded.wasm': 'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17',
  'ort.wasm.min.mjs':            'd5a6d7bc8ee587648fb3742dde8c0094d17cbd3822a68bbec8ddfcd4f2adb88e',
  'ort-wasm-simd-threaded.mjs':  '5687566b1bc1c8cf628d76c2ddb16b2a3b81a7997273d4666564880495088e57',
  'piper_phonemize.data':        '29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c',
  'piper_phonemize.js':          'fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b',
  'piper_phonemize.wasm':        'b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6',
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

/** Default voice model SHA-256 hashes — hardcoded from PIPER_MODELS registry */
const VOICE_SHA256_REGISTRY: Record<string, { onnx?: string; config?: string }> = {
  'en_US-bryce-medium': {
    onnx: '330c232c12b8a08eb241599190f2ee8ccd6072dce323d10e06684fb0cde8a241',
    config: '7ceb1bc4af6d4e41b6d1edbb86c67e91e01eaa71f66db4cd0ae92ac704d415be',
  },
  'en_US-ljspeech-high': {
    onnx: '16e472d4e0b95134c67ebbc7fcb06c92b242adf3ea41f4f2630aaf172349227c',
    config: '7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14',
  },
  'en_US-kristin-medium': {
    onnx: 'f6f2c0e13b186ca0ceae53c4bf0e0dcd4533a8af496c3ee851272275538fb874',
    config: '5681426d4aead22195de70531eeeeddb46493cfaffc5764b2ea3db73428b651c',
  },
  'en_US-arctic-medium': {
    onnx: '87057d77bee2a3104a65655adf2d7a1c70ab93b50c8d37c690dbf5660391e4ff',
    config: 'db2ca1a55db01cdd3ce28ae63037ac525133e9e00ca557430dec572643235efe',
  },
  'en_GB-cori-medium': {
    onnx: '30b6781fbf12ea790f67bb8f2aca550fbc83ab63178d62d181b6aa8369172d29',
    config: 'e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36',
  },
  'en_US-libritts-high': {
    onnx: '5478bb7603d3b7f6e6fc94a3df720647217bc73e4059a6caa7d2bf3f34840376',
    config: '2efdc6d7f954588b8180132cbd9b8001933fdd00932c92bc92fd0d2028a9eb3d',
  },
  'nl_NL-alex-medium': {
    onnx: 'a0a8607801723803898cacc2c0708fc9e7a05ee96bcd4fa2a9464a5102bfb79e',
    config: '9ea643871742c038511b6aaf20e6fc098a78a11968122d2f6ca3e50403423f95',
  },
  'nl_BE-rdh-medium': {
    onnx: '71fbf84e2601f41727b59032e224f676b2c5bae24ad0b4ae52fdb9267d08c741',
    config: '65deb256664d22099b0db5bb36d96237a3e32e43885c6ce4ee6811e6c04a8d79',
  },
  'sv_SE-alma-medium': {
    onnx: '748ea1721d9399bffdab7120fddc66bf444127d3ac8d79e7d50aa73bc3a6991d',
    config: '6924380892f769afa92fc6b28ff91d558690d7fb4e3ef8cbf821cefadc8f38fe',
  },
  'sv_SE-nst-medium': {
    onnx: '99ed2539d568c01598f15d1c175c0795f0cee61588baa77dc663edaab30dd9ce',
    config: 'd45dd74cbb4eca58694bf04a97e243044092476f28a55ae26424f0653086980a',
  },
  'uk_UA-ukrainian_tts-medium': {
    onnx: '3d9412227941720605876329ca2be7b9bcce6d8265779b483d6050b7c497045a',
    config: '4e96e72917ca9b94edc77d6ccfee03a73f450ba2fc1ca93c2e562bc014e5aa55',
  },
};

/** Default voice model URLs — HuggingFace CDN */
const VOICE_URL_REGISTRY: Record<string, { onnx: string; config: string }> = {
  'en_US-bryce-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/male/Bryce/en_US-bryce-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/male/Bryce/en_US-bryce-medium.onnx.json',
  },
  'en_US-ljspeech-high': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Ljspeech/en_US-ljspeech-high.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Ljspeech/en_US-ljspeech-high.onnx.json',
  },
  'en_US-kristin-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Kristin/en_US-kristin-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Kristin/en_US-kristin-medium.onnx.json',
  },
  'en_US-arctic-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Arctic/en_US-arctic-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/female/Arctic/en_US-arctic-medium.onnx.json',
  },
  'en_GB-cori-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/UK/female/Cori/en_GB-cori-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/UK/female/Cori/en_GB-cori-medium.onnx.json',
  },
  'en_US-libritts-high': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/multi/Libritts/en_US-libritts-high.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/multi/Libritts/en_US-libritts-high.onnx.json',
  },
  'nl_NL-alex-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/dutch/NL/male/Alex/nl_NL-alex-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/dutch/NL/male/Alex/nl_NL-alex-medium.onnx.json',
  },
  'nl_BE-rdh-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/dutch/BE/male/Rdh/nl_BE-rdh-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/dutch/BE/male/Rdh/nl_BE-rdh-medium.onnx.json',
  },
  'sv_SE-alma-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/swedish/female/Alma/sv_SE-alma-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/swedish/female/Alma/sv_SE-alma-medium.onnx.json',
  },
  'sv_SE-nst-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/swedish/male/Nst/sv_SE-nst-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/swedish/male/Nst/sv_SE-nst-medium.onnx.json',
  },
  'uk_UA-ukrainian_tts-medium': {
    onnx: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/ukrainian/multi/UkrainianTts/uk_UA-ukrainian_tts-medium.onnx',
    config: 'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/ukrainian/multi/UkrainianTts/uk_UA-ukrainian_tts-medium.onnx.json',
  },
};

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

  // Only intercept same-origin /piper-gate/* requests
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith('/piper-gate/')) return;

  const assetPath = url.pathname.slice('/piper-gate/'.length);
  if (!assetPath) return;

  event.respondWith(resolveAsset(assetPath, event.request));
});

// ---------------------------------------------------------------------------
// Resolution Chain: OPFS (verify) → Local → CDN
// ---------------------------------------------------------------------------

async function resolveAsset(assetPath: string, request: Request): Promise<Response> {
  const mimeType = resolveMimeType(assetPath);

  // Parse path: either "infra/filename" or "voices/modelId.ext"
  const pathParts = assetPath.split('/');
  if (pathParts.length !== 2) {
    return new Response(`[piper-gate] Invalid path format: ${assetPath}`, { status: 400 });
  }

  const [directory, filename] = pathParts;

  if (directory === 'infra') {
    return resolveInfraAsset(filename, mimeType);
  } else if (directory === 'voices') {
    return resolveVoiceAsset(filename, mimeType, request);
  } else {
    return new Response(`[piper-gate] Unknown directory: ${directory}`, { status: 400 });
  }
}

/**
 * Resolves infra assets (ORT WASM, Piper phonemize).
 * SHA-256 is hardcoded in INFRA_SHA256_REGISTRY.
 */
async function resolveInfraAsset(filename: string, mimeType: string): Promise<Response> {
  const expectedSha256 = INFRA_SHA256_REGISTRY[filename];
  if (!expectedSha256) {
    return new Response(`[piper-gate] Unknown infra asset: ${filename}`, { status: 404 });
  }

  // 1. Check OPFS cache and verify
  const cached = await readFromOpfs(OPFS_INFRA_DIR, filename);
  if (cached) {
    const isValid = await verifySha256(cached, expectedSha256);
    if (isValid) {
      console.log(`[piper-gate] Infra asset verified from OPFS: ${filename}`);
      return new Response(cached, {
        status: 200,
        headers: { 'Content-Type': mimeType, 'x-piper-sw': 'verified' },
      });
    } else {
      console.warn(`[piper-gate] Corrupted infra asset detected, deleting: ${filename}`);
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
        await writeToOpfs(OPFS_INFRA_DIR, filename, data);
        console.log(`[piper-gate] Infra asset downloaded and verified: ${filename}`);
        return new Response(data, {
          status: 200,
          headers: { 'Content-Type': mimeType, 'x-piper-sw': 'verified' },
        });
      } else {
        console.error(`[piper-gate] Local infra asset integrity mismatch: ${filename}`);
        // Fall through to CDN
      }
    }
  } catch {
    // Local not available, fall through to CDN
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

    await writeToOpfs(OPFS_INFRA_DIR, filename, data);
    console.log(`[piper-gate] Infra asset from CDN verified: ${filename}`);
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'x-piper-sw': 'verified' },
    });
  } catch (err) {
    console.error(`[piper-gate] CDN fetch failed for ${filename}:`, err);
    return new Response(`[piper-gate] CDN unreachable for: ${filename}`, { status: 502 });
  }
}

/**
 * Resolves voice assets (ONNX models and configs).
 * SHA-256 lookup: hardcoded registry → HF API for custom URLs.
 */
async function resolveVoiceAsset(filename: string, mimeType: string, request: Request): Promise<Response> {
  // Parse filename: "modelId.onnx" or "modelId.onnx.json"
  const isConfig = filename.endsWith('.onnx.json');
  const modelId = isConfig ? filename.slice(0, -10) : filename.slice(0, -5);
  const extension = isConfig ? 'config' : 'onnx';

  // 1. Get expected SHA-256
  let expectedSha256: string | null = null;

  // Check hardcoded registry first
  const voiceEntry = VOICE_SHA256_REGISTRY[modelId];
  if (voiceEntry) {
    expectedSha256 = extension === 'onnx' ? voiceEntry.onnx ?? null : voiceEntry.config ?? null;
  }

  // If not in registry, try to get from request headers (custom URL case)
  // The consumer may pass expected SHA-256 via custom header
  if (!expectedSha256) {
    const headerHash = request.headers.get(`x-piper-sha256-${extension}`);
    if (headerHash) {
      expectedSha256 = headerHash;
    }
  }

  // If still no SHA-256, try HF API lookup for custom URLs
  if (!expectedSha256) {
    // Check if there's a custom URL in the request
    const customUrlHeader = request.headers.get(`x-piper-url-${extension}`);
    if (customUrlHeader) {
      expectedSha256 = await fetchHFSha256(customUrlHeader);
    }
  }

  // SHA-256 is mandatory — reject if we can't verify
  if (!expectedSha256) {
    console.error(`[piper-gate] No SHA-256 available for voice: ${filename}`);
    return new Response(
      `[piper-gate] SHA-256 required for voice asset: ${filename}. ` +
      `Provide via x-piper-sha256-${extension} header or use a registered model.`,
      { status: 403 }
    );
  }

  // 2. Check OPFS cache and verify
  const cached = await readFromOpfs(OPFS_VOICES_DIR, filename);
  if (cached) {
    const isValid = await verifySha256(cached, expectedSha256);
    if (isValid) {
      console.log(`[piper-gate] Voice asset verified from OPFS: ${filename}`);
      return new Response(cached, {
        status: 200,
        headers: { 'Content-Type': mimeType, 'x-piper-sw': 'verified' },
      });
    } else {
      console.warn(`[piper-gate] Corrupted voice asset detected, deleting: ${filename}`);
      await deleteFromOpfs(OPFS_VOICES_DIR, filename);
    }
  }

  // 3. Determine source URL
  let sourceUrl: string | null = null;

  // Check hardcoded URL registry
  if (voiceEntry && VOICE_URL_REGISTRY[modelId]) {
    const urlEntry = VOICE_URL_REGISTRY[modelId];
    sourceUrl = extension === 'onnx' ? urlEntry.onnx : urlEntry.config;
  }

  // Check custom URL header
  if (!sourceUrl) {
    const customUrlHeader = request.headers.get(`x-piper-url-${extension}`);
    if (customUrlHeader) {
      sourceUrl = customUrlHeader;
    }
  }

  if (!sourceUrl) {
    return new Response(`[piper-gate] No source URL for voice: ${filename}`, { status: 404 });
  }

  // 4. Download with progress broadcasting
  try {
    const response = await fetch(sourceUrl, { signal: request.signal });
    if (!response.ok) {
      return new Response(`[piper-gate] Source returned ${response.status} for: ${filename}`, { status: 502 });
    }

    const contentLength = Number(response.headers.get('Content-Length')) || 0;

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
    const data = await new Blob(chunks as BlobPart[]).arrayBuffer();

    // Verify integrity
    const isValid = await verifySha256(data, expectedSha256);
    if (!isValid) {
      console.error(`[piper-gate] Voice asset integrity mismatch: ${filename}`);
      return new Response(`[piper-gate] Integrity mismatch for: ${filename}`, { status: 403 });
    }

    // Write to OPFS
    await writeToOpfs(OPFS_VOICES_DIR, filename, data);

    // Broadcast completion
    progressChannel.postMessage({
      type: 'complete',
      filename,
    });

    console.log(`[piper-gate] Voice asset downloaded and verified: ${filename}`);
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'x-piper-sw': 'verified' },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(`[piper-gate] Download aborted: ${filename}`, { status: 499 });
    }
    console.error(`[piper-gate] Download failed for ${filename}:`, err);
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

/**
 * Fetches SHA-256 hash from HuggingFace API.
 * The HF API returns file metadata including lfs.oid (SHA-256 hash).
 */
async function fetchHFSha256(url: string): Promise<string | null> {
  const hfInfo = extractHFRepoPath(url);
  if (!hfInfo) return null;

  try {
    const pathParts = hfInfo.path.split('/');
    const filename = pathParts.pop() || '';
    const dirPath = pathParts.join('/');

    const apiUrl = `https://huggingface.co/api/models/${hfInfo.repo}/tree/${hfInfo.revision}/${dirPath}`;
    const response = await fetch(apiUrl);
    if (!response.ok) return null;

    const files: Array<{ path: string; lfs?: { oid: string } }> = await response.json();
    const fileMeta = files.find(f => f.path === hfInfo.path || f.path.endsWith(filename));
    return fileMeta?.lfs?.oid || null;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }
}

async function writeToOpfs(directory: string, filename: string, data: ArrayBuffer): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: true });
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    console.warn(`[piper-gate] OPFS write failed for ${directory}/${filename}:`, err);
  }
}

async function deleteFromOpfs(directory: string, filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: false });
    await dir.removeEntry(filename);
  } catch {
    // File doesn't exist — ignore
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.'));
  return MIME_REGISTRY[ext] ?? 'application/octet-stream';
}
