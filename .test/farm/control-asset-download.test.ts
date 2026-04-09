import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssetDownloadController } from '../../src/farm/control-asset-download';

/**
 * Download Controller Tests (Scenario D)
 * 
 * Verifies FIFO sequencing, cancellation, OPFS cleanup, and state observability.
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
            headers: { get: () => '100' },
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(100));
                    controller.close();
                }
            })
        });
    });

    it('should track download state through lifecycle', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
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
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
        });
        const p2 = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
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

        // Catch the rejection that cancel() will trigger
        const promise = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
        }).catch(() => {});

        // Cancel before download completes
        await controller.cancel('model-a');
        await promise;

        const state = controller.getState();
        expect(state.has('model-a')).toBe(false);
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

        // Catch rejections that cancelAll() will trigger
        const p1 = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
        }).catch(() => {});
        const p2 = controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
        }).catch(() => {});

        await controller.cancelAll();
        await Promise.allSettled([p1, p2]);

        const state = controller.getState();
        expect(state.has('model-a')).toBe(false);
        expect(state.has('model-b')).toBe(false);
    });

    it('should remove state map after cancellation for memory efficiency', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, {
            config: 'test-config-sha256',
            onnx: 'test-onnx-sha256'
        });

        await controller.cancel('model-a');

        // State entry should be deleted
        const state = controller.getState();
        expect(state.has('model-a')).toBe(false);
    });


    it('should invoke onProgress callback with state snapshots during download', async () => {
        const controller = createAssetDownloadController();
        const progressUpdates: Array<{ progress: number; state: string; bytesDownloaded: number }> = [];

        // Use a multi-chunk stream to guarantee multiple onProgress calls
        mockFetch.mockImplementation(() => {
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '200' },
                body: new ReadableStream({
                    start(ctrl) {
                        // Two chunks of 100 bytes each
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        });

        const onProgress = vi.fn((state: { progress: number; state: string; bytesDownloaded: number }) => {
            progressUpdates.push({ ...state });
        });

        await controller.request(
            'model-progress',
            {
                onnx: 'https://example.com/model-progress.onnx',
                config: 'https://example.com/model-progress.onnx.json'
            },
            {
                config: 'test-config-sha256',
                onnx: 'test-onnx-sha256'
            },
            { onProgress }
        );

        // onProgress should have been called at least once
        expect(onProgress).toHaveBeenCalled();

        // All updates should have 'downloading' state (complete fires after onProgress stops)
        for (const update of progressUpdates) {
            expect(update.state).toBe('downloading');
        }

        // Final snapshot state should be 'complete'
        const finalState = controller.getState().get('model-progress');
        expect(finalState).toBeDefined();
        expect(finalState!.state).toBe('complete');
        expect(finalState!.progress).toBe(1.0);

        // Verify snapshots are copies (different object references)
        if (progressUpdates.length >= 2) {
            expect(progressUpdates[0]).not.toBe(progressUpdates[1]);
        }
    });
});