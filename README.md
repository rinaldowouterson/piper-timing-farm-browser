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

- **Exposes phoneme durations** — The `AudioSynthesisResult.metadata.durations` array provides per-phoneme timing data essential for lipsync applications
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
- Detects your framework (SvelteKit → `static/assets`, Vite/React → `public/assets`)
- Copies all required assets to the appropriate directory
- Provides next-step guidance

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
import { createPiperProvider, PIPER_MODELS } from 'piper-timing-farm/cdn';

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
| [`createPiperProvider`](src/providers/create-piper-provider.ts) | Provider | High-level API with download management |
| [`createPiperWorkerFarm`](src/farm/create-piper-worker-farm.ts) | Farm | Queue management and worker distribution |
| [`createWorkerPool`](src/farm/control-worker-pool.ts) | Pool | Worker lifecycle and load balancing |
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
- ONNX Runtime: `/assets/ort.wasm.min.mjs`, `/assets/ort-wasm-simd-threaded.mjs`

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

**Solution:** The [`resolve-sequencer`](src/farm/resolve-sequencer.ts) holds completed results until all preceding requests have resolved:

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

**Implementation:** [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts:56-61)

```typescript
function processQueue() {
  // 1. Resolve completed FIFO requests
  while (queue.length > 0 && queue[0].result) {
    const first = queue.shift()!;
    first.resolve(first.result);
  }
  // 2. Assign pending requests to idle workers...
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

**Implementation:** [`control-worker-pool.ts`](src/farm/control-worker-pool.ts:58-109)

```typescript
async reinit(config) {
  // 1. Spawn Shadow Pool
  const shadowPool: WorkerState[] = [];
  for (let i = 0; i < count; i++) {
    const worker = createWorker(id, newConfig, onMessage);
    shadowPool.push(worker);
  }
  
  // 2. Wait for Shadow Pool to be READY
  await Promise.all(initPromises);
  
  // 3. Promote Shadow Pool & Retire Old Workers
  workers = shadowPool;
  activeModelId = newConfig.modelId;
  
  // 4. Graceful Retirement: Old workers finish current task then die
  oldWorkers.forEach(w => {
    if (!w.busy) w.worker.terminate();
    else // Wait for last result then terminate
  });
}
```

**Adaptive Handoff:** Unstarted queue items automatically adopt the new model once the shadow pool is ready. See [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts:66-80).

---

### OPFS Read-Through Cache

All model and WASM assets are cached in the **Origin Private File System (OPFS)** for persistence across sessions:

1. **Check OPFS** — If asset exists, return immediately
2. **Fetch from network** — If missing, download with Range support
3. **Verify MD5** — Ensure binary integrity
4. **Write to OPFS** — Store for future sessions

**Implementation:** [`resolve-opfs-asset.ts`](src/utils/resolve-opfs-asset.ts)

```typescript
export async function resolveOpfsAsset(
  url: string,
  modelId: string,
  extension: string,
  expectedMd5?: string,
  options?: { signal?: AbortSignal }
): Promise<ArrayBuffer> {
  const root = await navigator.storage.getDirectory();
  const voicesDir = await root.getDirectoryHandle("voices", { create: true });
  
  // 1. Try OPFS first
  try {
    const file = await voicesDir.getFileHandle(filename);
    return await file.arrayBuffer();  // Fast-path: Trust the cache
  } catch { /* Not found, proceed to fetch */ }
  
  // 2. Fetch with Range support (resumable downloads)
  const response = await fetch(url, { headers, signal });
  
  // 3. Write to OPFS
  const writable = await fileHandle.createWritable();
  await writable.write(buffer);
  await writable.close();
  
  // 4. Verify MD5 if provided
  if (expectedMd5) await verifyMd5(finalBuffer, expectedMd5, url);
  
  return finalBuffer;
}
```

**Cache Location:** `navigator.storage.getDirectory().getDirectoryHandle("voices")`

**Cache Clearing:** [`resolve-cache-clearing.ts`](src/utils/resolve-cache-clearing.ts)

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
await downloader.request(modelId, { onnx, config }, { onnx: 'md5hash...' });

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

**Implementation:** [`process-piper-synthesis.worker.ts`](src/worker/process-piper-synthesis.worker.ts:960-974)

```typescript
function resolveSpeakerId(requested: number | undefined, config: ModelConfig): number {
  const speakerCount = Object.keys(config.speaker_id_map).length;
  if (speakerCount === 0) return 0;  // Single-speaker model
  
  const sid = requested ?? 0;
  if (sid < 0 || sid >= speakerCount) {
    warn(`speakerId ${sid} out of range, falling back to 0`);
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
  // result.metadata.durations - number[] (per-phoneme timing)
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

**Zero-Copy Transfer:** Callback results are transferred (not copied) back to the main thread:

```typescript
// Worker transfers audio buffer + callback result buffers
postMessage({ type: 'success', result, callbackResult }, {
  transfer: [audio.buffer, ...collectTransferables(callbackResult)]
});
```

---

## API Reference

### `createPiperProvider()`

High-level API with download management and model switching.

```typescript
const provider = createPiperProvider();

// Methods
await provider.init(config: FarmConfig);
await provider.reinit(config: Pick<FarmConfig, 'voiceId' | 'modelId' | 'modelUrls'>);
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
  voiceId: string;                    // Voice identifier (usually matches modelId)
  modelId: string;                    // Model identifier (e.g., 'en_US-bryce-medium')
  modelUrls?: {                       // Optional: Custom model URLs
    onnx: string;
    config: string;
  };
  onnxRuntimePaths?: OnnxRuntimePaths; // Optional: Custom ONNX paths (Tier 1 default)
  piperPaths?: PiperPaths;            // Optional: Custom Piper paths (Tier 1 default)
  cpuInstances: number;               // Number of parallel workers (default: 2)
  callbackModule?: CallbackModuleConfig; // Optional: Worker-thread callback
  prioritizeSelected?: boolean;       // Download prioritization (default: true)
}
```

### `SynthesizeOptions`

```typescript
interface SynthesizeOptions {
  speed?: number;     // Speech rate multiplier (default: 1.0)
  pitch?: number;     // Pitch adjustment (default: 1.0)
  volume?: number;    // Volume scaling (default: 1.0)
  speakerId?: number; // Speaker selection for multi-speaker models
}
```

### `AudioSynthesisResult`

```typescript
interface AudioSynthesisResult {
  audioData: Float32Array;    // Raw audio samples
  sampleRate: number;         // Audio sample rate (e.g., 22050)
  durationMs: number;         // Total audio duration in milliseconds
  metadata: {
    generationTimeMs?: number;  // Synthesis processing time
    modelId?: string;           // Model used for this synthesis
    speakerId?: number;         // Speaker ID used (after validation)
    phonemeIds: number[];       // Phoneme ID sequence
    phonemes?: string[];        // Phoneme symbol sequence
    durations?: number[];       // Per-phoneme timing in ms
    totalAudioDurationMs: number;
    sampleRate: number;
    hopSize: number;            // VITS hop size (256)
  };
  callbackResult?: any;        // Result from worker-thread callback
}
```

---

## CLI: Asset Provisioning

### `npx piper-farm init [target-path]`

Provisions WASM and binary assets to your project's static directory.

**Framework Detection:**

| Framework | Detection File | Default Target |
|-----------|---------------|----------------|
| SvelteKit | `svelte.config.js` | `static/assets` |
| Vite/React | `package.json` | `public/assets` |
| Angular | `angular.json` | `public/assets` |
| Next.js | `package.json` | `public/assets` |

**Custom Target:**

```bash
npx piper-farm init ./public/wasm
```

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
| `piper_phonemize.wasm` | ~2MB | Piper phonemization engine |
| `piper_phonemize.data` | ~20MB | eSpeak-ng language data |
| `piper_phonemize.js` | ~10KB | Emscripten glue code |
| `ort.wasm.min.mjs` | ~150KB | ONNX Runtime minimal module |
| `ort-wasm-simd-threaded.mjs` | ~12MB | ONNX Runtime WASM (SIMD+threads) |

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
}
```

**Available Models:**

| ID | Language | Speakers | Quality |
|----|----------|----------|---------|
| `en_US-bryce-medium` | English (US) | 1 | Medium |
| `en_US-ljspeech-high` | English (US) | 1 | High |
| `en_US-kristin-medium` | English (US) | 1 | Medium |
| `en_US-arctic-medium` | English (US) | 1 | Medium |
| `en_GB-cori-medium` | English (UK) | 1 | Medium |
| `en_US-libritts-high` | English (US) | 904 | High |
| `nl_NL-alex-medium` | Dutch (NL) | 1 | Medium |
| `nl_BE-rdh-medium` | Dutch (BE) | 1 | Medium |
| `sv_SE-alma-medium` | Swedish | 1 | Medium |
| `sv_SE-nst-medium` | Swedish | 1 | Medium |
| `uk_UA-ukrainian_tts-medium` | Ukrainian | 3 | Medium |

**Model Source:** HuggingFace repository at `PIPER_REPO_BASE_URL`:

```
https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/
```

---

## Low-Latency Implementation Details

### Zero-Copy Transfer

All audio data and callback results use `postMessage` with `transfer` to avoid serialization overhead:

```typescript
// Worker: Transfer audio buffer directly
postMessage({ type: 'success', result, callbackResult }, {
  transfer: [audio.buffer, ...collectTransferables(callbackResult)]
});
```

**Effect:** The `Float32Array` buffer is transferred (not copied) to the main thread, reducing memory pressure and latency.

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
if (downloadedBytes > 0) {
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
| Web Crypto (MD5) | Integrity verification | All modern browsers |
| SharedArrayBuffer | ONNX threading | Requires COOP/COEP headers |

### Security Headers

For ONNX Runtime's threaded WASM, your server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Vite Dev Server:** Add to `vite.config.ts`:

```typescript
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
```

**Note:** These headers are only required for threaded WASM. The library enforces single-threaded workers (`numThreads = 1`), which works without SharedArrayBuffer in most browsers.

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
  PiperModelDefinition,
  PiperMetadata
} from 'piper-timing-farm';
```

See [`src/types/index.ts`](src/types/index.ts) for complete definitions.

---

## License

MIT © Rinaldo Wouterson
