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
 * Asset paths for ONNX Runtime.
 * SHA-256 hashes are optional — Service Worker handles verification.
 */
export interface OnnxRuntimePaths {
  wasm: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  wasmSha256?: string;
  
  mjs: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  mjsSha256?: string;
  
  mjsHelper: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  mjsHelperSha256?: string;
}

/**
 * Asset paths for Piper specific WASM/Data.
 * SHA-256 hashes are optional — Service Worker handles verification.
 */
export interface PiperPaths {
  piperWasm: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  piperWasmSha256?: string;

  piperJs: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  piperJsSha256?: string;

  piperData: string;
  /** Optional SHA-256 integrity hash (SW handles verification by default) */
  piperDataSha256?: string;
}

/**
 * Internal worker configuration.
 */
export interface PiperWorkerConfig {
	modelId: string;
	onnxRuntimePaths: OnnxRuntimePaths;
	piperPaths: PiperPaths;
	instanceId?: number;
  /** Optional boolean flag to enable loading of the 'piper-callback.js' worker sidecar. */
  useCallback?: boolean;
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
  /** Optional boolean flag to enable off-thread processing via the 'piper-callback.js' worker sidecar. */
  useCallback?: boolean;
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
  reinit(config: Partial<FarmConfig>): Promise<void>;
	synthesize(
		text: string,
		options?: SynthesizeOptions
	): Promise<AudioSynthesisResult & { callbackResult?: any }>;
	cancelSynthesis(requestId: string): void;
	cancelAllSynthesis(): void;
	terminate(): void;
  clearPiperModelCache(): Promise<void>;
  clearPiperInfraCache(): Promise<void>;
  isInitialized(): boolean;
  getActiveModelId(): string | null;
  prepareTransition(targetModelId: string): void;
  /** 
   * Updates parameters for all requests currently waiting in the queue.
   * This does NOT affect requests already dispatched to workers.
   */
  updatePendingOptions(options: Partial<SynthesizeOptions>): void;
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
  | { type: "load-callback"; useCallback: boolean }
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
  status: 'pending' | 'downloading' | 'complete' | 'error';
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
  /** Cancel an in-flight download and remove from queue. Does not touch OPFS (RAM-first: nothing is written until verified). */
  cancel(modelId: string): Promise<void>;
  /** Cancel all pending and downloading items. */
  cancelAll(): Promise<void>;
  /** Returns a snapshot of every model's download lifecycle. */
  getState(): Map<string, DownloadState>;
  /** Clean up all listeners and channels (BroadcastChannel) */
  destroy(): void;
}

// --- Broadcast Channel Types ---

export interface BroadcastProgressPayload {
  type: 'progress';
  filename: string;
  downloaded: number;
  total: number;
}

export interface BroadcastErrorPayload {
  type: 'error';
  filename: string;
  message: string;
  code?: string;
  stack?: string;
}

export type BroadcastPayload = 
  | BroadcastProgressPayload 
  | BroadcastErrorPayload;
