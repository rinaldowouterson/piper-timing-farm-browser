// --- Synthesis Output ---

/**
 * Supported input types for SHA-256 calculation.
 */
export type HashInput = string | ArrayBuffer | Uint8Array;

/**
 * Phoneme-level timing metadata from Piper.
 */
export interface PiperMetadata {
	phonemeIds: number[];
	phonemes?: string[];
	durations?: Float32Array;
	totalAudioDurationMs: number;
	sampleRate: number;
	hopSize: number;
  /** The ID of the model used for this specific result. */
  modelId?: string;
}

export type RequestState = 'queued' | 'processing' | 'completed' | 'cancelled' | 'error';

export interface RequestStatusPayload {
  requestId: string;
  text: string;
  state: RequestState;
  modelId?: string;
  error?: string;
}

export interface WorkerLogPayload {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  workerId: number;
  timestamp: number;
}

export interface AudioSynthesisResult {
  requestId: string;
	audioData: Float32Array;
	sampleRate: number;
	durationMs: number;
	metadata: PiperMetadata & {
		generationTimeMs?: number;
    /** The speaker ID used for this synthesis (actual value after validation). */
    speakerId?: number;
  };
}

/**
 * Pending request in the Piper worker farm.
 */
export interface PendingRequest {
	requestId: string;
	text: string;
	speed: number;
	volume: number;
	speakerId: number;
	resolve: (result: AudioSynthesisResult & { callbackResult?: any }) => void;
	reject: (reason: Error) => void;
	// If completed but waiting for FIFO order
	result?: AudioSynthesisResult & { callbackResult?: any };
  /** The model ID that was active when this request was processed. */
  modelId?: string;
}

/**
 * State of a Piper worker instance.
 */
export interface WorkerState {
	id: number;
	worker: Worker;
	busy: boolean;
  transitioning?: boolean;
  /** The model ID currently active on this worker. */
  modelId?: string;
}

/**
 * Configuration for the worker-thread callback module.
 */
export interface CallbackModuleConfig {
  /** Path to the JavaScript module to import in the worker. */
  path: string;
  /** Name of the exported function to invoke on synthesis completion. */
  functionName: string;
  /** Mandatory SHA-256 integrity hash for the module. */
  integrity: string;
}

/**
 * Asset paths for ONNX Runtime.
 */
export interface OnnxRuntimePaths {
  wasm: string;
  /** Mandatory SHA-256 integrity hash for the ort-wasm.wasm binary. */
  wasmSha256: string;
  
  mjs: string;
  /** Mandatory SHA-256 integrity hash for the ort-wasm.min.mjs glue script. */
  mjsSha256: string;
  
  mjsHelper: string;
  /** Mandatory SHA-256 integrity hash for the helper script. */
  mjsHelperSha256: string;
}

/**
 * Asset paths for Piper specific WASM/Data.
 */
export interface PiperPaths {
  piperWasm: string;
  /** Mandatory SHA-256 integrity hash for the piper_phonemize.wasm binary. */
  piperWasmSha256: string;

  piperJs: string;
  /** Mandatory SHA-256 integrity hash for the piper_phonemize.js glue script. */
  piperJsSha256: string;

  piperData: string;
  /** Mandatory SHA-256 integrity hash for the piper_phonemize.data file. */
  piperDataSha256: string;
}

/**
 * Internal worker configuration.
 */
export interface PiperWorkerConfig {
	modelId: string;
	onnxRuntimePaths: OnnxRuntimePaths;
	piperPaths: PiperPaths;
	instanceId?: number;
  /** Optional callback to load in worker thread. */
  callbackModule?: CallbackModuleConfig;
  modelSha256?: string;
  configSha256?: string;
  /** Global default speaker ID for this worker instance. */
  defaultSpeakerId?: number;
}

/**
 * Configuration for initializing the Piper farm.
 */
export interface FarmConfig {
	modelId: string;
  /** Optional URLs for the ONNX model and config. */
  modelUrls?: {
    onnx: string;
    config: string;
  };
	onnxRuntimePaths?: OnnxRuntimePaths;
	piperPaths?: PiperPaths;
  /** Total number of worker instances to use for parallel synthesis. Defaults to 2. */
	cpuInstances?: number;
  /** Optional worker-thread callback for off-thread processing. */
  callbackModule?: CallbackModuleConfig;
  /** SHA-256 hashes for model integrity verification. */
  modelSha256?: string;
  configSha256?: string;
  /** Optional progress callback fired during model download. Receives a snapshot of the download state. */
  onProgress?: (state: DownloadState) => void;
  /** Global default speaker ID for all workers in the farm. */
  defaultSpeakerId?: number;
  /** Custom path to the asset-intercepting Service Worker (e.g. for subpath deployments). */
  serviceWorkerUrl?: string;
}

export interface SynthesizeOptions {
  speed?: number;
  volume?: number;
  speakerId?: number;
  signal?: AbortSignal;
  requestId?: string;
}

export interface PiperWorkerFarm {
	init(config: FarmConfig): Promise<void>;
  /** 
   * Updates the farm with a new model configuration without 
   * destroying workers or clearing the queue. 
   */
  reinit(config: Pick<FarmConfig, 'modelId' | 'modelUrls' | 'callbackModule' | 'defaultSpeakerId'>): Promise<void>;
	synthesize(
		text: string,
		options?: SynthesizeOptions
	): Promise<AudioSynthesisResult & { callbackResult?: any }>;
	cancelSynthesis(requestId: string): void;
	cancelAllSynthesis(): void;
	terminate(): void;
  clearPiperModelCache(): Promise<void>;
  isInitialized(): boolean;
  getActiveModelId(): string | null;
  prepareTransition(targetModelId: string): void;
	readonly metrics: {
		queueLength: number;
		busyWorkers: number;
		totalWorkers: number;
	};
	onQueueStatus(listener: (status: RequestStatusPayload) => void): () => void;
  onLog(listener: (log: WorkerLogPayload) => void): () => void;
}

export type PiperWorkerMessageIn =
	| { type: "init"; config: PiperWorkerConfig }
  | { type: "load-callback"; modulePath: string; functionName: string; integrity?: string }
	| {
			type: "synthesize";
			text: string;
			requestId: string;
			speed?: number;
			volume?: number;
			speakerId?: number;
	  };

export type PiperWorkerMessageOut =
	| { type: "ready"; instanceId: number }
	| { type: "error"; instanceId: number; error: string; originalRequest?: PiperWorkerMessageIn }
  | { type: "log"; payload: WorkerLogPayload }
	| { type: "success"; instanceId: number; requestId: string; result: AudioSynthesisResult; callbackResult?: any }
  | { type: "callback-loaded"; instanceId: number }
  | { type: "callback-failed"; instanceId: number; error: string };

export interface PiperModelConfig {
	audio: { sample_rate: number };
	espeak: { voice: string };
	inference: { noise_scale: number; length_scale: number; noise_w: number };
	speaker_id_map: Record<string, number>;
}

// --- Download Controller ---

/**
 * State of a single model download.
 * Kept in the state map even after cancellation for frontend observability.
 */
export interface DownloadState {
  modelId: string;
  state: 'pending' | 'downloading' | 'complete' | 'error';
  bytesDownloaded: number;
  bytesTotal: number;
  /** 0.0 to 1.0 */
  progress: number;
  error?: string;
}

/**
 * Stateful download controller for model assets.
 * Manages FIFO queue sequencing, cancellation, and OPFS cleanup.
 */
export interface DownloadController {
  /** Start or retry a model download. Deduplicates by modelId. */
  request(
    modelId: string,
    urls: { onnx: string; config: string },
    expectedSha256?: { onnx?: string; config?: string },
    options?: { onProgress?: (state: DownloadState) => void }
  ): Promise<void>;
  /** Cancel a download, remove from queue, and purge any partial OPFS files. Entry is deleted from registry. */
  cancel(modelId: string): Promise<void>;
  /** Cancel all pending and downloading items with cleanup. */
  cancelAll(): Promise<void>;
  /** Returns a snapshot of every model's download lifecycle. */
  getState(): Map<string, DownloadState>;
  /** Purge cached OPFS files for a model and re-download from scratch. */
  clearAndRedownloadModel(modelId: string): Promise<void>;
}
