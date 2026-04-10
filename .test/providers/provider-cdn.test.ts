import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPiperProvider } from '../../src/providers/create-piper-provider-cdn';
import * as baseProviderModule from '../../src/providers/create-piper-provider';
import { ONNX_CDN_URLS, PIPER_CDN_URLS } from '../../src/worker/resolve-assets-cdn';

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockTerminate = vi.fn();
const mockGetActiveModelId = vi.fn().mockReturnValue(null);
const mockGetDownloadState = vi.fn().mockReturnValue(new Map());

vi.mock('../../src/providers/create-piper-provider', () => ({
    createPiperProvider: vi.fn(() => ({
        init: mockInit,
        synthesize: vi.fn(),
        terminate: mockTerminate,
        isInitialized: vi.fn().mockReturnValue(false),
        getActiveModelId: mockGetActiveModelId,
        getDownloadState: mockGetDownloadState,
        cancelDownload: vi.fn(),
        metrics: { queueLength: 0, busyWorkers: 0, totalWorkers: 0 }
    }))
}));

describe('Piper CDN Provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should inject CDN URLs into init call when not provided by user', async () => {
        const cdnProvider = createPiperProvider();
        
        await cdnProvider.init({
            modelId: 'en_US-bryce-medium',
            voiceId: 'en_US-bryce-medium',
            cpuInstances: 2
        });

        expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({
            onnxRuntimePaths: ONNX_CDN_URLS,
            piperPaths: PIPER_CDN_URLS
        }));
    });

    it('should NOT overwrite user-provided paths', async () => {
        const cdnProvider = createPiperProvider();
        const customOnnxPaths = { wasm: 'custom/', mjs: 'custom.mjs', mjsHelper: 'custom.helper' };
        
        await cdnProvider.init({
            modelId: 'en_US-bryce-medium',
            voiceId: 'en_US-bryce-medium',
            cpuInstances: 2,
            onnxRuntimePaths: customOnnxPaths
        });

        expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({
            onnxRuntimePaths: customOnnxPaths,
            piperPaths: PIPER_CDN_URLS
        }));
    });

    it('should delegate other methods to base provider', () => {
        const cdnProvider = createPiperProvider();
        
        cdnProvider.terminate();
        expect(mockTerminate).toHaveBeenCalled();

        cdnProvider.getActiveModelId();
        expect(mockGetActiveModelId).toHaveBeenCalled();

        cdnProvider.getDownloadState();
        expect(mockGetDownloadState).toHaveBeenCalled();
    });
});
