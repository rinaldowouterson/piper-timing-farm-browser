# Piper Timing Farm

High-performance, multi-threaded Piper TTS engine for the browser. Features framework-agnostic worker orchestration, Parallel FIFO sequencing, **Atomic Supersession** for bounded-memory model switching, and push/pull download progress observability.

[![Release](https://img.shields.io/npm/v/piper-timing-farm)](https://www.npmjs.com/package/piper-timing-farm)
[![License](https://img.shields.io/npm/l/piper-timing-farm)](https://github.com/rinaldo/piper-timing-farm/blob/main/LICENSE)

---

## Table of Contents

- [Migration Guide (Breaking Changes)](#migration-guide-breaking-changes)
- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Unified Asset Delivery](#unified-asset-delivery)
- [Core Features](#core-features)
  - [Parallel FIFO Sequencer](#parallel-fifo-sequencer)
  - [Model Switching Lifecycle](#model-switching-lifecycle)
  - [OPFS Read-Through Cache](#opfs-read-through-cache)
  - [Download Controller](#download-controller)
  - [Speaker ID Support](#speaker-id-support)
  - [Worker-Thread Callbacks](#worker-thread-callbacks)
- [Security & Privacy](#security--privacy)
- [API Reference](#api-reference)
- [CLI: Asset Provisioning](#cli-asset-provisioning)
- [Model Registry](#model-registry)
- [Low-Latency Implementation Details](#low-latency-implementation-details)
- [Advanced Debugging & Troubleshooting](#advanced-debugging--troubleshooting)
- [Browser Requirements](#browser-requirements)
- [Type Definitions](#type-definitions)

---

## Migration Guide (Breaking Changes)

This version introduces "Zero-Debt" API refactoring focused on security and clarity.

### 1. `voiceId` Removed
The `voiceId` field was redundant since `modelId` is the primary identifier. 
- **Action**: Remove `voiceId` from your `init()` and `reinit()` configuration.

### 2. Global `defaultSpeakerId` Added
Replaces the need for per-request speaker selection in multi-speaker models.
- **Action**: Pass `defaultSpeakerId: N` in `FarmConfig` to set the farm-wide default speaker.

### 3. Mandatory SRI for Worker Glue
`piperJsSha256` is now **mandatory** in `PiperPaths`. This ensures the phonemizer glue code is always verified before execution.
- **Action**: If you provide custom `piperPaths`, ensure `piperJsSha256` is included. The default `PIPER_ASSET_URLS` already includes the verified hash for matching versions.

### 4. `serviceWorkerUrl` for Subpaths
Enables deployments in non-root environments (e.g., GitHub Pages).
- **Action**: Use `serviceWorkerUrl: "/repo-name/control-asset-sw.js"` if your app is not at the domain root.

---

## Overview

`piper-timing-farm` is a production-grade Text-to-Speech (TTS) library designed for web applications requiring:

1. **Millisecond-perfect synchronization** — Exposed VITS model durations enable precise lipsync and caption timing
2. **Zero main-thread blocking** — All synthesis runs in dedicated Web Workers
3. **Deterministic output order** — Parallel FIFO ensures results arrive in request order
4. **Robust model switching** — Atomic Supersession guarantees bounded memory even under rapid model hot-swapping

### What Makes This Different

Unlike standard Piper wrappers, this library:

- **Exposes phoneme durations** — The `AudioSynthesisResult.metadata.durations` (`Float32Array`) provides per-phoneme timing data essential for lipsync applications
- **Survives rapid model switching** — The provider queues model transitions and performs atomic handoffs without dropping queued requests, even under stress-test conditions
- **Caches intelligently** — OPFS-based read-through cache prevents re-downloading ~30MB of WASM/model assets
- **Processes off-thread** — Worker-thread callbacks allow viseme/phoneme processing without blocking the main thread

---

## Installation

```bash
npm install piper-timing-farm

# Optional but recommended Peer Dependency:
npm install onnxruntime-web
```

> [!NOTE]
> **Why Peer Dependencies?** By providing `onnxruntime-web` yourself, you ensure that multiple ORT-powered libraries in your project share the same engine version, preventing memory bloat and binary conflicts.

---

## Unified Asset Delivery

`piper-timing-farm` uses a modern **Service Worker Interception** model to deliver WASM and binary assets. All asset requests (Piper WASM, ONNX Runtime) are routed through a single origin-local path: `/assets/*`.

### How it works:
1. **OPFS (Fast Path)**: The Service Worker first checks the **Origin Private File System**. If the asset is cached and SHA-256 verified, it is served instantly (~50ms).
2. **Local Server**: If not in OPFS, it checks your local server's `/assets/` folder.
3. **CDN Fallback**: If the asset is missing from your server, it automatically falls back to the **jsDelivr CDN**.

This ensures that everything "just works" out of the box, while naturally optimizing for performance on the second run.

#### Same-Origin Scope

The Service Worker **only intercepts same-origin requests**. This is a critical security boundary:

```typescript
// control-asset-sw.ts — fetch event handler
if (url.origin !== sw.location.origin) return;  // Skip cross-origin
if (!url.pathname.startsWith('/assets/')) return;  // Only intercept /assets/*
```

**Implications:**
- **CDN fallback** works because the Service Worker performs the cross-origin fetch internally (SW context has broader fetch permissions than main thread)
- **Cross-origin model URLs** (e.g., direct HuggingFace URLs passed in `modelUrls`) bypass the Service Worker entirely and go straight to network
- **Security benefit**: Your app's existing cross-origin API calls, analytics, and third-party scripts are never intercepted

**Implementation:** See [`control-asset-sw.ts`](src/control-asset-sw.ts:59-61) for the origin check logic.

### Why host assets locally?

While the Library automatically falls back to a global CDN, hosting assets yourself is recommended for:

- **Privacy & Security**: Corporate networks often block traffic to public CDNs (jsDelivr, etc.).
- **Offline-First Capability**: Enables the library to work on the **very first visit** without an internet connection (assuming a PWA/cached environment).
- **Environment Consistency**: Guarantees the exact same binary versions across all deployment stages.

### Local Provisioning

Use the CLI to copy the production-ready assets to your static folder:

```bash
npx piper-farm init
```

This CLI command:
- **Intelligent Detection**: Automatically targets SvelteKit (`static/assets`) or Vite/React/Next.js (`public/assets`).
- **Sourcing**: Pulls binaries directly from the package's internal `dist/assets/` folder to ensure version-locked results.
- **Service Worker**: The library automatically registers `dist/control-asset-sw.js` during `provider.init()` to orchestrate the OPFS -> Local -> CDN resolution chain. Zero manual setup is required.

---

## Quick Start

```typescript
import { createPiperProvider, PIPER_MODELS } from "piper-timing-farm";

const provider = createPiperProvider();

// Initialize the farm
await provider.init({
  modelId: "en_US-bryce-medium", // or use PIPER_MODELS to find one
  defaultSpeakerId: 0,           // Optional: Global default speaker for the model
  cpuInstances: 2, 
  onProgress: (state) => {
    console.log(`Downloading: ${(state.progress * 100).toFixed(1)}%`);
  },
});

// Synthesize text with optional correlation ID
const result = await provider.synthesize("Hello, world!", {
  requestId: "msg-001", // Optional: Pass your own ID for correlation
  speed: 1.0, 
  volume: 0.9,
});

// --- Playing the Audio ---
const ctx = new AudioContext();
const buffer = ctx.createBuffer(1, result.audioData.length, result.sampleRate);
buffer.getChannelData(0).set(result.audioData);

const source = ctx.createBufferSource();
source.buffer = buffer;
source.connect(ctx.destination);
source.start();

console.log(`Duration: ${result.durationMs}ms`);
const durations = result.metadata.durations; // Phoneme-level timing
```

---

## Architecture

### Worker Farm Pattern

The library uses a **Worker Farm** architecture where multiple persistent Web Workers process synthesis requests in parallel:

```text
Main Thread                    Worker Pool
┌─────────────┐               ┌─────────────────────────┐
│   Provider  │──────────────▶│  Worker 0 (Model A)     │
│             │               │  Worker 1 (Model A)     │
│   Farm      │◀──────────────│  Worker 2 (Model A)     │
│             │   Results     │  ...                    │
│   Queue     │               └─────────────────────────┘
│   (FIFO)    │
└─────────────┘
```

**Key Components:**

| Component                   | Role                | Purpose                                   |
| --------------------------- | ------------------- | ----------------------------------------- |
| `create-piper-provider()`   | Orchestrator        | High-level API and lifecycle management   |
| `control-asset-sw.ts`       | Interception Proxy | Resolves assets via OPFS -> Local -> CDN  |
| `createPiperWorkerFarm()`  | Farm                | Queue management and worker distribution  |
| `process-piper-synthesis.worker.ts` | Worker Engine | ONNX inference and phonemization          |
| `createAssetDownloadController()` | Downloader   | Model asset download orchestration        |

---

## Asset Resolution

The library simplifies asset management by using a single logical path for all binary dependencies.

| Asset Type         | Logical Path                  | Sourced From (at build time) |
| ------------------ | ----------------------------- | ---------------------------- |
| **Piper WASM**     | `/assets/piper_phonemize.*`   | `@diffusionstudio/piper-wasm`|
| **ONNX Runtime**   | `/assets/ort*`                | `onnxruntime-web`            |
| **Voice Models**   | `/assets/*.onnx` (if locally hosted) | HuggingFace (Production Default) |


### OPFS caching ensures assets are only downloaded once.

---

## Core Features

### Parallel FIFO Sequencer

When multiple synthesis requests are submitted simultaneously, workers process them in parallel. However, results must be delivered in the **exact order they were requested** to maintain deterministic behavior.

**Problem:** Request 2 (short text) may complete before Request 1 (long text). Without FIFO sequencing, results would arrive out of order.

**Solution:** The FIFO sequencer holds completed results until all preceding requests have resolved:

```typescript
// Queue state during parallel processing
Queue: [
  { requestId: 'a', text: 'Long text...', result: null },      // Processing
  { requestId: 'b', text: 'Hello', result: { audioData: ... }}, // Complete, waiting
  { requestId: 'c', text: 'World', result: null }              // Processing
]

// Drain sequence:
// 1. 'a' completes → drain 'a'
// 2. 'b' already has result → immediately drain 'b'
// 3. 'c' completes → drain 'c'
```

**Implementation:** See `processQueue()` in [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts).

---

### Flexible Correlation (Traceability)

The library implements a **Flexible Correlation** pattern designed for high-performance React/Vue/Svelte frontends where optimistic UI updates and cancellation are critical.

1.  **Consumer Option**: You can pass your own `requestId` (e.g., a Database UUID or ULID) to `synthesize()`.
2.  **Library Enforcement**: If no ID is provided, the library generates a `crypto.randomUUID()` internally.
3.  **Implicit Return**: Every `AudioSynthesisResult` resolution **guarantees** the `requestId` is returned.
4.  **Synchronous Transparency**: A `queued` status event is emitted **synchronously** during the `synthesize()` call, allowing you to map the ID to your UI before the promise ever resolves.

**Standard vs. Elite Correlation:**
- **Standard**: Library generates an ID, user has to wait for the Promise to know what it was.
- **Elite (Piper Timing Farm)**: User provides the ID, library accepts it, resolves it, and emits it. This enables perfect **Correlation-at-Source**.

```typescript
function processQueue() {
  // 1. Resolve completed FIFO requests
  while (queue.length > 0 && queue[0].result) {
    const first = queue.shift()!;
    first.resolve(first.result as any);
  }

  // 2. Assign pending requests to idle workers
  const nextRequest = queue.find(
    (r) => !r.result && !isCurrentlyProcessing(r.requestId),
  );
  if (nextRequest) {
    // ... Adaptive handoff logic (if transitioning) ...

    const worker = pool.getNextAvailable();
    if (worker) {
      worker.busy = true;
      processingRequestIds.add(nextRequest.requestId);
      worker.worker.postMessage({
        type: "synthesize",
        text: nextRequest.text,
        requestId: nextRequest.requestId,
        speed: nextRequest.speed,
        volume: nextRequest.volume,
        speakerId: nextRequest.speakerId,
      });
    }
  }
}
```

---

### Queue Observability

The library provides a granular observability API to track synthesis requests as they move through the farm. This is ideal for building advanced progress bars or "current task" UI indicators.

```typescript
const provider = createPiperProvider();

const unsubscribe = provider.onQueueStatus((payload) => {
  const { requestId, text, state, modelId, error } = payload;
  
  switch(state) {
    case 'queued':      console.log(`Request ${requestId} is waiting for a worker...`); break;
    case 'processing':  console.log(`Request ${requestId} is currently synthesizing...`); break;
    case 'completed':   console.log(`Request ${requestId} finished successfully.`); break;
    case 'cancelled':   console.log(`Request ${requestId} was aborted.`); break;
    case 'error':       console.error(`Request ${requestId} failed: ${error}`); break;
  }
});

// Later...
unsubscribe();
```

**State Lifecycle:**
1.  **`queued`**: Request accepted by the farm and assigned to the FIFO queue.
2.  **`processing`**: Request assigned to an idle worker; WASM inference has begun.
3.  **`completed`**: Synthesis finished, result transferred to main thread.
4.  **`cancelled`**: Request was explicitly cancelled via `cancelSynthesis()`.
5.  **`error`**: Worker crashed or synthesis failed (PII redacted).

---

### Model Switching Lifecycle

Switching models involves two strictly sequential phases. **Phase 1 must fully complete before Phase 2 begins** — the library never allocates WebAssembly memory until model files are 100% present in OPFS.

#### Phase 1: FIFO Download Queue

When `provider.init({ modelId: 'model-c' })` is called:

1. **Queue** — The model is added to a FIFO download queue. Downloads proceed one at a time to prevent OPFS write-lock contention.
2. **Download** — The `.onnx` model and `.onnx.json` config are fetched with real-time progress tracking.
3. **Verify** — SHA-256 integrity verification is mandatory; on success, a `.meta` marker is written for instant future loads.
4. **Cache** — Files are streamed directly to OPFS. Zero RAM buffering, even for 30MB+ models.

**FIFO Ordering Example:**

```text
User clicks: Model A → Model B → Model C (in rapid succession)

[T0] Model A starts downloading (first in queue)
[T1] Model B requested → Added to queue behind A
[T2] Model C requested → Added to queue behind B
[T3] Model A completes → Phase 2 begins for Model A
[T4] Model B starts downloading
[T5] Model B completes → Model C starts downloading
[T6] Model C completes → all models cached in OPFS for instant future loads
```

> [!TIP]
> **Skipping the Queue:** If you need a specific model immediately, cancel pending downloads with `provider.cancelDownload(modelId)` to remove them from the queue. The next model in line will then begin downloading.
> [!IMPORTANT]
> **Download ≠ Pool creation.** No WebAssembly workers are spawned during Phase 1. The download controller is purely concerned with network I/O and OPFS caching. Phase 2 only begins after the download promise resolves.

#### Phase 2: Shadow Pool Transition (with Atomic Supersession)

Only after the model files are fully cached does the library create a **Shadow Pool** — a set of new Web Workers that load the downloaded model into WebAssembly memory:

1. **Stale Check** — Before touching the worker pool, the provider verifies this is still the _most recent_ `init()` request. If a newer request arrived during the download, this transition is silently abandoned.
2. **Supersede** — If a previous Shadow Pool is still initializing (from an earlier `init()` that completed its download first), it is immediately aborted and its workers terminated.
3. **Spawn** — New workers are created and begin loading the ONNX model from OPFS into WebAssembly.
4. **Promote** — Once all shadow workers report `ready`, the shadow pool replaces the active pool atomically.
5. **Retire** — Old workers finish their current synthesis task, then terminate.

```text
[T3] Model C download complete (Phase 1 done)
     → Stale check passes (Model C is still the latest request)
     → Shadow Pool C spawned (2 workers loading WASM)
[T3.5] Model C workers report ready
     → Shadow Pool C promoted to Active Pool
     → Old Model A workers retired gracefully
[T4] Queue continues with Model C
```

**Memory Guarantee:** At most `1 Active Pool + 1 Shadow Pool` can exist at any time. If multiple initialization requests are triggered in rapid succession during Phase 2, Atomic Supersession ensures intermediate shadow pools are terminated before the newest one is created.

**Implementation:** See `reinit()` in [`control-worker-pool.ts`](src/farm/control-worker-pool.ts) for the supersession mechanism, and `init()` in [`create-piper-provider.ts`](src/providers/create-piper-provider.ts) for the stale-check and download-first gate.

#### Path A: Surgical Re-initialization (Low-Latency)
If you only update the `callbackModule` but keep the same model, the farm performs a **Surgical Re-initialization**. Instead of destroying worker threads, it dynamically imports the new callback script into the existing active workers. This avoids the overhead of reloading the ONNX model and WASM engine into memory.

#### Path B: Shadow Pool Hotswap (Heavy)
If the model or core WASM assets change, the library spawns a completely new **Shadow Pool**. This shadow pool initializes in the background and atomically replaces the active pool only once all workers are `ready`.

#### Self-Healing Workers
During **Granular Cancellation** (using `AbortSignal`), if a worker is deep inside an uninterruptible WASM inference loop, the farm forcefully terminates that specific worker thread and spawns a fresh replacement. This ensures the poll remains responsive even if a task is cancelled mid-inference.

---

### OPFS Read-Through Cache

All model and WASM assets are cached in the **Origin Private File System (OPFS)** for persistence across sessions:

#### Sticky Infrastructure (Directory Separation)

The library maintains two separate OPFS directories to optimize cache management:

| Directory   | Contents                          | Cleared by `clearPiperModelCache()` |
|-------------|-----------------------------------|-------------------------------------|
| **`voices/`** | Model weights (`.onnx`, `.onnx.json`) | ✅ Yes — surgical purge of user models |
| **`infra/`**  | Engine binaries (WASM, glue JS)   | ❌ No — preserved for instant reload |

**Why this matters:** When you call [`provider.clearPiperModelCache()`](src/utils/resolve-cache-clearing.ts), only the `voices/` directory is deleted. The core Piper WASM engine (~17MB) and ONNX Runtime binaries (~12MB) remain cached in `infra/`. This means:

- **First session**: Download all assets (~30MB total)
- **After cache clear**: Only re-download model weights (~5-15MB per model)
- **Subsequent sessions**: Instant load from OPFS (~50ms)

This "sticky infrastructure" pattern ensures that cache purges for model corruption or voice switching don't sacrifice the performance of core engine binaries.

**Implementation:** See [`resolve-cache-clearing.ts`](src/utils/resolve-cache-clearing.ts) for the surgical `voices/` deletion logic.

#### Read-Through Resolution Chain

1. **Check OPFS + `.meta` marker** — If asset exists with a verified SHA-256 marker, return immediately (zero-latency fast-path).
2. **Auto-fetch SHA-256 (HuggingFace)** — If SHA-256 not provided and URL is from HuggingFace, fetch hash from HF API (`lfs.oid` field).
3. **Fetch from network** — If missing or marker mismatch, stream the asset from the network.
4. **Atomic RAM Buffering** — The asset is downloaded into a temporary RAM buffer first.
5. **Verify SHA-256** — Integrity check is performed **in memory** before any data is written to the filesystem. This guarantees that OPFS never contains partial or corrupted binaries.
6. **Write to OPFS** — Once verified, the buffer is persisted to OPFS and a `.meta` marker is written for instant future loads.

> [!TIP]
> **Performance Optimization**: Progress updates during download are throttled to **100ms** intervals. This prevents high-frequency UI re-renders from saturating the main thread during high-speed gigabit downloads.

> [!IMPORTANT]
> **SHA-256 is mandatory for integrity verification.** This prevents serving partial/corrupted files that cause `ERROR_CODE 7` (protobuf parsing failed).
>
> - **HuggingFace URLs**: SHA-256 is auto-fetched from the HF API — zero configuration required
> - **Non-HuggingFace URLs**: You must provide `modelSha256` / `configSha256` in `FarmConfig`

**Implementation:** [`resolve-opfs-asset.ts`](src/utils/resolve-opfs-asset.ts)

```typescript
export async function resolveOpfsAsset(
  url: string,
  modelId: string,
  extension: string,
  expectedSha256?: string, // Auto-fetched for HuggingFace URLs
  options?: {
    signal?: AbortSignal;
    onProgress?: (downloaded: number, total: number) => void;
  },
): Promise<ArrayBuffer> {
  const hfInfo = extractHFRepoPath(url);

  // SECURITY: Auto-fetch SHA-256 from HuggingFace API if not provided
  if (!expectedSha256 && hfInfo) {
    expectedSha256 = await fetchHFSha256(
      hfInfo.repo,
      hfInfo.revision,
      hfInfo.path,
    );
  }

  // SHA-256 is mandatory — throw if still not available
  if (!expectedSha256) {
    throw new Error(`SHA-256 hash is required for integrity verification`);
  }

  // 1. Try OPFS with .meta marker verification (fast-path)
  const verifiedHash = await readMetaMarker(voicesDir, filename);
  if (verifiedHash === expectedSha256) {
    return await file.arrayBuffer(); // Instant load, zero hashing
  }

  // 2. Fetch using Stream (clean download, no partial resumption)
  // 3. Write to OPFS via Stream (zero-memory-buffering)
  // 4. Verify SHA-256 and write .meta marker on success
  await verifySha256(finalBuffer, expectedSha256, url);
  await writeMetaMarker(voicesDir, filename, expectedSha256);

  return finalBuffer;
}
```

**HuggingFace API Auto-Fetch Example:**

```text
URL: https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/male/Bryce/en_US-bryce-medium.onnx

API Call: https://huggingface.co/api/models/rinaldow/piper-onnx-durations/tree/main/english/US/male/Bryce

Response: [{ "path": "...", "lfs": { "oid": "330c232c12b8a08eb241599190f2ee8ccd6072dce323d10e06684fb0cde8a241" } }]
```

The `lfs.oid` field contains the SHA-256 hash — automatically extracted and used for integrity verification.

**Cache Location:** `navigator.storage.getDirectory().getDirectoryHandle("voices")`

**Cache Clearing:** [`resolve-cache-clearing.ts`](src/utils/resolve-cache-clearing.ts)

_Note: The high-level provider automatically terminates the internal farm first, then calls `resolveCacheClearing()`, ensuring no OPFS locks remain during the wipe._

```typescript
await provider.clearPiperModelCache(); // Purges all cached models
await provider.clearAndRedownloadModel("en_US-bryce-medium"); // Force fresh download for corrupted model
```

---

### Download Controller

The [`createAssetDownloadController`](src/farm/control-asset-download.ts) manages model downloads with a **FIFO queue architecture**:

- **Registry + Queue Pattern** — A `Map` tracks download state; an `Array` sequences downloads in request order
- **Deduplication** — Same model requested twice returns the same promise
- **FIFO Ordering** — Downloads proceed one at a time in the order they were requested (prevents OPFS write-lock contention)
- **Per-Model Cancellation** — Abort and purge partial OPFS files for a specific model; removes from queue
- **Force Redownload** — `clearAndRedownloadModel()` purges cache and starts fresh download for corrupted models
- **Progress Observability** — Push (callback) and Pull (snapshot) mechanisms for real-time progress

**Download State Machine (4 States):**

```text
pending → downloading → complete
              ↓
            error (OPFS purged automatically)
```

| State         | Meaning                        | User Action Available                    |
| ------------- | ------------------------------ | ---------------------------------------- |
| `pending`     | Queued, waiting for turn       | `cancelDownload()` to remove from queue  |
| `downloading` | Active transfer in progress    | `cancelDownload()` to abort and purge    |
| `complete`    | Files cached in OPFS, verified | `clearAndRedownloadModel()` if corrupted |
| `error`       | Download failed, OPFS cleaned  | Call `init()` again to retry             |

> [!NOTE]
> The `cancelled` state no longer exists as a separate state. When you call `cancelDownload()`, the entry is immediately removed from the registry and queue, and OPFS files are purged. This simplifies the state model and prevents stale entries from accumulating.

**Snapshot Polling (Pull):**

```typescript
// Observe ALL downloads at once — ideal for a "Downloads Dashboard" UI
const state = provider.getDownloadState();
// Map<string, DownloadState> where DownloadState = {
//   modelId, state: 'pending' | 'downloading' | 'complete' | 'error',
//   bytesDownloaded, bytesTotal, progress (0.0–1.0), error?
// }
```

**Progress Callback (Push):**

```typescript
// Real-time updates for the active download — ideal for a loading bar
await provider.init({
  modelId: "en_US-bryce-medium",
  defaultSpeakerId: 0,
  onProgress: (state) => {
    console.log(`${state.modelId}: ${(state.progress * 100).toFixed(1)}%`);
  },
});
```

> [!TIP]
> Both mechanisms coexist — `onProgress` is push-based sugar for the common single-model case; `getDownloadState()` is the power-user tool for observing everything. They read from the same source of truth.

**Per-Model Cancellation:**

```typescript
// Cancel a specific model: removes from queue, aborts download, purges OPFS
await provider.cancelDownload("en_US-libritts-high");

// Force fresh download for a corrupted model (purge + re-download)
// This clears the .meta marker, the .onnx file, and the .onnx.json file
await provider.clearAndRedownloadModel("en_US-bryce-medium");

// Cancel ALL active downloads and shut down the farm
provider.terminate();
```

**Skipping the Queue (Manual Prioritization):**

Since downloads proceed in FIFO order, you can "prioritize" a model by canceling pending downloads:

```typescript
// User wants Model C immediately, but Model A and B are queued first
await provider.cancelDownload("en_US-model-a");
await provider.cancelDownload("en_US-model-b");
// Now Model C will start downloading immediately when requested
await provider.init({ modelId: "en_US-model-c", defaultSpeakerId: 0 });
```

> [!TIP]
> **Hosting on HuggingFace is recommended.** The library automatically fetches SHA-256 hashes from the HuggingFace API for integrity verification. This means zero-configuration integrity checks for HF-hosted models. For non-HF URLs, you must provide `modelSha256` and `configSha256` manually.

---

### Speaker ID Support

Multi-speaker models (e.g., `en_US-libritts-high` with 904 speakers) support per-request speaker selection:

```typescript
// Single-speaker model: speakerId always 0
await provider.synthesize("Hello");

// Multi-speaker model: select speaker
await provider.synthesize("Hello", { speakerId: 42 });
```

**Validation:** Invalid speaker IDs fall back to `defaultSpeakerId` (which itself defaults to 0). Output results include the actual ID used.

**Global Default:** You can set the speaker once at initialization:

```typescript
await provider.init({
  modelId: 'en_US-libritts-high',
  defaultSpeakerId: 42 // All synthesis will use speaker 42 by default
});
```

**Implementation:** See `resolveSpeakerId()` in [`process-piper-synthesis.worker.ts`](src/worker/process-piper-synthesis.worker.ts).

```typescript
function resolveSpeakerId(
  requested: number | undefined,
  config: ModelConfig,
): number {
  const speakerCount = Object.keys(config.speaker_id_map).length;
  if (speakerCount === 0) return 0; // Single-speaker model

  const sid = requested ?? 0;
  if (sid < 0 || sid >= speakerCount) {
    warn(
      `speakerId ${sid} out of range (0-${speakerCount - 1}), falling back to 0`,
    );
    return 0;
  }
  return sid;
}
```

**Result Metadata:** The actual speaker ID used is returned in the result:

```typescript
const result = await provider.synthesize("Hello", { speakerId: 5 });
console.log(result.metadata.speakerId); // 5 (or 0 if fallback)
```

---

### Worker-Thread Callbacks

For lipsync/viseme applications, you can inject a callback module that runs **inside the worker thread** after each synthesis:

```typescript
await provider.init({
  modelId: "en_US-bryce-medium",
  cpuInstances: 2,
  callbackModule: {
    path: "/js/my-viseme-processor.js",
    functionName: "processVisemes",
  },
});
```

**Callback Module Example:**

```javascript
// /js/my-viseme-processor.js
export function processVisemes(result) {
  // result.audioData - Float32Array
  // result.metadata.durations - Float32Array (per-phoneme timing in ms)
  // result.metadata.phonemes - string[] (phoneme symbols)

  // Compute visemes from phonemes
  const visemes = result.metadata.phonemes.map((p) => phonemeToViseme(p));

  // Return is attached to synthesis result as callbackResult
  return { visemes, timestamps: computeTimestamps(result.metadata.durations) };
}
```

**Result Access:**

```typescript
const result = await provider.synthesize("Hello");
const { visemes, timestamps } = result.callbackResult;
```

**Transfer Optimization:** The library automatically detects `ArrayBuffer` and `TypedArray` objects in callback results and includes them in the `postMessage` transfer list. Non-transferable return values (plain objects, strings, numbers) are copied via structured clone.

```typescript
// Audio buffer is always transferred. Callback result buffers are detected and transferred where possible.
postMessage(
  { type: "success", result, callbackResult },
  {
    transfer: [audio.buffer, ...collectTransferables(callbackResult)],
  },
);
```

---

## Security & Privacy

### Worker Security & Integrity (SRI)

`piper-timing-farm` implements strict **Subresource Integrity** verification for code loaded into the worker thread.

1.  **Phonemizer Glue**: You must provide a `piperJsSha256` in your `PiperPaths` to verify the `piper_phonemize.js` glue script. This is now **mandatory** to prevent execution of tampered engine code.
2.  **Worker Callbacks**: Custom callback modules can include an `integrity` hash. The worker will `fetch` the module and verify its SHA-256 hash before performing a dynamic `import()`.

**How it works:**
- The worker uses `self.crypto.subtle.digest('SHA-256', ...)` for verification.
- **Fail-Safe**: If the hash mismatches, the worker will throw an `Integrity mismatch` error and refuse to execute the code.
- **Insecure Contexts**: Since `crypto.subtle` is only available in Secure Contexts (HTTPS/localhost), integrity checks are suspended in insecure environments with a console warning.

### Privacy & PII Safety

To prevent accidental leakage of sensitive user data (Personally Identifiable Information) into error logs or telemetry systems, the library implements automatic **PII Redaction**:

- **Error Payloads**: If a synthesis request fails, the worker redacts the input `text` field from the error message that bubbles up to the main thread.
- **Redaction Template**: `{ error: "...", originalRequest: { text: "[REDACTED]", ... } }`

---

## API Reference

The CDN entry point provides byte-for-byte parity with Tier 1, including full download management and model transition orchestration.

---

### Advanced: Direct Worker Usage

For power users building custom orchestration, the core synthesis worker logic is exported separately. This allows you to host the worker yourself or integrate it into an existing worker pool.

```typescript
// Define your own worker or use the built-in one
import { processPiperSynthesis } from "piper-timing-farm/worker";

self.onmessage = async (e) => {
  const { type, text, requestId, speed, volume, speakerId } = e.data;
  if (type === "synthesize") {
    await processPiperSynthesis(text, requestId, { speed, volume, speakerId });
  }
};
```

---

### `createPiperProvider()`

High-level API with download management and model switching. You switch models efficiently by simply calling `provider.init()` again with the new target model ID; it will transparently orchestrate background download and shadow pool handoff.

```typescript
const provider = createPiperProvider();

// Methods
await provider.init(config: FarmConfig); // Serves for initial load and fast hot-swapping
await provider.synthesize(text: string, options?: SynthesizeOptions);
provider.cancelSynthesis(requestId: string);
provider.cancelAllSynthesis();
await provider.clearPiperModelCache();
await provider.cancelDownload(modelId: string);
await provider.clearAndRedownloadModel(modelId: string); // Purge + fresh download for corrupted models
provider.terminate();
provider.prepareTransition(targetModelId: string);

// Properties
provider.isInitialized(): boolean;
provider.getActiveModelId(): string | null;
provider.getDownloadState(): Map<string, DownloadState>;
provider.metrics: { queueLength, busyWorkers, totalWorkers };

// Events
provider.onQueueStatus(listener: (status: RequestStatusPayload) => void): () => void;
provider.onLog(listener: (log: WorkerLogPayload) => void): () => void;
```

### `createPiperWorkerFarm()`

Lower-level API without download management. Use when you handle asset provisioning yourself.

```typescript
const farm = createPiperWorkerFarm();

// Methods
await farm.init(config: FarmConfig);
await farm.reinit(config);
await farm.synthesize(text, options);
await farm.clearPiperModelCache();
farm.onLog((log) => console.log(`[Worker ${log.workerId}] ${log.message}`));
farm.terminate();
farm.prepareTransition(targetModelId);

// Properties
farm.isInitialized(): boolean;
farm.getActiveModelId(): string | null;
farm.metrics: { queueLength, busyWorkers, totalWorkers };
```

### `FarmConfig`

```typescript
interface FarmConfig {
  modelId: string; // Model identifier (e.g., 'en_US-bryce-medium')
  cpuInstances?: number; // Number of parallel workers (default: 2)
  modelUrls?: {
    // Optional: Custom model URLs
    onnx: string;
    config: string;
  };
  onnxRuntimePaths?: OnnxRuntimePaths;
  piperPaths?: PiperPaths;
  callbackModule?: CallbackModuleConfig;
  modelSha256?: string; // Optional: SHA-256 for model integrity
  configSha256?: string; // Optional: SHA-256 for config integrity
  onProgress?: (state: DownloadState) => void; // Optional: Download progress callback
  defaultSpeakerId?: number; // Optional: Global speaker selection for multi-speaker models
  serviceWorkerUrl?: string; // Optional: Custom path to Service Worker (for subpath deployments)
}

interface CallbackModuleConfig {
  path: string; // Path to the JavaScript module
  functionName: string; // Name of the exported function
  integrity?: string; // Optional: SHA-256 integrity hash
}
```

> [!NOTE]
> The `prioritizeSelected` option has been removed. Downloads now proceed in strict FIFO order. To "prioritize" a model, cancel pending downloads with [`provider.cancelDownload()`](src/providers/create-piper-provider.ts) before requesting the desired model.

### `SynthesizeOptions`

```typescript
interface SynthesizeOptions {
  speed?: number; // Speech rate multiplier (default: 1.0)
  volume?: number; // Volume scaling (default: 1.0)
  speakerId?: number; // Speaker selection for multi-speaker models
  signal?: AbortSignal; // Optional: Abort controller signal for granular cancellation
  requestId?: string; // Optional: Request tracing ID
}
```

### `OnnxRuntimePaths`

```typescript
interface OnnxRuntimePaths {
  wasm: string; // Path to the WASM binaries folder
  mjs: string; // Path to ort.wasm.min.mjs
  mjsHelper: string; // Path to ort-wasm-simd-threaded.mjs
}
```

### `PiperPaths`

```typescript
interface PiperPaths {
  piperWasm: string; // Path to piper_phonemize.wasm
  piperJs: string; // Path to piper_phonemize.js
  piperData: string; // Path to piper_phonemize.data
  piperJsSha256?: string; // Optional: SHA-256 for piperJs integrity
}
```

### `AudioSynthesisResult`

```typescript
interface AudioSynthesisResult {
  audioData: Float32Array; // Raw audio samples
  sampleRate: number; // Audio sample rate (e.g., 22050)
  durationMs: number; // Total audio duration in milliseconds
  metadata: PiperMetadata & {
    generationTimeMs?: number; // Synthesis processing time
    speakerId?: number; // Speaker ID used (after validation)
  };
  // Note: the return type is an intersection: `{ ... } & { callbackResult?: any }`
}

interface PiperMetadata {
  modelId?: string; // Model ID used for this synthesis
  phonemeIds: number[]; // Phoneme ID sequence
  phonemes?: string[]; // Phoneme symbol sequence
  durations?: Float32Array; // Per-phoneme timing in ms
  totalAudioDurationMs: number;
  sampleRate: number;
  hopSize: number; // VITS hop size (256)
}
```

---

## CLI: Asset Provisioning

### `npx piper-farm init [target-path]`

Provisions WASM and binary assets to your project's static directory.

### `npx piper-farm hash <file-path>`

Generates a sidecar `.json` integrity hash for a binary asset. This is used for **Subresource Integrity (SRI)** verification when loading custom callback modules or phonemizer glue scripts.

**Example:**
```bash
npx piper-farm hash public/assets/my-callback.js
# [OK] Hash: 5e884898da28...
# [OK] Created sidecar: my-callback.js.json
```

**Framework Detection:**

| Framework      | Detection Strategy                          | Default Target  |
| -------------- | ------------------------------------------- | --------------- |
| SvelteKit      | Detects `svelte.config.js`                  | `static/assets` |
| **All Others** | Universal Fallback (Angular, Next.js, etc.) | `public/assets` |

**Custom Target Path:**

By default, the CLI uses the targets above. However, you can provide an explicit path for any non-standard project structure:

```bash
npx piper-farm init ./public/custom-wasm-folder
```

> [!IMPORTANT]
> **Asset Path Defaults:** While the CLI allows you to provision assets to any folder, the library **defaults** to looking for them in the `/assets/` subfolder at runtime (e.g., `yourdomain.com/assets/piper_phonemize.js`).
>
> You can override these defaults during initialization without editing the source code:
>
> ```typescript
> await provider.init({
>   // ...
>   piperPaths: {
>     piperWasm: "/custom/piper_phonemize.wasm",
>     piperData: "/custom/piper_phonemize.data",
>     piperJs: "/custom/piper_phonemize.js",
>   },
> });
> ```
>
> **Note on Extensions:** The library source code is TypeScript (`.ts`), but it expects the compiled/binary assets (`.js` glue code and `.wasm` engines) to be present in your static folder. This ensures compatibility with all modern bundlers and build processes.

**Fail-Fast Security:**

The CLI refuses to run outside a project root:

```bash
cd ~/Downloads
npx piper-farm init
# Error: npx piper-farm must be run from your project root (containing package.json)
```

**Assets Provisioned:**

| File                          | Size   | Purpose                               |
| ----------------------------- | ------ | ------------------------------------- |
| `piper_phonemize.wasm`        | ~620KB | Piper phonemization engine            |
| `piper_phonemize.data`        | ~17MB  | eSpeak-ng language data               |
| `piper_phonemize.js`          | ~118KB | Emscripten glue code                  |
| `ort.wasm.min.mjs`            | ~50KB  | ONNX Runtime minimal module           |
| `ort-wasm-simd-threaded.mjs`  | ~24KB  | ONNX Runtime WASM (SIMD+threads) glue |
| `ort-wasm-simd-threaded.wasm` | ~12MB  | ONNX Runtime WASM engine binary       |

---

## Model Registry

The [`PIPER_MODELS`](src/expose-piper-models.ts) export provides pre-configured model definitions with SHA-256 hashes for integrity verification:

```typescript
import { PIPER_MODELS, PIPER_REPO_BASE_URL } from "piper-timing-farm";

// Find a model
const model = PIPER_MODELS.find((m) => m.id === "en_US-bryce-medium");

// Model structure
interface PiperModelDefinition {
  id: string; // 'en_US-bryce-medium'
  name: string; // 'Bryce'
  language: string; // 'en'
  country: string; // 'US'
  gender?: "male" | "female" | "multi";
  quality: "low" | "medium" | "high";
  modelUrl: string; // HuggingFace URL
  configUrl: string; // HuggingFace URL
  numSpeakers: number; // 1 for single-speaker
  isMultiSpeaker: boolean; // Derived from numSpeakers
  speakerId: number; // Default speaker (0)
  modelSha256?: string; // SHA-256 hash for integrity (auto-fetched from HF API if missing)
  configSha256?: string; // SHA-256 hash for integrity (auto-fetched from HF API if missing)
}
```

> [!TIP]
> **HuggingFace Auto-Fetch:** For models hosted on HuggingFace, SHA-256 hashes are automatically fetched from the HF API (`lfs.oid` field) if not provided in the config. This means zero-configuration integrity verification for HF-hosted models.
>
> **Recommendation:** Host your custom models on HuggingFace to benefit from automatic SHA-256 verification without manual hash computation.

**Available Models & Licenses:**

| Language          | Model Name   | Quality | License       | Dataset / Training info         |
| ----------------- | ------------ | ------- | ------------- | ------------------------------- |
| English (en_US)   | Bryce        | medium  | Public Domain | Recorded by Bryce Beattie       |
| English (en_US)   | Ljspeech     | high    | Public Domain | LJSpeech dataset                |
| English (en_US)   | Kristin      | medium  | CC-BY 4.0     | Recorded by Kristin (LibriVox)  |
| English (en_US)   | Arctic       | medium  | Public Domain | CMU Arctic dataset              |
| English (en_GB)   | Cori         | medium  | CC-BY 4.0     | Recorded by Cori                |
| English (en_US)   | Libritts     | high    | CC-BY 4.0     | LibriTTS dataset (904 speakers) |
| Dutch (nl_NL)     | Alex         | medium  | CC0           | Finetuned from rdh (Safe)       |
| Dutch (nl_BE)     | Rdh          | medium  | CC0           | Trained from scratch            |
| Swedish (sv_SE)   | Alma         | medium  | CC-BY 4.0     | NST Swedish TTS dataset         |
| Swedish (sv_SE)   | Nst          | medium  | CC0           | Trained from scratch (KBLab)    |
| Ukrainian (uk_UA) | UkrainianTts | medium  | CC-BY 4.0     | Multi-speaker Ukrainian         |

**Model Source:** HuggingFace repository at `PIPER_REPO_BASE_URL`:

```text
https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/
```

---

## Low-Latency Implementation Details

### Zero-Copy Transfer

The `audioData` buffer (`Float32Array`) is always transferred via `postMessage` with `transfer`, moving the underlying memory from the worker to the main thread without copying.

For worker-thread callback results, the library recursively walks the return value and transfers any `ArrayBuffer` or `TypedArray` buffers it finds. The following types are detected:

| Type                              | Transferred  | Example                                   |
| --------------------------------- | ------------ | ----------------------------------------- |
| `ArrayBuffer`                     | ✅ Zero-copy | Raw binary data                           |
| `Float32Array`                    | ✅ Zero-copy | Audio samples, timing data                |
| `Uint16Array`, `Int32Array`, etc. | ✅ Zero-copy | Any TypedArray backed by an `ArrayBuffer` |
| Plain objects, strings, numbers   | ❌ Copied    | Serialized via structured clone           |

**Note:** Transfer performance depends on what your callback returns. Returning `TypedArray` objects enables zero-copy transfer. Returning plain objects or deeply nested non-buffer data will fall back to the browser's standard structured clone algorithm.

**Effect:** The `audioData` buffer (typically hundreds of thousands of samples) moves between threads with zero serialization cost. Small metadata fields (phoneme IDs, model ID, etc.) are copied, which is negligible at their size.

### Single-Threaded Workers

Each worker uses `ortInstance.env.wasm.numThreads = 1` to prevent internal ONNX threading from competing with the worker pool:

```typescript
// process-piper-synthesis.worker.ts
ortInstance.env.wasm.numThreads = 1; // Enforce single thread per worker
```

**Rationale:** A 4-worker pool with each worker using 4 internal threads would spawn 16 threads, causing context-switch overhead. Single-threaded workers with external load balancing is more efficient.

### OPFS Fast-Path

Cached assets bypass network entirely:

```typescript
// resolve-opfs-asset.ts
if (file.size > 0) {
  return await file.arrayBuffer(); // Fast-path: Trust the cache
}
```

**Effect:** Subsequent sessions load models in ~50ms (OPFS read) vs ~5s (network download).

### Low-Memory Streaming Downloads

For Hugging Face models, the `XetBlob` stream from `@huggingface/hub` naturally reconstructs the file using localized deduplicated chunk fetching, providing efficient downloads even for large models.

To prevent Out-of-Memory (OOM) crashes on low-end devices, the library avoids buffering large 30MB+ `.onnx` models into RAM. Instead, it reads straight from the `ReadableStream` of the fetch/Xet response into a `FileSystemWritableFileStream` directly on OPFS.

> [!NOTE]
> Range header support for partial download resumption has been removed. If a download is interrupted, the next attempt starts fresh. This simplifies the download logic and ensures clean, verified files without partial state management.

---

## Advanced Debugging & Troubleshooting

### Service Worker Bypass

When debugging asset loading issues, you can bypass the Service Worker interception by adding a query parameter:

```text
https://yourdomain.com/assets/piper_phonemize.wasm?bypass-sw=true
```

**Implementation:** The Service Worker checks for `bypass-sw` in [`control-asset-sw.ts`](src/control-asset-sw.ts:56-57):

```typescript
// Bypass mechanism for debugging: ?bypass-sw=true
if (url.searchParams.has('bypass-sw')) return;
```

**Use Cases:**
- **Force network fetch**: Test CDN connectivity without OPFS cache interference
- **Debug 404s**: Verify your local `/assets/` folder is correctly provisioned
- **Hot-reload testing**: Check if updated assets are being served correctly

> [!WARNING]
> Bypassing the Service Worker will **not** write assets to OPFS. Use only for debugging; production requests should always go through the SW for caching.

### Worker Naming in DevTools

Each worker is assigned a sequential ID (`PiperWorker-0`, `PiperWorker-1`, etc.) that appears in Chrome DevTools' **Application → Workers** panel:

```typescript
// process-piper-synthesis.worker.ts
const PREFIX = () => `[PiperWorker:${instanceId}:${deviceLabel}]`;
```

**DevTools Profiling Tips:**
1. **Console Filtering**: Search for `[PiperWorker:0]` to isolate logs from a specific worker
2. **Performance Profile**: Each worker thread is labeled in the timeline view
3. **Memory Snapshots**: Workers are listed individually in the heap snapshot selector

**Worker Lifecycle Events:**
```text
[PiperWorker:0:CPU] Initializing with model: en_US-bryce-medium
[PiperWorker:0:CPU] ONNX session created
[PiperWorker:0:CPU] Ready
[PiperWorker:0:CPU] Synthesizing: "Hello, world!"
[PiperWorker:0:CPU] Synthesis complete (234ms)
```

### Secure Contexts (HTTPS/localhost) — Hard Requirement for SRI

**Subresource Integrity (SRI) verification requires a Secure Context.** The `crypto.subtle.digest()` API is only available when:

| Environment | `crypto.subtle` Available | SRI Verification |
|-------------|---------------------------|------------------|
| `https://*` | ✅ Yes                    | ✅ Active         |
| `http://localhost` | ✅ Yes (dev exemption) | ✅ Active         |
| `http://127.0.0.1` | ✅ Yes (dev exemption) | ✅ Active         |
| `http://192.168.x.x` | ❌ No (insecure)    | ⚠️ Suspended      |
| `http://production.com` | ❌ No (insecure)  | ⚠️ Suspended      |

**Behavior in Insecure Contexts:**

```typescript
// process-piper-synthesis.worker.ts
if (!self.crypto || !self.crypto.subtle) {
  warn("Security verification suspended: crypto.subtle is missing (Insecure Context). Proceeding without integrity check.");
  return true; // Fail-open: allow execution without verification
}
```

The library **fails open** in insecure contexts with a console warning. This prevents hard failures on development setups that don't meet Secure Context criteria, but **production deployments must use HTTPS**.

> [!IMPORTANT]
> **Production Requirement:** All production deployments must serve pages over HTTPS. Insecure HTTP deployments will:
> - Skip integrity verification for callback modules
> - Log a warning on every worker initialization
> - Potentially execute unverified third-party code

### Cross-Origin Isolation (COOP/COEP) — Multi-Threading Considerations

The library uses **single-threaded workers** (`numThreads = 1`) by default, which works in all browsers without special headers:

```typescript
ortInstance.env.wasm.numThreads = 1; // No SharedArrayBuffer required
```

**However, if you want to enable multi-threaded ONNX inference** (not recommended for this library's worker pool architecture), you would need:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Troubleshooting COOP/COEP Issues:**

| Symptom | Cause | Solution |
|---------|-------|----------|
| `SharedArrayBuffer is not defined` | Missing COOP/COEP headers | Add headers or keep `numThreads=1` |
| Worker fails to load external scripts | COEP blocks cross-origin resources | Use `crossorigin` attribute on `<script>` tags |
| CDN fetch fails in SW | COEP applies to Service Worker | Ensure CDN resources have CORS headers |

> [!TIP]
> **Recommended Configuration:** Keep the default single-threaded workers. The worker pool already provides parallelism at the orchestration level, making internal ONNX threading redundant and potentially harmful to performance.

---

## Browser Requirements

### Required APIs

| API                  | Purpose                | Browser Support                        |
| -------------------- | ---------------------- | -------------------------------------- |
| Web Workers          | Parallel synthesis     | All modern browsers                    |
| OPFS                 | Asset caching          | Chrome 86+, Firefox 111+, Safari 15.2+ |
| SHA-256 (Web Crypto) | Integrity verification | All modern browsers (Secure Context required) |

**Note:** The library enforces single-threaded workers (`numThreads = 1`), which works out-of-the-box in all modern browsers without special headers or `SharedArrayBuffer` requirements.

---

## Type Definitions

All types are exported from the main entry:

```typescript
import type {
  AudioSynthesisResult,
  FarmConfig,
  PiperWorkerFarm,
  PiperWorkerConfig,
  PiperPaths,
  OnnxRuntimePaths,
  CallbackModuleConfig,
  DownloadState, // state: 'pending' | 'downloading' | 'complete' | 'error'
  DownloadController,
  PiperMetadata,
  SynthesizeOptions,
  PendingRequest,
  WorkerState,
  PiperWorkerMessageIn,
  PiperWorkerMessageOut,
  PiperModelConfig,
} from "piper-timing-farm";

import {
  type PiperModelDefinition, // Re-exported from expose-piper-models
  PIPER_MODELS,
  PIPER_REPO_BASE_URL,
} from "piper-timing-farm";
```

See [`src/types/index.ts`](src/types/index.ts) for complete definitions.

---

## License

MIT © Rinaldo Wouterson
