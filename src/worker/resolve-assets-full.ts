import type { PiperPaths, OnnxRuntimePaths } from '../types';
import { ONNX_ASSET_URLS } from './resolve-assets-onnxruntime';
import { PIPER_ASSET_URLS } from './resolve-assets-piper';

export interface FullAssetPaths {
  onnxRuntime: OnnxRuntimePaths;
  piper: PiperPaths;
}

export const FULL_ASSET_URLS: FullAssetPaths = {
  onnxRuntime: ONNX_ASSET_URLS,
  piper: PIPER_ASSET_URLS,
};
