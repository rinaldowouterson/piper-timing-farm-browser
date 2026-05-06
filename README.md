# Piper Timing Farm Browser

A multi-threaded Text-to-Speech engine for browser applications, providing phoneme-level timing data through patched Piper models.

[![Release](https://img.shields.io/npm/v/piper-timing-farm-browser)](https://www.npmjs.com/package/piper-timing-farm-browser)
[![License](https://img.shields.io/npm/l/piper-timing-farm-browser)](https://github.com/rinaldo/piper-timing-farm-browser/blob/main/LICENSE)

---

## Overview

`piper-timing-farm-browser` is a TypeScript library for browser-based Text-to-Speech synthesis. It extends the Piper TTS system with the following capabilities:

- **Multi-threaded processing**: Synthesis operations execute in Web Workers, isolating computation from the main thread.
- **Order-preserving parallel execution**: Concurrent synthesis requests return results in request order (FIFO sequencing).
- **Phoneme duration metadata**: Patched Piper models expose per-phoneme timing data for synchronization applications (lipsync, captions).
- **Service Worker Gateway**: A security layer that intercepts asset requests to enforce SHA-256 integrity and OPFS caching.
- **Local Indexing**: Models, WASM binaries, and the model cards are stored in the OPFS for offline use.
- **Integrity Checks**: All assets and the model cards are verified via SHA-256 hashes before they are used.
- **Scalable Metadata**: The model cards (`piper-model-cards.json`) centralizes model metadata and hashes, keeping the initial bundle size small while flexible for updates.
- **Cross-Origin Isolation Ready**: The Service Worker gateway implements `Cross-Origin-Resource-Policy` (CORP) headers, ensuring the engine functions in hardened security environments (`COOP`/`COEP`).

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture & Asset Management](#architecture--asset-management)
  - [Service Worker Gateway](#service-worker-gateway)
  - [Asset Delivery & OPFS Storage](#asset-delivery--opfs-storage)
- [Core Features](#core-features)
  - [Parallel FIFO Sequencer](#parallel-fifo-sequencer)
  - [Background Model Switching](#background-model-switching)
  - [Download Controller](#download-controller)
  - [Worker Callbacks](#worker-callbacks)
- [Security Architecture](#security-architecture)
  - [Integrity Verification Pipeline](#integrity-verification-pipeline)
  - [Broadcast Error Architecture](#broadcast-error-architecture)
- [API Reference](#api-reference)
- [CLI: Asset Provisioning](#cli-asset-provisioning)
- [Debugging & Troubleshooting](#debugging--troubleshooting)
  - [Verbose Lifecycle Logging](#verbose-lifecycle-logging)
  - [Path Deviation Diagnostics](#path-deviation-diagnostics)
- [Type Definitions](#type-definitions)
- [License](#license)

---

## Installation

```bash
npm install piper-timing-farm-browser
```

The `onnxruntime-web` peer dependency documents the ONNX Runtime version used internally. WASM binaries are bundled in the build output and provisioned via `npx piper-farm init`.

---

## Quick Start

### Step 1: Provision Assets

Copy WASM binaries and the Service Worker to your public folder:

```bash
npx piper-farm init
```

This CLI command detects your framework (SvelteKit, Vite, Next.js, etc.) and copies assets to the appropriate static directory (e.g., `public/` or `static/`). You can optionally specify a custom root: `npx piper-farm init dist/client`.

### Step 2: Initialize the Provider

```typescript
import { createPiperProvider } from "piper-timing-farm-browser";

const provider = createPiperProvider();

await provider.init({
  modelId: "en_US-bryce-medium",
  onProgress: (state) => console.log(`Downloading: ${Math.round(state.progress * 100)}%`)
});
```

### Step 3: Synthesize

```typescript
const result = await provider.synthesize("Hello world!");

console.log(result.durationMs);              // Total audio duration
console.log(result.metadata.durations);      // Per-phoneme timing (Float32Array)
console.log(result.metadata.phonemes);       // Phoneme symbols (string[])
```

### Step 4: Play Audio

Interfacing the raw `Float32Array` with the Web Audio API is straightforward. 

```typescript
const audioCtx = new AudioContext();

const buffer = audioCtx.createBuffer(1, result.audioData.length, result.sampleRate);

// Use 'new Float32Array(result.audioData)' to ensure compatibility if 
// SharedArrayBuffer (COOP/COEP) is enabled.
buffer.copyToChannel(new Float32Array(result.audioData), 0);

const source = audioCtx.createBufferSource();
source.buffer = buffer;
source.connect(audioCtx.destination);

// Ensure this call happens inside a user interaction (click/touch)
if (audioCtx.state === 'suspended') await audioCtx.resume();
source.start();
```
---

## Architecture & Asset Management

### Service Worker Gateway

The library requires a Service Worker gateway (`control-asset-sw.js`) that intercepts all requests starting with `/piper-gate/`. This ensures:
1. **Verification**: No binary asset is executed unless its SHA-256 hash matches the registry.
2. **Offline Persistence**: Verified assets are saved to the Origin Private File System (OPFS).
3. **Buffered Background Persistence**: All assets (WASM binaries and voice models) are buffered in memory for SHA-256 verification before being persisted to OPFS. While this occurs off the main thread, memory is consumed during the download and verification phase.

### Asset Delivery & OPFS Storage

The gateway manages two distinct paths:
- **`/infra/`**: Core engine binaries (WASM, worker scripts) and the `piper-model-cards.json`. Verified against hardcoded hashes.
- **`/voices/`**: Model weights and configs. Verified against the SHA-256 hashes defined in the model cards.

The cache can be managed independently:
- `clearPiperModelCache()`: Purges all downloaded voices while keeping the engine binaries.
- `clearPiperInfraCache()`: Purges core binaries (WASM/Workers).

---

## Core Features

### Parallel FIFO Sequencer

Synthesis requests are processed in parallel. Results are buffered and returned in request order (FIFO). This ensures request sequence is preserved regardless of individual task processing duration.

### Background Model Switching & Optional Pool Resizing

Calling `provider.init({ modelId: 'new-model', cpuInstances: 4 })` triggers a background transition without blocking active processing. The pool size defaults to 2 worker instances if `cpuInstances` is not specified. The queue continues serving the current model while the new model or additional workers are provisioned.

The library selects a transition path based on the configuration delta:

- **Resource Reuse (Lightweight Update)**: If `useCallback` and/or `defaultSpeakerId` changed, the existing worker pool is updated in-place. This prevents the memory peak of a redundant pool.
- **Atomic Swap (Parallel Transition)**: If `modelId` and/or `cpuInstances` changed, a new pool is provisioned in the background. Once ready, the worker pool performs a reference swap. During this handover:

1. **Queue Transformation**: Any `speakerId` in the queue that exceeds the new model's capacity is reset to `0`.
2. **State Consistency**: Waiting requests are updated for compatibility with the new model before dispatch.
3. **Graceful Retirement**: Old workers finish their active synthesis task before termination, preventing audio gaps or failed requests.

---

### Synchronous Parameter Updates

The farm supports updating parameters for requests already waiting in the queue without requiring a full model re-initialization or request cancellation.

- **`updatePendingOptions(options: Partial<SynthesizeOptions>)`**: Updates `speed`, `volume`, or `speakerId` for all items in the main-thread buffer.
- **Validation**: Manual updates to `speakerId` are validated against the active model's card.
- **Active Requests**: Requests already dispatched to workers are not affected to prevent state desync.

---

### Failure Orchestration

The farm implements a failure management strategy to isolate and recover from hardware-level worker crashes (e.g., WASM traps or memory exhaustion).

- **Automatic Task Retry**: If a worker terminates during a synthesis task, the task is re-queued once for execution on a fresh worker instance.
- **Recursive Failure Prevention**: If the same task causes a second worker termination, it is rejected with a `Worker Termination (Retry Exhausted)` error. This prevents recursive crash loops.
- **Pool Exhaustion Safety**: If the worker pool is reduced to zero due to consecutive fatal errors, all pending and new requests are rejected with a `Farm Exhausted` error.
- **Shadow Pool Abort Safety**: Superseded model transitions (rapid re-initialization) include cleanup. Aborted shadow workers are terminated, and associated promises reject with a `DOMException (AbortError)`.

---

### Worker Callbacks

For post-synthesis processing (e.g., viseme mapping), the architecture supports a callback module that executes within the isolated worker thread.

Enabling `useCallback: true` requires a verified `[root]/piper-gate/infra/piper-callback.js` module that exports a mandatory `onSynthesisComplete` function. 

Use `npx piper-farm hash [root]/piper-gate/infra/piper-callback.js` to generate the integrity hash and update the `INFRA_SHA256_REGISTRY` in the Service Worker.

```javascript
// [ public | static ]/piper-gate/infra/piper-callback.js
export function onSynthesisComplete(result) {
  // result.metadata.phonemes -> viseme logic
  return { visemes: [...] };
}
```

---

## Expanding the Model Library

The library uses a **model cards** system to resolve voices. There are two paths for adding custom models, depending on whether you are working with a provisioned project or building from source.

### Path 2A: Manual Update (Post-Provisioning)
Use this if you have already run `npx piper-farm init` and want to add models directly to your existing project.

1. **Update Cards**: Edit the provisioned `[static-root]/piper-gate/infra/piper-model-cards.json` to include your new model metadata and SHA-256 hashes.
2. **Synchronize Trust Anchor**: 
   - Calculate the SHA-256 hash of your updated `piper-model-cards.json`.
   - Open the provisioned `[static-root]/control-asset-sw.js`.
   - Update the `PIPER_MODEL_CARDS_SHA256` constant with the new hash to prevent integrity errors.

### Path 2B: Build from Source (Pre-Distribution)
Use this if you are forking the library to create a custom distribution with baked-in models.

1. **Add Metadata**: Edit `src/piper-model-cards.json` in the library source with your new model details and hashes.
2. **Execute Build**: Run `npm run build`. The pipeline automatically:
   - Calculates the new **model cards** hash.
   - Injects it into the Service Worker source code.
   - Rebuilds all library artifacts (Service Worker, Workers, and CLI).
3. **Provision Target**: Use your newly built library to provision your application (or copy the `dist/` contents and `piper-model-cards.json` to your server).

---

## API Reference

### `createPiperProvider()`

The recommended high-level API.

#### `init(config: FarmConfig): Promise<void>`
Initializes or re-initializes the farm.

| Option | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `modelId` | `string` | — | Model ID to load. |
| `cpuInstances` | `number` | `2` | Number of worker instances. |
| `useCallback` | `boolean` | `false` | Enable worker sidecar callbacks. |
| `defaultSpeakerId`| `number` | `0` | Global default speaker ID. |
| `modelUrls` | `object` | — | Custom `{ onnx, config }` URLs. |
| `onProgress` | `function`| — | Model download progress callback. |

#### `synthesize(text: string, options?: SynthesizeOptions): Promise<AudioSynthesisResult>`
Queues a synthesis request.

| Option | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `requestId` | `string` | `UUID` | Custom tracking identifier. |
| `speakerId` | `number` | `0` | Speaker ID for this request. |
| `speed` | `number` | `1.0` | Duration multiplier. |
| `volume` | `number` | `1.0` | Audio amplitude scaling. |
| `signal` | `AbortSignal`| — | Standard abort pattern. |

#### Request Lifecycle Management
- `cancelSynthesis(requestId: string)`: Aborts a specific request. If active, the worker is replaced.
- `cancelAllSynthesis()`: Aborts all pending and active requests.
- `cancelDownload(modelId: string): Promise<void>`: Aborts an in-flight model download.
- `updatePendingOptions(options: Partial<SynthesizeOptions>): void`: Updates parameters for queued requests.
- `prepareTransition(targetModelId: string)`: Sets target model ID before `reinit()`.

#### Cache & Instance Management
- `clearPiperModelCache(): Promise<void>`: Purges downloaded voices.
- `clearPiperInfraCache(): Promise<void>`: Purges WASM and Engine binaries.
- `deletePiperModel(id: string): Promise<void>`: Purges a specific voice.
- `terminate()`: Forcefully terminates all workers and cancels downloads.

#### Observability & Events
- `getActiveModelId()`: Returns the currently active model ID.
- `getDownloadState()`: Returns a `Map<id, DownloadState>` of active downloads.
- `onLog((log: WorkerLogPayload) => void)`: Subscribe to worker logs.
- `onQueueStatus((status: RequestStatusPayload) => void)`: Subscribe to queue events.

---

## Type Definitions

### `AudioSynthesisResult`
```typescript
{
  audioData: Float32Array;
  sampleRate: number;
  durationMs: number;
  metadata: {
    phonemes: string[];
    durations: Float32Array;
    modelId: string;
    speakerId: number;
  };
  callbackResult?: any;
}
```

### `RequestStatusPayload`
```typescript
{
  requestId: string;
  text: string;
  state: 'queued' | 'processing' | 'completed' | 'cancelled' | 'error';
  modelId?: string;
  error?: string;
}
```

---

## Security Architecture

### Integrity Verification Pipeline

| Asset Layer | Integrity Source | Verification Point |
| :--- | :--- | :--- |
| Model Cards | `PIPER_MODEL_CARDS_SHA256` | Service Worker Bootstrapping |
| Engine binaries | `INFRA_SHA256_REGISTRY` | Service Worker mandatory check |
| Voice models | Verified Model Cards Registry | Service Worker mandatory check |
| Worker Scripts | `INFRA_SHA256_REGISTRY` | Service Worker mandatory check |

### Error Propagation

The Service Worker broadcasts integrity mismatches, download failures, or path deviations via the `piper-download-progress` `BroadcastChannel`. The library propagates these errors to your `synthesize()` calls.

---

## CLI: Asset Provisioning

### `npx piper-farm init [static-root]`

Provisions the gateway assets. The Service Worker is placed in the `[static-root]`, and infrastructure binaries in `[static-root]/piper-gate/infra/`.

---

## Debugging & Troubleshooting

### Verbose Lifecycle Logging

The Service Worker provides detailed logs to help you track asset resolution:
- `[piper-gate] [Cache Hit]`: Asset verified and served from OPFS.
- `[piper-gate] [Stale Cache]`: Detected an integrity mismatch (e.g., from an older build). The entry is deleted and re-fetched.
- `[piper-gate] [Cache Restored]`: Asset successfully re-downloaded, verified, and saved to OPFS.

### Path Deviation Diagnostics

If the library detects a request for a Piper asset that is **NOT** using the `/piper-gate/` prefix, it will log a warning:
> `[piper-gate] [Path Deviation] Detected request for Piper asset '...' at non-gateway path: /assets/...`

This helps you identify code that is bypassing the security and caching layer.

### Worker Error Clarity

If a worker fails to initialize (e.g., due to a MIME type mismatch on your server), the library reports a descriptive error:
> `[Worker Error] Instance 0: Worker failed to initialize or load (possible MIME mismatch or Network Error)`

---

## License

MIT © Rinaldo Wouterson
