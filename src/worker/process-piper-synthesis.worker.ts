/// <reference lib="webworker" />
import * as ort from "onnxruntime-web";
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
let ortSession: ort.InferenceSession | null = null;
let phonemizerModule: PiperPhonemizerModule | null = null;
let modelConfig: ModelConfig | null = null;
let instanceId = -1;
let deviceLabel = "UNKNOWN";

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
        await handleInit(msg.config);
        break;
      case "load-callback":
        await handleLoadCallback(msg.modulePath, msg.functionName);
        break;
      case "synthesize":
        await handleSynthesize(msg.text, msg.requestId, {
          speed: msg.speed,
          pitch: msg.pitch,
          volume: msg.volume
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
async function handleInit(config: PiperWorkerConfig) {
  const { voiceId, modelId, wasmPaths, device, instanceId: id, callbackModule } = config;
  instanceId = id || 0;
  deviceLabel = (device || "cpu").toUpperCase();

  log("=== INIT START ===");
  
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
    ort.env.wasm.wasmPaths = wasmPaths.onnxWasm;
    ortSession = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });

    // 3. Load Phonemizer
    await loadPhonemizerModule(wasmPaths);

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

async function handleSynthesize(
  text: string, 
  requestId: string, 
  options: { speed?: number; pitch?: number; volume?: number }
) {
  if (!ortSession || !phonemizerModule || !modelConfig) {
    throw new Error("Worker not initialized");
  }

  const start = performance.now();
  
  // 1. Phonemize
  const { phonemeIds, phonemes } = phonemize(text, modelConfig.espeak.voice);
  
  // 2. Inference
  const { audio, durations } = await runInference(phonemeIds, options);
  
  // 3. Volume Scaling
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
      phonemeIds,
      phonemes,
      durations: durations ? Array.from(durations) : undefined,
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
    { type: "success", requestId, result, callbackResult },
    { transfer: transferables }
  );
}

// --- Internal Helpers ---

let lastPhonemizerOutput: PhonemizerOutput | null = null;

async function loadPhonemizerModule(wasmPaths: PiperWorkerConfig["wasmPaths"]) {
  const glueUrl = wasmPaths.piperWasm.replace(".wasm", ".js");
  const response = await fetch(glueUrl);
  const glueCode = await response.text();
  
  const createModule = new Function(glueCode + "; return createPiperPhonemize;")();
  
  phonemizerModule = await createModule({
    locateFile: (path: string) => {
      if (path.endsWith(".wasm")) return wasmPaths.piperWasm;
      if (path.endsWith(".data")) return wasmPaths.piperData;
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
  
  if (lastPhonemizerOutput?.phoneme_ids) {
    return {
      phonemeIds: lastPhonemizerOutput.phoneme_ids,
      phonemes: lastPhonemizerOutput.phonemes || []
    };
  }
  throw new Error("Phonemization failed");
}

async function runInference(phonemeIds: number[], options: any) {
  const { noise_scale, length_scale, noise_w } = modelConfig!.inference;
  
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor("int64", BigInt64Array.from(phonemeIds.map(BigInt)), [1, phonemeIds.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(phonemeIds.length)])),
    scales: new ort.Tensor("float32", [
      noise_scale, 
      options.speed ? length_scale / options.speed : length_scale, 
      noise_w
    ])
  };

  if (Object.keys(modelConfig!.speaker_id_map).length > 0) {
    feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(0)]));
  }

  const results = await ortSession!.run(feeds);
  const audio = results.output.data as Float32Array;
  const durations = results.durations ? results.durations.data as Float32Array : null;
  
  return { audio, durations };
}

function postMessage(msg: PiperWorkerMessageOut, options?: StructuredSerializeOptions) {
  self.postMessage(msg, options);
}
