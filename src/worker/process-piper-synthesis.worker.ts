/// <reference lib="webworker" />
import type { OrtInferenceSession } from "../types/ort-minimal";
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
let ortInstance: any = null;
let phonemizerModule: PiperPhonemizerModule | null = null;
let modelConfig: ModelConfig | null = null;
let instanceId = -1;
let deviceLabel = "CPU";
let currentModelId = "";

/** User-defined callback function loaded into the worker global scope. */
let userCallback: ((result: AudioSynthesisResult) => any) | null = null;

// --- Logging ---
const PREFIX = () => `[PiperWorker:${instanceId}:${deviceLabel}]`;
const log = (msg: string, ...args: any[]) => console.log(`${PREFIX()} ${msg}`, ...args);
const warn = (msg: string, ...args: any[]) => console.warn(`${PREFIX()} ${msg}`, ...args);
const error = (msg: string, ...args: any[]) => console.error(`${PREFIX()} ${msg}`, ...args);

// --- Message Handler ---
self.onmessage = async (e: MessageEvent<PiperWorkerMessageIn>) => {
  const msg = e.data;
  
  try {
    switch (msg.type) {
      case "init":
        await setupPiperWorker(msg.config);
        break;
      case "load-callback":
        await handleLoadCallback(msg.modulePath, msg.functionName);
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
    const errorVal = err instanceof Error ? err : new Error(String(err));
    error("Uncaught worker error:", errorVal.message);
    postMessage({
      type: "error",
      instanceId,
      error: errorVal.message,
      originalRequest: msg
    });
  }
};

// --- Initialization ---
export async function setupPiperWorker(config: PiperWorkerConfig) {
  const { voiceId, modelId, onnxRuntimePaths, piperPaths, instanceId: id, callbackModule } = config;
  instanceId = id || 0;
  currentModelId = modelId;

  log(`=== INIT START [${modelId}] ===`);
  
  try {
    // 1. Load context from OPFS
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle("voices");

    // Load Model Config
    const configHandle = await voicesDir.getFileHandle(`${modelId}.onnx.json`);
    const configFile = await configHandle.getFile();
    modelConfig = JSON.parse(await configFile.text()) as ModelConfig;

    // Load ONNX Model
    const modelHandle = await voicesDir.getFileHandle(`${modelId}.onnx`);
    const modelFile = await modelHandle.getFile();
    const modelBuffer = await modelFile.arrayBuffer();

    // 2. Configure ORT
    // We use dynamic import for the MJS bundle to ensure the environment is correctly set up
    // in the worker thread.
    const ortModule = await import(/* @vite-ignore */ onnxRuntimePaths.mjs);
    ortInstance = ortModule.default || ortModule;
    
    if (!ortInstance.env) {
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
      await handleLoadCallback(callbackModule.path, callbackModule.functionName);
    }

    log("=== INIT COMPLETE ===");
    postMessage({ type: "ready", instanceId });
  } catch (err) {
    const errorVal = err instanceof Error ? err : new Error(String(err));
    error("Init failed:", errorVal.message);
    throw errorVal;
  }
}

async function handleLoadCallback(modulePath: string, functionName: string) {
  log(`Loading callback: ${functionName} from ${modulePath}`);
  try {
    const module = await import(/* @vite-ignore */ modulePath);
    userCallback = module[functionName];
    if (typeof userCallback !== 'function') {
      throw new Error(`Export '${functionName}' is not a function in ${modulePath}`);
    }
    log("Callback loaded successfully");
  } catch (err) {
    error("Failed to load callback module:", err);
    throw err;
  }
}

export async function processPiperSynthesis(
  text: string, 
  requestId: string, 
  options: { speed?: number; volume?: number; speakerId?: number }
) {
  if (!ortSession || !phonemizerModule || !modelConfig) {
    throw new Error("Worker not initialized");
  }

  const start = performance.now();
  
  // 1. Phonemize
  const { phonemeIds, phonemes } = phonemize(text, modelConfig.espeak.voice);
  
  // 2. Inference
  const resolvedSpeakerId = resolveSpeakerId(options.speakerId, modelConfig);
  const { audio, durations } = await runInference(ortInstance, phonemeIds, options, resolvedSpeakerId);
  
  // 3. Durations Conversion (Frames -> MS)
  if (durations) {
    const msPerFrame = (256 / modelConfig.audio.sample_rate) * 1000;
    for (let i = 0; i < durations.length; i++) {
      durations[i] *= msPerFrame;
    }
  }

  // 4. Volume Scaling
  const volume = options.volume ?? 1.0;
  if (volume !== 1.0) {
    for (let i = 0; i < audio.length; i++) audio[i] *= volume;
  }

  const durationMs = (audio.length / modelConfig.audio.sample_rate) * 1000;
  const generationTimeMs = performance.now() - start;

  const result: AudioSynthesisResult = {
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
  let callbackResult: any = undefined;
  if (userCallback) {
    callbackResult = await userCallback(result);
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
  // The phonemizer glue JS is served alongside the WASM
  const glueUrl = piperPaths.piperJs;
  const response = await fetch(glueUrl);
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
  if ((lastPhonemizerOutput as any)?.phoneme_ids) {
    const output = lastPhonemizerOutput as unknown as PhonemizerOutput;
    return {
      phonemeIds: output.phoneme_ids,
      phonemes: output.phonemes || []
    };
  }
  throw new Error("Phonemization failed");
}

async function runInference(ortInstance: any, phonemeIds: number[], options: any, speakerId: number) {
  const { noise_scale, length_scale, noise_w } = modelConfig!.inference;
  
  const feeds: Record<string, any> = {
    input: new ortInstance.Tensor("int64", BigInt64Array.from(phonemeIds.map(BigInt)), [1, phonemeIds.length]),
    input_lengths: new ortInstance.Tensor("int64", BigInt64Array.from([BigInt(phonemeIds.length)])),
    scales: new ortInstance.Tensor("float32", [
      noise_scale, 
      options.speed ? length_scale / options.speed : length_scale, 
      noise_w
    ])
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
  
  // Single-speaker model or no speaker requested: always 0
  if (speakerCount === 0) return 0;
  
  const sid = requested ?? 0;
  
  if (sid < 0 || sid >= speakerCount) {
    warn(`speakerId ${sid} out of range (0-${speakerCount - 1}), falling back to 0`);
    return 0;
  }
  
  return sid;
}

function postMessage(msg: PiperWorkerMessageOut, options?: StructuredSerializeOptions) {
  self.postMessage(msg, options);
}
