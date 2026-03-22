# piper-timing-farm

A framework-agnostic Piper TTS worker farm for the browser, enhanced with worker-thread callbacks for zero-latency lipsync and timing-aware processing.

## 🚀 Why Use This?

Typical TTS libraries only provide audio data back to the main thread, forcing heavy post-processing (like lipsync calculation) to run on the main thread, causing frames to drop.

`piper-timing-farm` allows you to:
1. **Inject processing into the Worker thread**: Run your own code exactly where the audio is generated.
2. **Zero main-thread blocking**: Perform heavy phoneme-to-animation calculations off-thread.
3. **Zero-copy transfer**: Automatically transfer processed results (like viseme tracks) for maximum performance.

## 📦 Installation

```bash
npm install piper-timing-farm
```

## 🛠️ Basic Usage

```typescript
import { createPiperWorkerFarm } from 'piper-timing-farm';

const farm = createPiperWorkerFarm();

await farm.init({
  voiceId: 'en_US-amy-medium',
  modelId: 'en_US-amy-medium',
  wasmPaths: {
    onnxWasm: '/wasm/ort/',
    piperData: '/wasm/ort/piper_phonemize.data',
    piperWasm: '/wasm/ort/piper_phonemize.wasm'
  },
  cpuInstances: 2,
  webgpuInstances: 0
});

const result = await farm.synthesize('Hello world');
console.log(result.audioData); // Float32Array
```

## ⚡ Technical Enhancement: Worker-Thread Callbacks

For lipsync and animation, load a module directly into the worker:

```typescript
await farm.init({
  // ... other config
  callbackModule: {
    path: '/js/my-lipsync-callback.js',
    functionName: 'onSynthesisComplete'
  }
});

const result = await farm.synthesize('Hello world');
console.log(result.callbackResult); // Your processed tracks!
```

**Worker Module (`/js/my-lipsync-callback.js`):**

```javascript
export function onSynthesisComplete(result) {
  const { metadata, audioData } = result;
  // Calculate viseme tracks here, in the worker thread...
  const tracks = computeLipsync(metadata.phonemes, metadata.durations);
  // Return any buffers for zero-copy transfer
  return { tracks };
}
```

## 🧠 Core Features

- **Portability**: Framework-agnostic (no Svelte/React dependencies).
- **FIFO Sequencing**: Results arrive in the exact order they were requested.
- **OPFS Caching**: Built-in provider handle model persistence in Origin-Private File System.
- **Timing Metadata**: Full access to Piper's phoneme IDs, strings, and duration tensors.

## ⚖️ License

MIT
