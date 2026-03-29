# 🎙️ Piper Timing Farm

High-performance, multi-threaded Piper TTS engine for the browser. Features framework-agnostic worker orchestration, Parallel FIFO sequencing, and **"Asshole-Proof"** model switching.

[![Release](https://img.shields.io/npm/v/piper-timing-farm)](https://www.npmjs.com/package/piper-timing-farm)
[![License](https://img.shields.io/npm/l/piper-timing-farm)](https://github.com/rinaldo/piper-timing-farm/blob/main/LICENSE)

---

## 🚀 The "Whole Nine Yards" Architecture

`piper-timing-farm` is built for production-grade web applications where audio-visual synchronization (lipsync) and zero main-thread-blocking are non-negotiable.

-   **Parallel FIFO Sequencer**: Guarantees that synthesis results are returned in the exact order they were requested, even when processed across multiple concurrent workers.
-   **Asshole-Proof Provider**: Background model switching allow you to hotswap voices while the engine continues to synthesize with the active model. Asset provisioning is deferred until the new model is fully downloaded.
-   **Unified CLI**: Automated **G**lobal **O**rchestration over **A**sset **T**ransfers for Vite, SvelteKit, and Next.js.

---

## 📦 Installation & Setup

### 1. Install the Library
```bash
npm install piper-timing-farm
```

### 2. Provision Assets (The Magic Wand)
WASM and binary assets must be served from your project's static folder. Our CLI handles this for you:
```bash
npx piper-farm init
```
*Detects SvelteKit (`static/assets`) vs. Vite/React (`public/assets`) automatically.*

---

## 🛠️ Usage Strategies

### Option A: The CDN Path (Zero friction)
Use our pre-configured CDN path for zero-config integration.
```typescript
import { createPiperProvider } from 'piper-timing-farm';

const provider = createPiperProvider();
await provider.init({
  voiceId: 'en_US-amy-medium',
  modelId: 'en_US-amy-medium'
});

const result = await provider.synthesize('Hello from the CDN!');
```

### Option B: The Local Path (Performance & Offline)
Use your locally provisioned assets for maximum performance and offline support.
```typescript
import { createPiperWorkerFarm } from 'piper-timing-farm';

const farm = createPiperWorkerFarm();
await farm.init({
  voiceId: 'uk_UA-ukrainian_tts-medium',
  modelId: 'uk_UA-ukrainian_tts-medium'
});

const result = await farm.synthesize('Слава Україні!');
```

---

## ⚡ Worker-Thread Callbacks (Lipsync)
Perform heavy phoneme processing off-thread by injecting a module into the synthesis loop:

```typescript
await farm.init({
  callbackModule: {
    path: '/js/my-viseme-processor.js',
    functionName: 'processVisemes'
  }
});
```

---

## ⚖️ License
MIT © Rinaldo Wouterson
