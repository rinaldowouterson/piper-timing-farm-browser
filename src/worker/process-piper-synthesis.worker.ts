/// <reference lib="webworker" />
import type { OrtInferenceSession, OrtModule } from "../types/ort-minimal";
import type { 
  PiperWorkerMessageIn, 
  PiperWorkerMessageOut, 
  PiperWorkerConfig,
  PiperModelConfig as ModelConfig,
  AudioSynthesisResult
} from "../types";
import type { 
  PiperPhonemizerModule, 
  PhonemizerOutput 
} from "../types/piper";
import { collectTransferables } from "./index";

declare const self: DedicatedWorkerGlobalScope;

// --- State ---
let ortSession: OrtInferenceSession | null = null;
let ortInstance: OrtModule | null = null;
let phonemizerModule: PiperPhonemizerModule | null = null;
let modelConfig: ModelConfig | null = null;
let instanceId = -1;
let deviceLabel = "CPU";
let currentModelId = "";
let defaultSpeakerId = 0;

/** User-defined callback function loaded into the worker global scope. */
let userCallback: ((result: AudioSynthesisResult) => unknown) | null = null;

// --- Logging ---
const PREFIX = () => `[PiperWorker:${instanceId}:${deviceLabel}]`;

function sendLog(level: 'info' | 'warn' | 'error' | 'debug', message: string) {
  self.postMessage({
    type: 'log',
    payload: {
      level,
      message,
      workerId: instanceId,
      timestamp: Date.now()
    }
  });
}

const log = (msg: string, ...args: unknown[]) => {
  const fullMsg = `${PREFIX()} ${msg}`;
  console.log(fullMsg, ...args);
  sendLog('info', msg + (args.length ? ' ' + JSON.stringify(args) : ''));
};

const warn = (msg: string, ...args: unknown[]) => {
  const fullMsg = `${PREFIX()} ${msg}`;
  console.warn(fullMsg, ...args);
  sendLog('warn', msg + (args.length ? ' ' + JSON.stringify(args) : ''));
};

const error = (msg: string, ...args: unknown[]) => {
  const fullMsg = `${PREFIX()} ${msg}`;
  console.error(fullMsg, ...args);
  sendLog('error', msg + (args.length ? ' ' + JSON.stringify(args) : ''));
};

// --- Message Handler ---
self.onmessage = async (e: MessageEvent<PiperWorkerMessageIn>) => {
  const msg = e.data;
  
  try {
    switch (msg.type) {
      case "init":
        await setupPiperWorker(msg.config);
        break;
      case "load-callback":
        await handleLoadCallback(msg.modulePath, msg.functionName, msg.integrity);
        break;
      case "synthesize":
        await processPiperSynthesis(msg.text, msg.requestId, {
          speed: msg.speed,
          volume: msg.volume,
          speakerId: msg.speakerId
        });
        break;
    }
  } catch (err) {
    const sanitizedError = sanitizeErrorPayload(err);
    error("Uncaught worker error:", sanitizedError);
    postMessage({
      type: "error",
      instanceId,
      error: sanitizedError,
      originalRequest: msg
    });
  }
};

// --- Initialization ---
export async function setupPiperWorker(config: PiperWorkerConfig) {
  const { modelId, onnxRuntimePaths, piperPaths, instanceId: id, callbackModule, defaultSpeakerId: defaultSid } = config;
  instanceId = id || 0;
  currentModelId = modelId;
  defaultSpeakerId = defaultSid || 0;

  log(`=== INIT START [${modelId}] ===`, { callback: callbackModule?.path, defaultSpeakerId });
  
  try {
    // 1. Load model assets via Service Worker Gateway
    // The SW handles: OPFS cache → SHA-256 verification → return
    // Workers are "Pure Consumers" — no direct OPFS access needed.

    // Load Model Config
    const configRes = await fetch(`/piper-gate/voices/${modelId}.onnx.json`);
    if (!configRes.ok) throw new Error(`Failed to fetch model config: ${configRes.statusText}`);
    const configText = await configRes.text();
    modelConfig = JSON.parse(configText) as ModelConfig;

    // Load ONNX Model
    const modelRes = await fetch(`/piper-gate/voices/${modelId}.onnx`);
    if (!modelRes.ok) throw new Error(`Failed to fetch model: ${modelRes.statusText}`);
    const modelBuffer = await modelRes.arrayBuffer();

    // 2. Configure ORT
    // Service Worker handles SHA-256 verification for all /piper-gate/* requests.
    // We simply fetch and import — SW guarantees integrity.
    const ortRes = await fetch(onnxRuntimePaths.mjs);
    if (!ortRes.ok) throw new Error(`Failed to fetch ORT glue: ${ortRes.statusText}`);
    const ortCode = await ortRes.text();

    // Dynamic import — browser cache serves the verified content from SW
    const ortModule = await import(/* @vite-ignore */ onnxRuntimePaths.mjs);
    ortInstance = ortModule.default || ortModule;
    
    if (!ortInstance || !ortInstance.env) {
      throw new Error("Invalid ONNX Runtime module: 'env' is missing. Check if the .mjs URL is correct.");
    }

    ortInstance.env.wasm.wasmPaths = onnxRuntimePaths.wasm;
    ortInstance.env.wasm.numThreads = 1; // Enforce single thread per worker
    
    ortSession = await ortInstance.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });

    // 3. Load Phonemizer
    await loadPhonemizerModule(piperPaths);

    // 4. Load Callback if configured
    if (callbackModule) {
      await handleLoadCallback(callbackModule.path, callbackModule.functionName, callbackModule.integrity);
    }

    log("=== INIT COMPLETE ===");
    postMessage({ type: "ready", instanceId });
  } catch (err) {
    const errorVal = err instanceof Error ? err : new Error(String(err));
    error("Init failed:", errorVal.message);
    throw errorVal;
  }
}

async function handleLoadCallback(modulePath: string, functionName: string, expectedHash?: string) {
  log(`Loading callback: ${functionName} from ${modulePath}`);
  try {
    // 1. Fetch content for integrity check (Mandatory for user-provided callbacks)
    const response = await fetch(modulePath);
    if (!response.ok) throw new Error(`Failed to fetch callback module: ${response.statusText}`);
    const content = await response.text();
    
    // Strict Verification for user-provided callback modules
    // This is NOT redundant with SW verification because:
    // - User callbacks are NOT served through /piper-gate/
    // - They are arbitrary user code that gets executed in the worker thread
    if (!expectedHash) {
      throw new Error(`Integrity hash is mandatory for callback module: ${modulePath}`);
    }
    
    // Import verifySha256 inline for callback verification only
    const { verifySha256 } = await import("../utils/resolve-sha256-browser");
    log(`[Integrity] Verifying callback: ${modulePath}`);
    await verifySha256(content, expectedHash, modulePath);
    log(`[Integrity] Verified: ${modulePath}`);

    // 2. Perform Dynamic Import
    const module = await import(/* @vite-ignore */ modulePath);
    userCallback = module[functionName];
    if (typeof userCallback !== 'function') {
      throw new Error(`Export '${functionName}' is not a function in ${modulePath}`);
    }
    
    log("Callback loaded successfully");
    postMessage({ type: "callback-loaded", instanceId });
  } catch (err) {
    userCallback = null; // Clear state on failure
    const errorVal = err instanceof Error ? err.message : String(err);
    error("Failed to load callback module:", errorVal);
    postMessage({ type: "callback-failed", instanceId, error: errorVal });
    throw err;
  }
}

export async function processPiperSynthesis(
  text: string, 
  requestId: string, 
  options: { speed?: number; volume?: number; speakerId?: number }
) {
  if (!ortSession || !ortInstance || !phonemizerModule || !modelConfig) {
    throw new Error("Worker not initialized");
  }

  const start = performance.now();
  
  // 1. Phonemize
  const { phonemeIds, phonemes } = phonemize(text, modelConfig.espeak.voice);
  
  // 2. Inference
  const resolvedSpeakerId = resolveSpeakerId(options.speakerId, modelConfig);
  const { audio, durations } = await runInference(ortInstance, phonemeIds, options, resolvedSpeakerId);
  
  // 3. Durations Conversion (Frames -> MS)
  if (!durations || durations.length === 0) {
    throw new Error("Durations missing from inference results. Ensure the model is patched to export durations tensor.");
  }

  const msPerFrame = (256 / modelConfig.audio.sample_rate) * 1000;
  for (let i = 0; i < durations.length; i++) {
    durations[i] *= msPerFrame;
  }

  // 4. Volume Scaling
  const volume = options.volume ?? 1.0;
  if (volume !== 1.0) {
    for (let i = 0; i < audio.length; i++) audio[i] *= volume;
  }

  const durationMs = (audio.length / modelConfig.audio.sample_rate) * 1000;
  const generationTimeMs = performance.now() - start;

  const result: AudioSynthesisResult = {
    requestId,
    audioData: audio,
    sampleRate: modelConfig.audio.sample_rate,
    durationMs,
    metadata: {
      generationTimeMs,
      modelId: currentModelId,
      speakerId: resolvedSpeakerId,
      phonemeIds,
      phonemes,
      durations: durations || undefined,
      totalAudioDurationMs: durationMs,
      sampleRate: modelConfig.audio.sample_rate,
      hopSize: 256
    }
  };

  // 4. Invoke user callback
  let callbackResult: unknown = undefined;
  if (userCallback) {
    try {
      callbackResult = await userCallback(result);
    } catch (err) {
      const errorVal = err instanceof Error ? err : new Error(String(err));
      error(`Callback execution failed: ${errorVal.message}`);
      throw new Error(`User callback '${currentModelId}' failed: ${errorVal.message}`);
    }
  }

  // 5. Transfer results
  const transferables = [
    audio.buffer,
    ...collectTransferables(callbackResult)
  ];

  postMessage(
    { type: "success", instanceId, requestId, result, callbackResult },
    { transfer: transferables }
  );
}

// --- Internal Helpers ---

let lastPhonemizerOutput: PhonemizerOutput | null = null;

async function loadPhonemizerModule(piperPaths: PiperWorkerConfig["piperPaths"]) {
  // The phonemizer glue JS is served through /piper-gate/infra/
  // Service Worker handles SHA-256 verification automatically.
  const glueUrl = piperPaths.piperJs;
  const response = await fetch(glueUrl);
  if (!response.ok) throw new Error(`Failed to fetch phonemizer glue: ${response.statusText}`);
  const glueCode = await response.text();
  
  // Create module using the legacy global-variable approach commonly used by Emscripten
  const createModule = new Function(glueCode + "; return createPiperPhonemize;")();
  
  phonemizerModule = await createModule({
    locateFile: (path: string) => {
      if (path.endsWith(".wasm")) return piperPaths.piperWasm;
      if (path.endsWith(".data")) return piperPaths.piperData;
      return path;
    },
    print: (text: string) => {
      try {
        lastPhonemizerOutput = JSON.parse(text) as PhonemizerOutput;
      } catch {}
    }
  });
}

function phonemize(text: string, voice: string) {
  const input = JSON.stringify([{ text: text.trim() }]);
  lastPhonemizerOutput = null;
  
  phonemizerModule?.callMain(["-l", voice, "--input", input, "--espeak_data", "/espeak-ng-data"]);
  
  // Use type casting to resolve type inference issues during synchronous Emscripten callback
  if (lastPhonemizerOutput && typeof (lastPhonemizerOutput as unknown as Record<string, unknown>).phoneme_ids !== 'undefined') {
    const output = lastPhonemizerOutput as unknown as PhonemizerOutput;
    return {
      phonemeIds: output.phoneme_ids,
      phonemes: output.phonemes || []
    };
  }
  throw new Error("Phonemization failed");
}

async function runInference(
  ortInstance: OrtModule, 
  phonemeIds: number[], 
  options: { speed?: number }, 
  speakerId: number
) {
  const { noise_scale, length_scale, noise_w } = modelConfig!.inference;
  
  const feeds: Record<string, unknown> = {
    input: new ortInstance.Tensor("int64", BigInt64Array.from(phonemeIds.map(BigInt)), [1, phonemeIds.length]),
    input_lengths: new ortInstance.Tensor("int64", BigInt64Array.from([BigInt(phonemeIds.length)])),
    scales: new ortInstance.Tensor("float32", new Float32Array([
      noise_scale, 
      options.speed ? length_scale / options.speed : length_scale, 
      noise_w
    ]))
  };

  if (Object.keys(modelConfig!.speaker_id_map).length > 0) {
    feeds.sid = new ortInstance.Tensor("int64", BigInt64Array.from([BigInt(speakerId)]));
  }

  const results = await ortSession!.run(feeds);
  const audio = results.output.data as Float32Array;
  const durations = results.durations ? results.durations.data as Float32Array : null;
  
  return { audio, durations };
}

/**
 * Validates speakerId against the model's speaker_id_map.
 * Returns the validated speakerId, or 0 with a warning if out of bounds.
 */
function resolveSpeakerId(requested: number | undefined, config: ModelConfig): number {
  const speakerCount = Object.keys(config.speaker_id_map).length;
  
  // Single-speaker model: always 0 (defaultSpeakerId ignored to prevent out-of-bounds)
  if (speakerCount === 0) return 0;
  
  const sid = requested ?? defaultSpeakerId;
  
  if (sid < 0 || sid >= speakerCount) {
    warn(`speakerId ${sid} out of range (0-${speakerCount - 1}), falling back to 0`);
    return 0;
  }
  
  return sid;
}

function postMessage(msg: PiperWorkerMessageOut, options?: StructuredSerializeOptions) {
  self.postMessage(msg, options);
}

/**
 * Strips PII (specifically the synthesis 'text') from bubble-up error payloads.
 */
function sanitizeErrorPayload(err: unknown): string {
  if (typeof err === 'string') return err;
  
  const errorVal = err instanceof Error ? err.message : String(err);
  
  // If the error object contains the original request, scrub the text
  if (err && typeof err === 'object' && 'originalRequest' in err) {
    try {
      const errorWithRequest = err as { originalRequest: PiperWorkerMessageIn };
      const scrubbed = { ...errorWithRequest.originalRequest };
      if ('text' in scrubbed) {
        scrubbed.text = "[REDACTED]";
      }
      return `${errorVal} (Request: ${JSON.stringify(scrubbed)})`;
    } catch {
      return errorVal;
    }
  }
  
  return errorVal;
}

/**
 * Placeholder for legacy verifyIntegrity — replaced by shared verifySha256 orchestrator.
 */
