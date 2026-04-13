/**
 * Minimal internal ORT (ONNX Runtime Web) type surface.
 *
 * We use dynamic import() to load the real ORT runtime at runtime from a URL.
 * This file defines only the subset of the ORT API that the worker actually
 * calls, so we have no runtime or type-resolution dependency on the
 * `onnxruntime-web` npm package in our source code.
 *
 * If ORT adds/removes fields, update this file and the worker together.
 */

export interface OrtEnv {
  wasm: {
    wasmPaths: string;
    numThreads: number;
  };
}

export interface OrtTensorInput {
  new (
    type: 'int64' | 'float32',
    data: BigInt64Array | Float32Array,
    dims?: number[]
  ): OrtTensorInput;
}

/** Returned map from InferenceSession.run() */
export interface OrtRunResult {
  [outputName: string]: { data: Float32Array | BigInt64Array | null };
}

export interface OrtInferenceSession {
  run(feeds: Record<string, unknown>): Promise<OrtRunResult>;
}

export interface OrtInferenceSessionFactory {
  create(
    model: ArrayBuffer,
    options: { executionProviders: string[]; graphOptimizationLevel: string }
  ): Promise<OrtInferenceSession>;
}

/** Shape of the dynamically loaded ORT module (ort.wasm.min.mjs default export) */
export interface OrtModule {
  env: OrtEnv;
  Tensor: OrtTensorInput;
  InferenceSession: OrtInferenceSessionFactory;
}
