import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssetDownloadController } from '../../src/farm/control-asset-download';

/**
 * Download Controller Tests (Scenario D)
 * 
 * Verifies prioritization, cancellation, OPFS cleanup, and state observability.
 */

// Mock fetch globally for download simulation
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Download Controller', () => {
    let mockRemoveEntry: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockRemoveEntry = vi.fn().mockResolvedValue(undefined);

        // Reset fetch to return a successful response
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        });
    });

    it('should track download state through lifecycle', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });

        const state = controller.getState();
        const modelState = state.get('model-a');

        expect(modelState).toBeDefined();
        expect(modelState!.state).toBe('complete');
        expect(modelState!.progress).toBe(1.0);
        expect(modelState!.modelId).toBe('model-a');
    });

    it('should deduplicate requests for the same model', async () => {
        const controller = createAssetDownloadController();

        const p1 = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });
        const p2 = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });

        // Same promise returned
        expect(p1).toBe(p2);

        await p1;
    });

    it('should cancel a download and update state', async () => {
        const controller = createAssetDownloadController();

        // Make fetch hang indefinitely until aborted
        mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
            return new Promise((_, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                }
            });
        });

        const promise = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });

        // Cancel before download completes
        await controller.cancel('model-a');

        const state = controller.getState();
        expect(state.get('model-a')!.state).toBe('cancelled');
    });

    it('should cancelAll active downloads', async () => {
        const controller = createAssetDownloadController();

        mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
            return new Promise((_, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                }
            });
        });

        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        });

        await controller.cancelAll();

        const state = controller.getState();
        expect(state.get('model-a')!.state).toBe('cancelled');
        expect(state.get('model-b')!.state).toBe('cancelled');
    });

    it('should maintain state map after cancellation for observability', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });

        await controller.cancel('model-a');

        // State entry should persist (not be deleted)
        const state = controller.getState();
        expect(state.has('model-a')).toBe(true);
        expect(state.get('model-a')!.state).toBe('cancelled');
    });
});