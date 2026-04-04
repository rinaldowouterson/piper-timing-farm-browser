# Piper Timing Farm

High-performance, multi-threaded Piper TTS engine for the browser. Features framework-agnostic worker orchestration, Parallel FIFO sequencing, and **stress-test-proof** background model switching.

[![Release](https://img.shields.io/npm/v/piper-timing-farm)](https://www.npmjs.com/package/piper-timing-farm)
[![License](https://img.shields.io/npm/l/piper-timing-farm)](https://github.com/rinaldo/piper-timing-farm/blob/main/LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Entry Points](#entry-points)
- [Core Features](#core-features)
  - [Parallel FIFO Sequencer](#parallel-fifo-sequencer)
  - [Shadow Pool Model Transitions](#shadow-pool-model-transitions)
  - [OPFS Read-Through Cache](#opfs-read-through-cache)
  - [Download Controller](#download-controller)
  - [Speaker ID Support](#speaker-id-support)
  - [Worker-Thread Callbacks](#worker-thread-callbacks)
- [API Reference](#api-reference)
- [CLI: Asset Provisioning](#cli-asset-provisioning)
- [Model Registry](#model-registry)
- [Low-Latency Implementation Details](#low-latency-implementation-details)
- [Browser Requirements](#browser-requirements)
- [Type Definitions](#type-definitions)

---

## Overview

`piper-timing-farm` is a production-grade Text-to-Speech (TTS) library designed for web applications requiring:

1. **Millisecond-perfect synchronization** — Exposed VITS model durations enable precise lipsync and caption timing
2. **Zero main-thread blocking** — All synthesis runs in dedicated Web Workers
3. **Deterministic output order** — Parallel FIFO ensures results arrive in request order
4. **Hot-swap model switching** — Change voices without interrupting active synthesis

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
```

### Post-Install Setup (Tier 1: Local Assets)

For the default entry point, WASM and binary assets must be served from your project's static folder:

```bash
npx piper-farm init
```

This CLI command:
- **Intelligent Detection**: Specifically handles SvelteKit projects (`static/assets`).
- **Universal Default**: Defaults to the modern `public/assets` convention used by **Angular (v17+)**, **Next.js**, **Vite**, and **React**.
- Copies all required assets to the appropriate directory.
- Provides next-step guidance.

**Skip this step if using the CDN entry point (`piper-timing-farm/cdn`).**

---

## Quick Start

### Tier 1: Local Assets (Recommended for Production)

```typescript
import { createPiperProvider, PIPER_MODELS } from 'piper-timing-farm';

const provider = createPiperProvider();

// Initialize with a model from the registry
const model = PIPER_MODELS.find(m => m.id === 'en_US-bryce-medium');
await provider.init({
  modelId: model.id,
  voiceId: model.id,
  cpuInstances: 2  // Number of parallel workers
});

// Synthesize text
const result = await provider.synthesize('Hello, world!', {
  speed: 1.0,   // Speech rate multiplier
  volume: 0.9   // Volume scaling
});

// Access audio and timing data
const audioBlob = new Blob([result.audioData], { type: 'audio/wav' });
const durations = result.metadata.durations;  // Per-phoneme timing in ms
```

### Tier 2: CDN Assets (Zero-Config)

```typescript
import { createPiperProvider, PIPER_MODELS, PIPER_REPO_BASE_URL } from 'piper-timing-farm/cdn';

const provider = createPiperProvider();
await provider.init({
  modelId: 'en_US-bryce-medium',
  voiceId: 'en_US-bryce-medium',
  cpuInstances: 2
});

// All assets load from jsDelivr CDN, cached to OPFS on first use
const result = await provider.synthesize('Hello from the cloud!');
```

---

## Architecture

### Worker Farm Pattern

The library uses a **Worker Farm** architecture where multiple persistent Web Workers process synthesis requests in parallel:

```
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

| Component | File | Purpose |
|-----------|------|---------|
| `create-piper-provider()` | Provider | High-level API with download management |
| `piper-timing-farm/worker` | `handleSynthesize()` | Direct worker logic (Advanced) |
| [`createPiperWorkerFarm`](src/farm/create-piper-worker-farm.ts) | Farm | Queue management and worker distribution |
| [`process-piper-synthesis.worker`](src/worker/process-piper-synthesis.worker.ts) | Worker | ONNX inference and phonemization |
| [`createAssetDownloadController`](src/farm/control-asset-download.ts) | Downloader | Model asset download orchestration |

---

## Entry Points

| Entry | Import Path | Asset Source | Use Case |
|-------|-------------|--------------|----------|
| **Tier 1** | `'piper-timing-farm'` | Local `/assets/` | Production, offline apps |
| **Tier 2** | `'piper-timing-farm/cdn'` | jsDelivr CDN | Prototyping, no setup |

### Tier 1: Local Assets

Assets are served from your project's static directory (provisioned via `npx piper-farm init`):

- Piper WASM: `/assets/piper_phonemize.wasm`
- Piper Data: `/assets/piper_phonemize.data`
- Piper JS: `/assets/piper_phonemize.js`
- ONNX Runtime: `/assets/ort.wasm.min.mjs`, `/assets/ort-wasm-simd-threaded.mjs`, `/assets/ort-wasm-simd-threaded.wasm`

### Tier 2: CDN Assets

All assets load from jsDelivr:

```typescript
// Piper phonemizer
'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/'

// ONNX Runtime
'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/'
```

**OPFS caching ensures assets are only downloaded once**, regardless of entry point.

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

**Implementation:** See `processQueue()` in [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts) for the exact draining behavior.

```typescript
function processQueue() {
  // 1. Resolve completed FIFO requests
  while (queue.length > 0 && queue[0].result) {
    const first = queue.shift()!;
    first.resolve(first.result as any);
  }

  // 2. Assign pending requests to idle workers
  const nextRequest = queue.find(r => !r.result && !isCurrentlyProcessing(r.requestId));
  if (nextRequest) {
    // ... Adaptive handoff logic (if transitioning) ...

    const worker = pool.getNextAvailable();
    if (worker) {
      worker.busy = true;
      processingRequestIds.add(nextRequest.requestId);
      worker.worker.postMessage({
        type: 'synthesize',
        text: nextRequest.text,
        requestId: nextRequest.requestId,
        speed: nextRequest.speed,
        pitch: nextRequest.pitch,
        volume: nextRequest.volume,
        speakerId: nextRequest.speakerId
      });
    }
  }
}
```

---

### Shadow Pool Model Transitions

When switching models during active synthesis, the library uses a **Shadow Pool** pattern to achieve gapless transitions:

1. **Pre-spawn workers** for the new model in the background
2. **Parallel warm-up** while current workers finish their tasks
3. **Atomic handoff** once shadow pool is ready

**Timeline Example:**

```
[T0] Model A active, 2 workers processing queue
[T1] User requests Model B
     → Shadow pool spawned (2 new workers)
     → Shadow workers initialize in background
[T2] Model A workers complete current tasks
     → Model A workers terminated
     → Shadow pool promoted to active
[T3] Queue continues with Model B (zero gap)
```

**Implementation:** See `reinit(config)` in [`control-worker-pool.ts`](src/farm/control-worker-pool.ts).

```typescript
async reinit(config: Partial<PiperWorkerConfig>) {
  // 1. Spawn Shadow Pool
  // ... Loop spawning workers and storing initPromises ...
  
  // 2. Wait for Shadow Pool to be READY
  await Promise.all(initPromises);
  
  // 3. Promote Shadow Pool & Retire Old Workers
  const oldWorkers = [...workers];
  workers = shadowPool;
  activeModelId = newConfig.modelId;
  currentConfig = newConfig;
  
  // 4. Graceful Retirement: Old workers finish current task then die
  oldWorkers.forEach(w => {
    if (!w.busy) {
      w.worker.terminate();
    } else {
      // Worker is busy, wait for its last result then kill it
      const cleanupHandler = (e: MessageEvent) => {
        if (e.data.type === 'success' || e.data.type === 'error') {
          w.worker.removeEventListener('message', cleanupHandler);
          w.worker.terminate();
        }
      };
      w.worker.addEventListener('message', cleanupHandler);
    }
  });
}
```

**Adaptive Handoff:** Unstarted queue items automatically adopt the new model once the shadow pool is ready. See `processQueue()` in [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts).

---

### OPFS Read-Through Cache

All model and WASM assets are cached in the **Origin Private File System (OPFS)** for persistence across sessions:

1. **Check OPFS** — If asset exists, return immediately
2. **Fetch from network** — If missing, download with Range support
3. **Verify SHA-256** — High-performance one-time integrity check performed during the download/caching phase. Subsequent loads from OPFS are trusted for maximum speed.
4. **Write to OPFS** — Store for future sessions

**Implementation:** [`resolve-opfs-asset.ts`](src/utils/resolve-opfs-asset.ts)

```typescript
export async function resolveOpfsAsset(
  url: string,
  modelId: string,
  extension: string,
  expectedSha256?: string,
  options?: { signal?: AbortSignal; prioritizeSelected?: boolean }
): Promise<ArrayBuffer> {
  const root = await navigator.storage.getDirectory();
  const voicesDir = await root.getDirectoryHandle("voices", { create: true });
  
  // 1. Try OPFS first
  try {
    const fileHandle = await voicesDir.getFileHandle(filename);
    const file = await fileHandle.getFile();
    if (file.size > 0) return await file.arrayBuffer();
  } catch { /* Not found, proceed to fetch */ }
  
  // 2. Fetch with Range support (resumable downloads)
  const response = await fetch(url, fetchOptions);
  
  // 3. Write/Append to OPFS
  const writable = await fileHandle.createWritable({ keepExistingData: isRange });
  await writable.write(buffer);
  await writable.close();
  
  // 4. Verify SHA-256 if provided
  if (expectedSha256) await verifySha256(finalBuffer, expectedSha256, url);
  
  return finalBuffer;
}
```

**Cache Location:** `navigator.storage.getDirectory().getDirectoryHandle("voices")`

**Cache Clearing:** [`resolve-cache-clearing.ts`](src/utils/resolve-cache-clearing.ts)

*Note: The high-level provider automatically calls `resolveCacheClearing()` first, then terminates the internal farm, ensuring no OPFS locks remain during the wipe.*

```typescript
await provider.clearPiperModelCache();  // Purges all cached models
```

---

### Download Controller

The [`createAssetDownloadController`](src/farm/control-asset-download.ts) manages concurrent model downloads with:

- **Deduplication** — Same model requested twice returns same promise
- **Prioritization** — Selected model gets bandwidth priority
- **Cancellation** — Abort downloads and purge partial OPFS files
- **Observability** — Real-time state snapshot for UI progress indicators

**State Machine:**

```
queued → downloading → complete
          ↓
        paused → downloading (resumed)
          ↓
        cancelled (OPFS purged)
          ↓
        error
```

**API:**

```typescript
const downloader = createAssetDownloadController();

// Request a model download
await downloader.request(modelId, { onnx, config }, { onnx: 'sha256hash...' });

// Prioritize the currently selected model (pauses others)
downloader.prioritize(modelId);

// Cancel and cleanup
await downloader.cancel(modelId);

// Get state snapshot for UI
const state = downloader.getState();
// Map<string, DownloadState> where DownloadState = {
//   modelId, state, bytesDownloaded, bytesTotal, progress, error
// }
```

**Integration:** The [`createPiperProvider`](src/providers/create-piper-provider.ts) exposes download state:

```typescript
const provider = createPiperProvider();
const downloadState = provider.getDownloadState();
await provider.cancelDownload('en_US-libritts-high');
```

---

### Speaker ID Support

Multi-speaker models (e.g., `en_US-libritts-high` with 904 speakers) support per-request speaker selection:

```typescript
// Single-speaker model: speakerId always 0
await provider.synthesize('Hello');

// Multi-speaker model: select speaker
await provider.synthesize('Hello', { speakerId: 42 });
```

**Validation:** Invalid speaker IDs fall back to 0 with a warning:

```typescript
// Worker logs: "speakerId 999 out of range (0-903), falling back to 0"
await provider.synthesize('Hello', { speakerId: 999 });
```

**Implementation:** See `resolveSpeakerId()` in [`process-piper-synthesis.worker.ts`](src/worker/process-piper-synthesis.worker.ts).

```typescript
function resolveSpeakerId(requested: number | undefined, config: ModelConfig): number {
  const speakerCount = Object.keys(config.speaker_id_map).length;
  if (speakerCount === 0) return 0;  // Single-speaker model
  
  const sid = requested ?? 0;
  if (sid < 0 || sid >= speakerCount) {
    warn(`speakerId ${sid} out of range (0-${speakerCount - 1}), falling back to 0`);
    return 0;
  }
  return sid;
}
```

**Result Metadata:** The actual speaker ID used is returned in the result:

```typescript
const result = await provider.synthesize('Hello', { speakerId: 5 });
console.log(result.metadata.speakerId);  // 5 (or 0 if fallback)
```

---

### Worker-Thread Callbacks

For lipsync/viseme applications, you can inject a callback module that runs **inside the worker thread** after each synthesis:

```typescript
await provider.init({
  modelId: 'en_US-bryce-medium',
  voiceId: 'en_US-bryce-medium',
  cpuInstances: 2,
  callbackModule: {
    path: '/js/my-viseme-processor.js',
    functionName: 'processVisemes'
  }
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
  const visemes = result.metadata.phonemes.map(p => phonemeToViseme(p));
  
  // Return is attached to synthesis result as callbackResult
  return { visemes, timestamps: computeTimestamps(result.metadata.durations) };
}
```

**Result Access:**

```typescript
const result = await provider.synthesize('Hello');
const { visemes, timestamps } = result.callbackResult;
```

**Transfer Optimization:** The library automatically detects `ArrayBuffer` and `TypedArray` objects in callback results and includes them in the `postMessage` transfer list. Non-transferable return values (plain objects, strings, numbers) are copied via structured clone.

```typescript
// Audio buffer is always transferred. Callback result buffers are detected and transferred where possible.
postMessage({ type: 'success', result, callbackResult }, {
  transfer: [audio.buffer, ...collectTransferables(callbackResult)]
});
```

---

## API Reference

The CDN entry point provides byte-for-byte parity with Tier 1, including full download management and model transition orchestration.

---

### Advanced: Direct Worker Usage

For power users building custom orchestration, the core synthesis worker logic is exported separately. This allows you to host the worker yourself or integrate it into an existing worker pool.

```typescript
// Define your own worker or use the built-in one
import { handleSynthesize } from 'piper-timing-farm/worker';

self.onmessage = async (e) => {
  const { type, text, requestId, speed, volume, speakerId } = e.data;
  if (type === 'synthesize') {
    await handleSynthesize(text, requestId, { speed, volume, speakerId });
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
await provider.clearPiperModelCache();
await provider.cancelDownload(modelId: string);
provider.terminate();
provider.prepareTransition(targetModelId: string);

// Properties
provider.isInitialized(): boolean;
provider.getActiveModelId(): string | null;
provider.getDownloadState(): Map<string, DownloadState>;
provider.metrics: { queueLength, busyWorkers, totalWorkers };
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
  voiceId: string;            // Voice identifier (usually matches modelId)
  modelId: string;            // Model identifier (e.g., 'en_US-bryce-medium')
  cpuInstances?: number;      // Number of parallel workers (default: 2)
  prioritizeSelected?: boolean; // Download prioritization (default: true)
  modelUrls?: {               // Optional: Custom model URLs
    onnx: string;
    config: string;
  };
  onnxRuntimePaths?: OnnxRuntimePaths;
  piperPaths?: PiperPaths;
  callbackModule?: CallbackModuleConfig;
  modelSha256?: string;       // Optional: SHA-256 for model integrity
  configSha256?: string;      // Optional: SHA-256 for config integrity
}
```

### `SynthesizeOptions`

```typescript
interface SynthesizeOptions {
  speed?: number;     // Speech rate multiplier (default: 1.0)
  volume?: number;    // Volume scaling (default: 1.0)
  speakerId?: number; // Speaker selection for multi-speaker models
}
```

### `OnnxRuntimePaths`

```typescript
interface OnnxRuntimePaths {
  wasm: string;       // Path to the WASM binaries folder
  mjs: string;        // Path to ort.wasm.min.mjs
  mjsHelper: string;  // Path to ort-wasm-simd-threaded.mjs
}
```

### `PiperPaths`

```typescript
interface PiperPaths {
  piperWasm: string;  // Path to piper_phonemize.wasm
  piperJs: string;    // Path to piper_phonemize.js
  piperData: string;  // Path to piper_phonemize.data
}
```

### `AudioSynthesisResult`

```typescript
interface AudioSynthesisResult {
  audioData: Float32Array;    // Raw audio samples
  sampleRate: number;         // Audio sample rate (e.g., 22050)
  durationMs: number;         // Total audio duration in milliseconds
  metadata: PiperMetadata & {
    generationTimeMs?: number;  // Synthesis processing time
    speakerId?: number;         // Speaker ID used (after validation)
  };
  // Note: the return type is an intersection: `{ ... } & { callbackResult?: any }`
}

interface PiperMetadata {
  modelId?: string;           // Model ID used for this synthesis
  phonemeIds: number[];       // Phoneme ID sequence
  phonemes?: string[];        // Phoneme symbol sequence
  durations?: Float32Array;   // Per-phoneme timing in ms
  totalAudioDurationMs: number;
  sampleRate: number;
  hopSize: number;            // VITS hop size (256)
}
```

---

## CLI: Asset Provisioning

### `npx piper-farm init [target-path]`

Provisions WASM and binary assets to your project's static directory.

**Framework Detection:**

| Framework | Detection Strategy | Default Target |
|-----------|---------------|----------------|
| SvelteKit | Detects `svelte.config.js` | `static/assets` |
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
>     piperWasm: '/custom/piper_phonemize.wasm',
>     piperData: '/custom/piper_phonemize.data',
>     piperJs:   '/custom/piper_phonemize.js'
>   }
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

| File | Size | Purpose |
|------|------|---------|
| `piper_phonemize.wasm` | ~620KB | Piper phonemization engine |
| `piper_phonemize.data` | ~17MB | eSpeak-ng language data |
| `piper_phonemize.js` | ~118KB | Emscripten glue code |
| `ort.wasm.min.mjs` | ~50KB | ONNX Runtime minimal module |
| `ort-wasm-simd-threaded.mjs` | ~24KB | ONNX Runtime WASM (SIMD+threads) glue |
| `ort-wasm-simd-threaded.wasm` | ~12MB | ONNX Runtime WASM engine binary |

---

## Model Registry

The [`PIPER_MODELS`](src/expose-piper-models.ts) export provides pre-configured model definitions:

```typescript
import { PIPER_MODELS, PIPER_REPO_BASE_URL } from 'piper-timing-farm';

// Find a model
const model = PIPER_MODELS.find(m => m.id === 'en_US-bryce-medium');

// Model structure
interface PiperModelDefinition {
  id: string;              // 'en_US-bryce-medium'
  name: string;            // 'Bryce'
  language: string;        // 'en'
  country: string;         // 'US'
  gender?: 'male' | 'female' | 'multi';
  quality: 'low' | 'medium' | 'high';
  modelUrl: string;        // HuggingFace URL
  configUrl: string;       // HuggingFace URL
  numSpeakers: number;     // 1 for single-speaker
  isMultiSpeaker: boolean; // Derived from numSpeakers
  speakerId: number;       // Default speaker (0)
  modelSha256?: string;    // SHA-256 hash for integrity
  configSha256?: string;   // SHA-256 hash for integrity
}
```

**Available Models & Licenses:**

| Language | Model Name | Quality | License | Dataset / Training info |
|---|---|---|---|---|
| English (en_US) | Bryce | medium | Public Domain | Recorded by Bryce Beattie |
| English (en_US) | Ljspeech | high | Public Domain | LJSpeech dataset |
| English (en_US) | Kristin | medium | CC-BY 4.0 | Recorded by Kristin (LibriVox) |
| English (en_US) | Arctic | medium | Public Domain | CMU Arctic dataset |
| English (en_GB) | Cori | medium | CC-BY 4.0 | Recorded by Cori |
| English (en_US) | Libritts | high | CC-BY 4.0 | LibriTTS dataset (904 speakers) |
| Dutch (nl_NL) | Alex | medium | CC0 | Finetuned from rdh (Safe) |
| Dutch (nl_BE) | Rdh | medium | CC0 | Trained from scratch |
| Swedish (sv_SE) | Alma | medium | CC-BY 4.0 | NST Swedish TTS dataset |
| Swedish (sv_SE) | Nst | medium | CC0 | Trained from scratch (KBLab) |
| Ukrainian (uk_UA) | UkrainianTts | medium | CC-BY 4.0 | Multi-speaker Ukrainian |

**Model Source:** HuggingFace repository at `PIPER_REPO_BASE_URL`:

```
https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/
```

---

## Low-Latency Implementation Details

### Zero-Copy Transfer

The `audioData` buffer (`Float32Array`) is always transferred via `postMessage` with `transfer`, moving the underlying memory from the worker to the main thread without copying.

For worker-thread callback results, the library recursively walks the return value and transfers any `ArrayBuffer` or `TypedArray` buffers it finds. The following types are detected:

| Type | Transferred | Example |
|------|-------------|---------|
| `ArrayBuffer` | ✅ Zero-copy | Raw binary data |
| `Float32Array` | ✅ Zero-copy | Audio samples, timing data |
| `Uint16Array`, `Int32Array`, etc. | ✅ Zero-copy | Any TypedArray backed by an `ArrayBuffer` |
| Plain objects, strings, numbers | ❌ Copied | Serialized via structured clone |

**Note:** Transfer performance depends on what your callback returns. Returning `TypedArray` objects enables zero-copy transfer. Returning plain objects or deeply nested non-buffer data will fall back to the browser's standard structured clone algorithm.

**Effect:** The `audioData` buffer (typically hundreds of thousands of samples) moves between threads with zero serialization cost. Small metadata fields (phoneme IDs, model ID, etc.) are copied, which is negligible at their size.

### Single-Threaded Workers

Each worker uses `ortInstance.env.wasm.numThreads = 1` to prevent internal ONNX threading from competing with the worker pool:

```typescript
// process-piper-synthesis.worker.ts
ortInstance.env.wasm.numThreads = 1;  // Enforce single thread per worker
```

**Rationale:** A 4-worker pool with each worker using 4 internal threads would spawn 16 threads, causing context-switch overhead. Single-threaded workers with external load balancing is more efficient.

### OPFS Fast-Path

Cached assets bypass network entirely:

```typescript
// resolve-opfs-asset.ts
if (file.size > 0) {
  return await file.arrayBuffer();  // Fast-path: Trust the cache
}
```

**Effect:** Subsequent sessions load models in ~50ms (OPFS read) vs ~5s (network download).

### Resumable Downloads

If a download is interrupted (network loss, cancellation), the next attempt resumes from the last byte:

```typescript
if (downloadedBytes > 0) {
  headers['Range'] = `bytes=${downloadedBytes}-`;
}
```

**Effect:** Large model downloads (30MB+) can survive network interruptions without restarting from zero.

---

## Browser Requirements

### Required APIs

| API | Purpose | Browser Support |
|-----|---------|-----------------|
| Web Workers | Parallel synthesis | All modern browsers |
| OPFS | Asset caching | Chrome 86+, Firefox 111+, Safari 15.2+ |
| SHA-256 (Web Crypto) | Integrity verification | All modern browsers |

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
  DownloadState,
  DownloadController,
  PiperMetadata,
  SynthesizeOptions,
  PendingRequest,
  WorkerState,
  PiperWorkerMessageIn,
  PiperWorkerMessageOut,
  PiperModelConfig
} from 'piper-timing-farm';

import { 
  type PiperModelDefinition,  // Re-exported from expose-piper-models
  PIPER_MODELS, 
  PIPER_REPO_BASE_URL 
} from 'piper-timing-farm';
```

See [`src/types/index.ts`](src/types/index.ts) for complete definitions.

---

## License

MIT © Rinaldo Wouterson
