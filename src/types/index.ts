// --- Synthesis Output ---

/**
 * Phoneme-level timing metadata from Piper.
 */
export interface PiperMetadata {
	phonemeIds: number[];
	phonemes?: string[];
	durations?: number[];
	totalAudioDurationMs: number;
	sampleRate: number;
	hopSize: number;
	phonemeIdMap?: Record<string, number[]>;
  /** The ID of the model used for this specific result. */
  modelId?: string;
}

/**
 * Result of a single synthesis request.
 */
export interface AudioSynthesisResult {
	audioData: Float32Array;
	sampleRate: number;
	durationMs: number;
	metadata: {
		generationTimeMs?: number;
    modelId?: string;
	} & Partial<PiperMetadata>;
}

/**
 * Pending request in the Piper worker farm.
 */
export interface PendingRequest {
	requestId: string;
	text: string;
	speed: number;
	pitch: number;
	volume: number;
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
  /** Instructs downlaod manager to prioritize this model. */
  prioritizeSelected?: boolean;
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
  /** Total number of worker instances to use for parallel synthesis. */
	cpuInstances: number;
  /** Optional worker-thread callback for off-thread processing. */
  callbackModule?: CallbackModuleConfig;
  /** Instructs downlaod manager to prioritize this model. Default is true. */
  prioritizeSelected?: boolean;
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
		options?: { speed?: number; pitch?: number; volume?: number }
	): Promise<AudioSynthesisResult & { callbackResult?: any }>;
	terminate(): void;
  isInitialized(): boolean;
  getActiveModelId(): string | null;
  prepareTransition(targetModelId: string): void;
  clearCache(): Promise<void>;
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
			pitch?: number;
			volume?: number;
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
