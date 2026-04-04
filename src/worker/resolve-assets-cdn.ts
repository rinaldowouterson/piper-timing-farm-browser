import type { PiperPaths, OnnxRuntimePaths } from '../types';

export const ONNX_CDN_URLS: OnnxRuntimePaths = {
	wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/',
	mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.wasm.min.mjs',
	mjsHelper: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.mjs',
};

export const PIPER_CDN_URLS: PiperPaths = {
  piperData: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
  piperJs:   'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js',
  piperWasm: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm',
};
