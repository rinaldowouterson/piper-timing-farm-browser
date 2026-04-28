# Piper Timing Farm Browser

A multi-threaded Text-to-Speech engine for browser applications, providing phoneme-level timing data through patched Piper models.

[![Release](https://img.shields.io/npm/v/piper-timing-farm-browser)](https://www.npmjs.com/package/piper-timing-farm-browser)
[![License](https://img.shields.io/npm/l/piper-timing-farm-browser)](https://github.com/rinaldo/piper-timing-farm-browser/blob/main/LICENSE)

---

## Overview

`piper-timing-farm-browser` is a TypeScript library for browser-based Text-to-Speech synthesis. It extends the Piper TTS system with the following capabilities:

- **Multi-threaded processing**: Synthesis operations execute in Web Workers, isolating computation from the main thread.
- **Order-preserving parallel execution**: Multiple synthesis requests process concurrently while results return in strict request order (FIFO sequencing).
- **Phoneme duration metadata**: Patched Piper models expose per-phoneme timing data for synchronization applications (lipsync, captions).
- **Service Worker Gateway**: A mandatory security layer that intercepts all asset requests to enforce SHA-256 integrity and OPFS caching.
- **OPFS-based asset caching**: Models and WASM binaries persist in the Origin Private File System for offline operation.
- **SHA-256 integrity verification**: All binary assets undergo mandatory cryptographic verification on every read before execution.

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

This CLI command detects your framework (SvelteKit, Vite, Next.js, etc.) and copies assets to the appropriate static directory (e.g., `public/` or `static/`).

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

---

## Architecture & Asset Management

### Service Worker Gateway

The library requires a Service Worker gateway (`control-asset-sw.js`) that intercepts all requests starting with `/piper-gate/`. This ensures:
1. **Mandatory Verification**: No binary asset is executed unless its SHA-256 hash matches the registry.
2. **Offline Persistence**: Verified assets are saved to the Origin Private File System (OPFS).
3. **Direct-to-Storage Streaming**: Large models (50MB+) are streamed directly to storage, preventing main-thread memory pressure.

### Asset Delivery & OPFS Storage

The gateway manages two distinct storage directories:
- **`/infra/`**: Core engine binaries (WASM, worker scripts). Verified against hardcoded hashes.
- **`/voices/`**: Model weights and configs. Verified against HuggingFace LFS OIDs or custom hashes.

The cache can be managed independently:
- `clearPiperModelCache()`: Purges all downloaded voices while keeping the engine binaries.
- `clearPiperInfraCache()`: Purges core binaries (WASM/Workers) to force an engine update.

---

## Core Features

### Parallel FIFO Sequencer

When multiple synthesis requests arrive simultaneously, workers process them in parallel. To guarantee determinism, results are internally buffered and returned exactly in request order (FIFO), even if a later short request finishes before an earlier long request.

### Background Model Switching

Calling `provider.init({ modelId: 'new-model' })` triggers a background download without blocking active processing. The queue continues serving the current model while the new model downloads, verifies, and initializes. Once ready, the worker pool reference is replaced and incoming requests route to the new model.

---

### Worker Callbacks

For post-synthesis processing (e.g., viseme mapping), the architecture supports a callback module that executes within the isolated worker thread.

To enable, set `useCallback: true` during initialization. The worker will attempt to load a verified `/piper-callback.js` from your root.

```javascript
// /piper-callback.js
export function onSynthesisComplete(result) {
  // result.metadata.phonemes -> viseme logic
  return { visemes: [...] };
}
```

---

## Security Architecture

### Integrity Verification Pipeline

| Asset Layer | Integrity Source | Verification Point |
| :--- | :--- | :--- |
| Engine binaries | Hardcoded hashes | SW mandatory check on every read |
| Voice models | HF OID / Registry | SW mandatory check on every read |
| Worker Scripts | `INFRA_SHA256_REGISTRY` | SW mandatory check on every read |

### Error Propagation

The Service Worker does not fail silently. All integrity mismatches, download failures, or path deviations are broadcast via the `piper-download-progress` `BroadcastChannel`. The library automatically listens to this channel to propagate errors to your `synthesize()` calls.

**Security Hardening**: There are **no bypass mechanisms** (e.g., `?bypass-sw=true`). If an asset fails verification, it is deleted from cache and must be re-downloaded from a trusted source.

---

## API Reference

### `createPiperProvider()`

The recommended high-level API.

```typescript
const provider = createPiperProvider();

await provider.init(config: FarmConfig);
await provider.synthesize(text: string, options?: SynthesizeOptions);
await provider.clearPiperModelCache(); // Wipes voices
await provider.clearPiperInfraCache(); // Wipes WASM/Engine
await provider.deletePiperModel(id);   // Wipes specific voice
provider.terminate();
```

---

## CLI: Asset Provisioning

### `npx piper-farm init [target-path]`

Provisions the following assets to your static directory:

| File | Purpose |
| :--- | :--- |
| `control-asset-sw.js` | Service Worker gateway (placed at root) |
| `ort-wasm-simd-threaded.wasm` | ONNX Runtime Engine (SIMD/Multi-thread) |
| `ort-wasm-simd-threaded.mjs` | ONNX Runtime Loader |
| `ort.wasm.min.mjs` | ONNX Runtime entry point |
| `piper_phonemize.js` | Phonemization Loader |
| `piper_phonemize.wasm` | Phonemization Engine |
| `process-piper-synthesis.worker.js` | The Synthesis Worker |
| `piper_phonemize.data` | Language data (~17MB) |
| `piper-callback.js` | User-provided post-processing script |

---

## Debugging & Troubleshooting

### Verbose Lifecycle Logging

The Service Worker provides detailed logs to help you track asset resolution:
- `[Cache Hit]`: Asset verified and served from OPFS.
- `[Stale Cache]`: Detected an integrity mismatch (e.g., from an older build). The entry is deleted and re-fetched.
- `[Cache Restored]`: Asset successfully re-downloaded, verified, and saved to OPFS.

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
