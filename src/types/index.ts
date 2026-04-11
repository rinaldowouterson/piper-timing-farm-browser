// --- Synthesis Output ---

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

export interface AudioSynthesisResult {
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
}

/**
 * Asset paths for ONNX Runtime.
 */
export interface OnnxRuntimePaths {
  wasm: string;
  mjs: string;
  mjsHelper: string;
}

/**
 * Asset paths for Piper specific WASM/Data.
 */
export interface PiperPaths {
  piperWasm: string;
  piperJs: string;
  piperData: string;
}

/**
 * Internal worker configuration.
 */
export interface PiperWorkerConfig {
	voiceId: string;
	modelId: string;
	onnxRuntimePaths: OnnxRuntimePaths;
	piperPaths: PiperPaths;
	instanceId?: number;
  /** Optional callback to load in worker thread. */
  callbackModule?: CallbackModuleConfig;
  modelSha256?: string;
  configSha256?: string;
}

/**
 * Configuration for initializing the Piper farm.
 */
export interface FarmConfig {
	voiceId: string;
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
  reinit(config: Pick<FarmConfig, 'voiceId' | 'modelId' | 'modelUrls'>): Promise<void>;
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
}

export type PiperWorkerMessageIn =
	| { type: "init"; config: PiperWorkerConfig }
  | { type: "load-callback"; modulePath: string; functionName: string }
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
	| { type: "success"; instanceId: number; requestId: string; result: AudioSynthesisResult; callbackResult?: any };

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
