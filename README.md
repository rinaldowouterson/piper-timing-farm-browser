# Piper Timing Farm

A multi-threaded Text-to-Speech engine for browser applications, providing phoneme-level timing data through patched Piper models.

[![Release](https://img.shields.io/npm/v/piper-timing-farm)](https://www.npmjs.com/package/piper-timing-farm)
[![License](https://img.shields.io/npm/l/piper-timing-farm)](https://github.com/rinaldo/piper-timing-farm/blob/main/LICENSE)

---

## Overview

`piper-timing-farm` is a TypeScript library for browser-based Text-to-Speech synthesis. It extends the Piper TTS system with the following capabilities:

- **Multi-threaded processing**: Synthesis operations execute in Web Workers, isolating computation from the main thread
- **Order-preserving parallel execution**: Multiple synthesis requests process concurrently while results return in request order (FIFO sequencing)
- **Phoneme duration metadata**: Patched Piper models expose per-phoneme timing data for synchronization applications (lipsync, captions)
- **OPFS-based asset caching**: Models and WASM binaries persist in the Origin Private File System for offline operation
- **SHA-256 integrity verification**: All binary assets undergo mandatory cryptographic verification on every read before execution

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Browser Support](#browser-support)
- [Architecture](#architecture)
- [Asset Resolution](#asset-resolution)
- [Core Features](#core-features)
  - [Parallel FIFO Sequencer](#parallel-fifo-sequencer)
  - [Model Switching Lifecycle](#model-switching-lifecycle)
  - [OPFS Read-Through Cache](#opfs-read-through-cache)
  - [Download Controller](#download-controller)
  - [Speaker ID Support](#speaker-id-support)
  - [Sovereign Worker Callbacks](#sovereign-worker-callbacks)
- [Security Architecture](#security-architecture)
- [API Reference](#api-reference)
- [CLI: Asset Provisioning](#cli-asset-provisioning)
- [Model Registry](#model-registry)
- [Implementation Details](#implementation-details)
- [Debugging & Troubleshooting](#debugging--troubleshooting)
- [Type Definitions](#type-definitions)
- [Migration Guide](#migration-guide)
- [FAQ](#faq)

---

## Installation

```bash
npm install piper-timing-farm
```

The `onnxruntime-web` peer dependency documents the ONNX Runtime version used internally. WASM binaries are bundled in the build output and provisioned via `npx piper-farm init`. No separate installation is required.

**Customizing ONNX Runtime version**: After running `npx piper-farm init`, edit `public/control-asset-sw.js` to update the hardcoded SHA-256 hashes (`INFRA_SHA256_REGISTRY`) and CDN URLs (`INFRA_CDN_REGISTRY`). Replace the corresponding WASM files in `public/piper-gate/infra/`. The Service Worker has root scope (`/`), allowing you to expand interception to additional asset paths.

---

## Quick Start

### Step 1: Provision Assets

Copy WASM binaries and the Service Worker to your public folder:

```bash
npx piper-farm init
```

This CLI command detects your framework (SvelteKit, Vite, Next.js, etc.) and copies assets to the appropriate static directory.

### Step 2: Initialize the Provider

```typescript
import { createPiperProvider } from "piper-timing-farm";

const provider = createPiperProvider();

await provider.init({
  modelId: "en_US-bryce-medium",
  onProgress: (state) => console.log(`Downloading: ${Math.round(state.progress * 100)}%`)
});
```

The Service Worker handles model fetching and OPFS caching. Subsequent sessions load from cache rather than network.

### Step 3: Synthesize

```typescript
const result = await provider.synthesize("Hello world!");

console.log(result.durationMs);              // Total audio duration
console.log(result.metadata.durations);      // Per-phoneme timing (Float32Array)
console.log(result.metadata.phonemes);       // Phoneme symbols (string[])
```

### Playing the Audio

The synthesis result contains raw PCM samples (`Float32Array`) rather than encoded audio. A reusable player encapsulates the `AudioContext` lifecycle, handles browser suspension policies, and exposes playback control:

```typescript
/**
 * Creates a reusable audio player with a persistent AudioContext.
 * The context is lazily initialized on first playback to satisfy
 * browser "user interaction" requirements.
 */
const createPiperPlayer = () => {
  let ctx: AudioContext | null = null;
  let activeSource: AudioBufferSourceNode | null = null;

  const play = async (audioData: Float32Array, sampleRate: number) => {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();

    // Stop any currently playing audio before starting new playback
    activeSource?.stop();

    const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
    buffer.copyToChannel(audioData, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();

    activeSource = source;
    source.onended = () => { activeSource = null; };

    return source;
  };

  return {
    play,
    stop: () => { activeSource?.stop(); activeSource = null; },
    suspend: () => ctx?.suspend(),
    resume: () => ctx?.resume(),
    dispose: () => { activeSource?.stop(); ctx?.close(); ctx = null; activeSource = null; },
  };
};
```

**Usage:**

```typescript
const player = createPiperPlayer();

// Basic playback
const result = await provider.synthesize("Hello world!");
await player.play(result.audioData, result.sampleRate);

// Interrupt: calling play() again stops the previous audio automatically
const next = await provider.synthesize("New sentence.");
await player.play(next.audioData, next.sampleRate);

// Pause and resume
player.suspend();   // Freezes playback at current position
player.resume();    // Continues from where it was suspended

// Manual stop
player.stop();

// Release resources when the player is no longer needed
player.dispose();
```

**Design rationale**: The closure maintains a single `AudioContext` across invocations, avoiding the browser's hard limit on concurrent contexts (typically 6–50 depending on vendor). `copyToChannel` is used over `getChannelData().set()` for direct memory transfer without intermediate copying. The `activeSource` reference enables interrupt semantics — essential for conversational UIs where new synthesis may arrive before the previous utterance completes.

---

## Browser Support

The library requires modern browsers supporting Web Workers, WebAssembly, and OPFS.

| Browser | Minimum Version | Notes |
| :--- | :--- | :--- |
| Chrome | 86+ | SIMD + threading support |
| Edge | 86+ | Chromium-based, identical to Chrome |
| Firefox | 111+ | Full OPFS compliance |
| Safari | 15.2+ | OPFS support required |

**Secure Context Requirement**: The library requires `https://` or `localhost` for SHA-256 verification and Service Worker operation. Insecure contexts (`http://`) suspend integrity checks with a console warning.

---

## Architecture

### Worker Farm Pattern

The library employs a Worker Farm architecture where persistent Web Workers process synthesis requests in parallel:

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

### Components

| Component | File | Role |
| :--- | :--- | :--- |
| Provider | [`create-piper-provider.ts`](src/providers/create-piper-provider.ts) | High-level API, lifecycle management |
| Service Worker | [`control-asset-sw.ts`](src/control-asset-sw.ts) | Asset interception, OPFS streaming |
| Worker Farm | [`create-piper-worker-farm.ts`](src/farm/create-piper-worker-farm.ts) | Queue management, worker distribution |
| Synthesis Worker | [`process-piper-synthesis.worker.ts`](src/worker/process-piper-synthesis.worker.ts) | ONNX inference, phonemization |
| Download Controller | [`control-asset-download.ts`](src/farm/control-asset-download.ts) | Model download orchestration |

### Service Worker Role

The Service Worker is registered at root (`/control-asset-sw.js`) with scope `/`, enabling interception of all same-origin requests. By default, it handles `/piper-gate/*` paths with a three-tier resolution chain:

1. **OPFS (fast path)**: If the asset exists in OPFS, it is read and SHA-256 verified in-memory. If valid, it is served immediately.
2. **Local server**: If not cached or corrupted, check the local `/piper-gate/` directory
3. **CDN fallback**: If missing locally, fetch from jsDelivr CDN

This architecture keeps large model binaries out of the main thread's memory heap. The Service Worker streams data directly to OPFS using `FileSystemWritableFileStream`.

**Root Scope Design**: The SW intercepts same-origin requests matching `/piper-gate/*` by default. Consumers can modify [`control-asset-sw.ts`](src/control-asset-sw.ts:220) to expand interception to additional paths (e.g., custom asset directories). Cross-origin requests pass through unaffected.

```typescript
// control-asset-sw.ts — fetch event handler (default)
if (url.origin !== sw.location.origin) return;  // Skip cross-origin
if (!url.pathname.startsWith('/piper-gate/')) return;  // Consumers can modify this
```

---

## Asset Resolution

All binary dependencies resolve through a single logical path: `/piper-gate/*`.

| Asset Type | Path Pattern | Source |
| :--- | :--- | :--- |
| Piper WASM | `/piper-gate/infra/piper_phonemize.*` | `@diffusionstudio/piper-wasm` |
| ONNX Runtime | `/piper-gate/infra/ort*` | `onnxruntime-web` |
| Voice Models | `/piper-gate/voices/*.onnx` | HuggingFace (default) or custom URLs |

### Resolution Chain

1. **OPFS check**: Verify asset integrity using SHA-256 (mandatory on every read)
2. **Auto-fetch SHA-256**: For HuggingFace URLs, retrieve hash from HF API (`lfs.oid` field)
3. **Network fetch**: Stream asset if missing or hash mismatch
4. **In-memory verification**: SHA-256 check before OPFS write
5. **Cache write**: Persist verified asset to OPFS

### Local Hosting Benefits

While CDN fallback works automatically, local hosting provides:

- **Network independence**: Corporate firewalls often block public CDNs
- **Offline-first operation**: Assets available on first visit in PWA contexts
- **Version consistency**: Guaranteed binary versions across deployment stages

---

## Core Features

### Parallel FIFO Sequencer

When multiple synthesis requests arrive simultaneously, workers process them in parallel. However, results must return in request order to maintain deterministic behavior.

**Problem**: A short text may complete synthesis before a longer text submitted earlier.

**Solution**: The FIFO sequencer buffers completed results until all preceding requests resolve:

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

Implementation: [`processQueue()`](src/farm/create-piper-worker-farm.ts) in `create-piper-worker-farm.ts`.

### Request Correlation

The library supports explicit request IDs for UI correlation:

```typescript
const result = await provider.synthesize("Hello", {
  requestId: "msg-001"  // Your correlation ID (UUID, ULID, etc.)
});

console.log(result.requestId);  // "msg-001" — guaranteed match
```

If no ID is provided, the library generates a `crypto.randomUUID()`.

### Queue Observability

Track request state transitions through the queue:

```typescript
const unsubscribe = provider.onQueueStatus((payload) => {
  const { requestId, text, state, modelId, error } = payload;
  
  switch(state) {
    case 'queued':      console.log(`Request ${requestId} waiting...`); break;
    case 'processing':  console.log(`Request ${requestId} synthesizing...`); break;
    case 'completed':   console.log(`Request ${requestId} finished.`); break;
    case 'cancelled':   console.log(`Request ${requestId} aborted.`); break;
    case 'error':       console.error(`Request ${requestId} failed: ${error}`); break;
  }
});
```

State transitions: `queued → processing → completed` (or `cancelled` / `error`).

---

### Model Switching Lifecycle

Model initialization proceeds through two sequential phases.

#### Phase 1: Download Queue

When `provider.init({ modelId: 'model-c' })` is called:

1. **Queue**: Model added to FIFO download queue (sequential downloads prevent OPFS write contention)
2. **Download**: Fetch `.onnx` model and `.onnx.json` config with progress tracking
3. **Verify**: Mandatory SHA-256 integrity check
4. **Cache**: Buffer in memory for SHA-256 verification, then write to OPFS

```text
User requests: Model A → Model B → Model C (rapid succession)

[T0] Model A starts downloading
[T1] Model B queued behind A
[T2] Model C queued behind B
[T3] Model A completes → Phase 2 begins for A
[T4] Model B starts downloading
[T5] Model B completes → Model C starts
[T6] Model C completes → all cached
```

**Queue skipping**: Call `provider.cancelDownload(modelId)` to remove pending downloads and allow subsequent models to start immediately.

#### Phase 2: Worker Pool Transition

After download completion, the library creates new Web Workers:

1. **Stale check**: Verify this is still the most recent `init()` request
2. **Shadow pool**: Spawn new workers loading the ONNX model from OPFS
3. **Promotion**: Once all shadow workers report `ready`, replace active pool
4. **Retirement**: Old workers finish current tasks, then terminate

**Memory bound**: At most one active pool + one shadow pool exist simultaneously. Rapid `init()` calls trigger shadow pool abortion before new pool creation.

Implementation: [`reinit()`](src/farm/control-worker-pool.ts) in `control-worker-pool.ts`.

#### Surgical Re-initialization

If only the `callbackModule` changes (same model), workers dynamically import the new callback script without reloading WASM/ONNX. This avoids model reload overhead.

---

### OPFS Read-Through Cache

Assets persist in the Origin Private File System across sessions.

#### Directory Structure

| Directory | Contents | Cleared by `clearPiperModelCache()` / `deletePiperModel()` |
| :--- | :--- | :--- |
| `voices/` | Model weights (`.onnx`, `.onnx.json`) | Yes |
| `infra/` | Engine binaries (WASM, glue JS) | No |

**Rationale**: Cache clearing purges user models but preserves core engine binaries. Subsequent sessions only re-download model weights.

#### Cache Performance

- **First session**: Download all assets
- **After cache clear**: Re-download models only
- **Subsequent sessions**: OPFS load

Implementation: [`resolve-cache-clearing.ts`](src/utils/resolve-cache-clearing.ts) — delegates to the Service Worker via `DELETE /piper-gate/voices/`.

---

### Download Controller

The [`createAssetDownloadController`](src/farm/control-asset-download.ts) manages model downloads with:

- **Registry + Queue**: `Map` for state tracking, `Array` for FIFO ordering
- **Deduplication**: Duplicate requests return the same promise
- **Per-model cancellation**: Abort in-flight downloads (RAM-first: nothing written to OPFS until verified)
- **Progress observability**: Callback (push) and snapshot (pull) mechanisms

#### State Machine

```text
pending → downloading → complete
              ↓
            error
```

| State | Meaning | Available Action |
| :--- | :--- | :--- |
| `pending` | Queued | `cancelDownload()` to remove |
| `downloading` | Active transfer | `cancelDownload()` to abort |
| `complete` | Cached, verified | `deletePiperModel()` to purge cache |
| `error` | Failed | Retry with `init()` |

#### Progress Monitoring

```typescript
// Push: real-time callback
await provider.init({
  modelId: "en_US-bryce-medium",
  onProgress: (state) => {
    console.log(`${state.modelId}: ${(state.progress * 100).toFixed(1)}%`);
  },
});

// Pull: snapshot query
const state = provider.getDownloadState();
// Map<string, DownloadState> with progress for all models
```

---

### Speaker ID Support

Multi-speaker models (e.g., `en_US-libritts-high` with 904 speakers) support per-request speaker selection:

```typescript
// Global default
await provider.init({
  modelId: 'en_US-libritts-high',
  defaultSpeakerId: 42
});

// Per-request override
const result = await provider.synthesize("Hello", { speakerId: 5 });
console.log(result.metadata.speakerId);  // Actual ID used (with fallback)
```

Invalid speaker IDs fall back to `defaultSpeakerId` (defaulting to 0).

---

### Sovereign Worker Callbacks

For post-synthesis processing (e.g., viseme mapping, timestamp computation), the architecture supports the injection of a sovereign callback module that executes within the isolated worker thread.

To utilize this capability, enable the `useCallback` boolean flag during initialization:

```typescript
await provider.init({
  modelId: "en_US-bryce-medium",
  useCallback: true,
});
```

**Sovereign Convention**:
When enabled, the worker thread unconditionally attempts to load a sidecar file named `piper-callback.js` from the origin root. This strict convention enforces uniformity and delegates cryptographic integrity verification entirely to the Service Worker gateway.

**Callback Module Implementation**:
The sidecar module must export a deterministic function named `onSynthesisComplete`:

```javascript
// /piper-callback.js
export function onSynthesisComplete(result) {
  const visemes = result.metadata.phonemes.map(p => phonemeToViseme(p));
  return { visemes, timestamps: computeTimestamps(result.metadata.durations) };
}
```

**Result Access**:
The callback's return value is appended to the synthesis result payload:

```typescript
const result = await provider.synthesize("Hello");
const { visemes, timestamps } = result.callbackResult;
```

**Transfer Optimization**: `ArrayBuffer` and `TypedArray` objects yielded by the callback are transferred via `postMessage` using zero-copy memory transfer mechanisms, mitigating serialization overhead.

---

## Security Architecture

### Integrity Verification Pipeline

| Asset Layer | Integrity Source | Verification Point |
| :--- | :--- | :--- |
| Engine binaries | Hardcoded hashes | Mandatory check on every read |
| Voice models | HuggingFace OID / Registry | Mandatory check on every read |
| Sovereign callbacks | `INFRA_SHA256_REGISTRY` | Service Worker interception |

### SHA-256 Enforcement

All binary assets undergo SHA-256 verification before execution. For HuggingFace URLs, hashes auto-fetch from the HF API (`lfs.oid` field). For custom URLs, provide `modelSha256` / `configSha256` in `FarmConfig`.

**Failure behavior**: Hash mismatch triggers immediate OPFS purge, worker termination, and error rejection.

### Secure Context Requirement

`crypto.subtle.digest()` requires HTTPS or localhost. In insecure contexts:

```typescript
if (!self.crypto?.subtle) {
  warn("Integrity verification suspended: insecure context");
  return true;  // Fail-open for development
}
```

Production deployments must use HTTPS.

### Privacy

- **On-device processing**: All synthesis occurs locally; no data transmits externally
- **Error redaction**: Input text is redacted from error payloads to prevent PII leakage

---

## API Reference

### `createPiperProvider()`

High-level API with download management and model switching.

```typescript
const provider = createPiperProvider();

// Methods
await provider.init(config: FarmConfig);
await provider.synthesize(text: string, options?: SynthesizeOptions);
provider.cancelSynthesis(requestId: string);
provider.cancelAllSynthesis();
await provider.clearPiperModelCache();
await provider.cancelDownload(modelId: string);
await provider.deletePiperModel(modelId: string);
provider.terminate();

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

Lower-level API without download management. Use when handling asset provisioning externally.

```typescript
const farm = createPiperWorkerFarm();

await farm.init(config: FarmConfig);
await farm.reinit(config);
await farm.synthesize(text, options);
await farm.clearPiperModelCache();
farm.onLog((log) => console.log(`[Worker ${log.workerId}] ${log.message}`));
farm.terminate();
```

### `FarmConfig`

```typescript
interface FarmConfig {
  modelId: string;                              // Model identifier
  cpuInstances?: number;                        // Worker count (default: 2)
  modelUrls?: {                                 // Custom model URLs
    onnx: string;
    config: string;
  };
  onnxRuntimePaths?: OnnxRuntimePaths;          // Custom ONNX paths
  piperPaths?: PiperPaths;                      // Custom Piper WASM paths
  useCallback?: boolean;                        // Enable sovereign worker callback
  modelSha256?: string;                         // SHA-256 for custom models
  configSha256?: string;                        // SHA-256 for config
  onProgress?: (state: DownloadState) => void;  // Progress callback
  defaultSpeakerId?: number;                    // Global speaker default
  serviceWorkerUrl?: string;                    // Custom SW path (subpath deployments)
}
```

### `SynthesizeOptions`

```typescript
interface SynthesizeOptions {
  speed?: number;          // Speech rate multiplier (default: 1.0)
  volume?: number;         // Volume scaling (default: 1.0)
  speakerId?: number;      // Speaker for multi-speaker models
  signal?: AbortSignal;    // Cancellation signal
  requestId?: string;      // Correlation ID
}
```

### `AudioSynthesisResult`

```typescript
interface AudioSynthesisResult {
  audioData: Float32Array;                     // Raw audio samples
  sampleRate: number;                          // Audio sample rate
  durationMs: number;                          // Total duration
  metadata: PiperMetadata & {
    generationTimeMs?: number;                 // Processing time
    speakerId?: number;                        // Speaker ID used
  };
  callbackResult?: any;                        // Worker callback output
}

interface PiperMetadata {
  modelId?: string;
  phonemeIds: number[];
  phonemes?: string[];
  durations?: Float32Array;                    // Per-phoneme timing (ms)
  totalAudioDurationMs: number;
  sampleRate: number;
  hopSize: number;                             // VITS hop size (256)
}
```

---

## CLI: Asset Provisioning

### `npx piper-farm init [target-path]`

Provisions WASM and binary assets to your static directory.

**Framework Detection**:

| Framework | Detection | Assets Target | Service Worker |
| :--- | :--- | :--- | :--- |
| SvelteKit | `svelte.config.js` | `static/piper-gate/infra` | `static/control-asset-sw.js` |
| Others | Universal | `public/piper-gate/infra` | `public/control-asset-sw.js` |

The Service Worker is placed at root with scope `/`, allowing consumers to expand interception.

**Custom Path**:

```bash
npx piper-farm init ./public/custom-folder
```

**Assets Provisioned**:

| File | Size | Purpose |
| :--- | :--- | :--- |
| `piper_phonemize.wasm` | ~620KB | Phonemization engine |
| `piper_phonemize.data` | ~17MB | eSpeak-ng language data |
| `piper_phonemize.js` | ~118KB | Emscripten glue |
| `ort.wasm.min.mjs` | ~50KB | ONNX Runtime module |
| `ort-wasm-simd-threaded.mjs` | ~24KB | ONNX WASM glue |
| `ort-wasm-simd-threaded.wasm` | ~12MB | ONNX engine |

### `npx piper-farm hash <file-path>`

Generates a SHA-256 integrity hash for the sovereign callback module (`piper-callback.js`). This hash must be manually registered in `control-asset-sw.js` under the `INFRA_SHA256_REGISTRY` to authorize execution.

```bash
npx piper-farm hash public/piper-callback.js
# [OK] Hash: 5e884898da28...
# [OK] Created sidecar: piper-callback.js.json
```

---

## Model Registry

The [`PIPER_MODELS`](src/expose-piper-models.ts) export provides pre-configured model definitions:

```typescript
import { PIPER_MODELS, PIPER_REPO_BASE_URL } from "piper-timing-farm";

const model = PIPER_MODELS.find(m => m.id === "en_US-bryce-medium");

interface PiperModelDefinition {
  id: string;              // 'en_US-bryce-medium'
  name: string;            // 'Bryce'
  language: string;        // 'en'
  country: string;         // 'US'
  gender?: "male" | "female" | "multi";
  quality: "low" | "medium" | "high";
  modelUrl: string;        // HuggingFace URL
  configUrl: string;       // HuggingFace URL
  numSpeakers: number;
  modelSha256?: string;    // Auto-fetched from HF API
  configSha256?: string;   // Auto-fetched from HF API
}
```

### Available Models

| Language | Model | Quality | License | Notes |
| :--- | :--- | :--- | :--- | :--- |
| English (en_US) | Bryce | medium | Public Domain | Single speaker |
| English (en_US) | Ljspeech | high | Public Domain | LJSpeech dataset |
| English (en_US) | Libritts | high | CC-BY 4.0 | 904 speakers |
| Dutch (nl_NL) | Alex | medium | CC0 | Single speaker |
| Swedish (sv_SE) | Alma | medium | CC-BY 4.0 | NST dataset |
| Ukrainian (uk_UA) | UkrainianTts | medium | CC-BY 4.0 | Multi-speaker |

**Model Source**: `https://huggingface.co/rinaldow/piper-onnx-durations`

---

## Implementation Details

### Zero-Copy Transfer

Audio buffers (`Float32Array`) transfer via `postMessage` with `transfer`, moving memory ownership without copying. Callback result `TypedArray` objects also transfer when detected.

### Single-Threaded Workers

Each worker uses `ortInstance.env.wasm.numThreads = 1` to prevent internal ONNX threading from competing with the worker pool:

```typescript
// process-piper-synthesis.worker.ts
ortInstance.env.wasm.numThreads = 1;
```

**Rationale**: A 4-worker pool with 4 internal threads per worker would spawn 16 threads, causing context-switch overhead. External load balancing is more efficient.


---

## Debugging & Troubleshooting

### Service Worker Bypass

Add `?bypass-sw=true` to asset URLs for debugging:

```text
https://yourdomain.com/piper-gate/infra/piper_phonemize.wasm?bypass-sw=true
```

This forces network fetch without OPFS cache. Use for CDN connectivity testing.

### Worker Identification

Workers are named `PiperWorker-0`, `PiperWorker-1`, etc. in Chrome DevTools:

```text
[PiperWorker:0:CPU] Initializing with model: en_US-bryce-medium
[PiperWorker:0:CPU] Ready
[PiperWorker:0:CPU] Synthesizing: "Hello, world!"
[PiperWorker:0:CPU] Synthesis complete (234ms)
```

Filter console by worker ID to isolate logs.

### Cross-Origin Isolation

The library uses single-threaded workers (`numThreads = 1`), requiring no COOP/COEP headers. Multi-threaded ONNX inference (not recommended) would require:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
---

## Type Definitions

```typescript
import type {
  AudioSynthesisResult,
  FarmConfig,
  PiperWorkerFarm,
  PiperWorkerConfig,
  PiperPaths,
  OnnxRuntimePaths,
  DownloadState,
  PiperMetadata,
  SynthesizeOptions,
  PiperModelDefinition,
} from "piper-timing-farm";

import { PIPER_MODELS, PIPER_REPO_BASE_URL } from "piper-timing-farm";
```

See [`src/types/index.ts`](src/types/index.ts) for complete definitions.

---

## Migration Guide

### Version Changes

1. **`voiceId` removed**: Use `modelId` as the primary identifier
2. **`defaultSpeakerId` added**: Global speaker default in `FarmConfig`
3. **SHA-256 mandatory**: All custom assets require integrity hashes
4. **Hardcoded baselines**: Core engine hashes embedded; no manual management needed

---

## FAQ

### What is phoneme-level timing?

Standard Piper models output audio only. The patched models used by this library include metadata mapping each phoneme to its millisecond duration in the audio. This enables synchronization for lipsync and caption applications.

### Does the library work offline?

Yes. After the first visit downloads and caches assets, subsequent sessions load from OPFS without network access.

### Why is SHA-256 verification mandatory?

Binary WASM and ML model corruption can cause silent crashes or incorrect output. Cryptographic verification ensures assets execute as intended.

### Why use a Service Worker for model delivery?

Main thread fetch of 50MB+ models can cause UI stalls or crashes on mobile devices. The Service Worker streams data directly to OPFS, bypassing main thread memory.

---

## License

MIT © Rinaldo Wouterson
