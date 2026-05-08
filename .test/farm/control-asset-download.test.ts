import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAssetDownloadController } from '../../src/farm/control-asset-download';

/**
 * Download Controller Tests (Scenario D)
 * 
 * Verifies FIFO sequencing, cancellation, OPFS cleanup, and state observability.
 * 
 * NOTE: The new architecture uses BroadcastChannel for progress reporting.
 * The Service Worker broadcasts progress messages, and the download controller
 * subscribes to receive them. Tests must mock BroadcastChannel to simulate
 * Service Worker progress broadcasts.
 */

// Mock fetch globally for download simulation
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Store BroadcastChannel instances for test access
let broadcastChannelInstances: Array<{ name: string; onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];

// Mock BroadcastChannel as a proper class constructor
class MockBroadcastChannel {
    name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage = vi.fn();
    close = vi.fn();

    constructor(name: string) {
        this.name = name;
        broadcastChannelInstances.push(this);
    }
}

vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

describe('Download Controller', () => {
    let mockRemoveEntry: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockRemoveEntry = vi.fn().mockResolvedValue(undefined);
        broadcastChannelInstances = [];

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

    afterEach(() => {
        broadcastChannelInstances = [];
    });

    it('should track download state through lifecycle', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a');

        const state = controller.getState();
        const modelState = state.get('model-a');

        expect(modelState).toBeDefined();
        expect(modelState!.status).toBe('complete');
        expect(modelState!.progress).toBe(1.0);
        expect(modelState!.modelId).toBe('model-a');
    });

    it('should deduplicate requests for the same model', async () => {
        const controller = createAssetDownloadController();

        const p1 = controller.request('model-a');
        const p2 = controller.request('model-a');

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
        const promise = controller.request('model-a').catch(() => {});

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
        const p1 = controller.request('model-a').catch(() => {});
        const p2 = controller.request('model-b').catch(() => {});

        await controller.cancelAll();
        await Promise.allSettled([p1, p2]);

        const state = controller.getState();
        expect(state.has('model-a')).toBe(false);
        expect(state.has('model-b')).toBe(false);
    });

    it('should remove state map after cancellation for memory efficiency', async () => {
        const controller = createAssetDownloadController();

        await controller.request('model-a');

        await controller.cancel('model-a');

        // State entry should be deleted
        const state = controller.getState();
        expect(state.has('model-a')).toBe(false);
    });


    it('should invoke onProgress callback with state snapshots during download', async () => {
        const controller = createAssetDownloadController();
        const progressUpdates: Array<{ progress: number; status: string; bytesDownloaded: number }> = [];

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

        const onProgress = vi.fn((state: { progress: number; status: string; bytesDownloaded: number }) => {
            progressUpdates.push({ ...state });
        });

        // Start the download request
        const requestPromise = controller.request(
            'model-progress',
            { onProgress }
        );

        // Simulate Service Worker broadcasting progress messages via BroadcastChannel
        // The controller subscribes to 'piper-download-progress' channel
        const progressChannel = broadcastChannelInstances.find(
            ch => ch.name === 'piper-download-progress'
        );

        // Simulate progress messages from Service Worker
        if (progressChannel && progressChannel.onmessage) {
            // First progress update: 50 bytes downloaded
            progressChannel.onmessage(new MessageEvent('message', {
                data: {
                    type: 'progress',
                    filename: 'model-progress.onnx',
                    downloaded: 50,
                    total: 200
                }
            }));

            // Second progress update: 150 bytes downloaded
            progressChannel.onmessage(new MessageEvent('message', {
                data: {
                    type: 'progress',
                    filename: 'model-progress.onnx',
                    downloaded: 150,
                    total: 200
                }
            }));

            // Config file progress (separate file)
            progressChannel.onmessage(new MessageEvent('message', {
                data: {
                    type: 'progress',
                    filename: 'model-progress.onnx.json',
                    downloaded: 100,
                    total: 100
                }
            }));
        }

        await requestPromise;

        // onProgress should have been called at least once
        expect(onProgress).toHaveBeenCalled();

        // All updates should have 'downloading' status (complete fires after onProgress stops)
        for (const update of progressUpdates) {
            expect(update.status).toBe('downloading');
        }

        // Final snapshot status should be 'complete'
        const finalState = controller.getState().get('model-progress');
        expect(finalState).toBeDefined();
        expect(finalState!.status).toBe('complete');
        expect(finalState!.progress).toBe(1.0);

        // Verify snapshots are copies (different object references)
        if (progressUpdates.length >= 2) {
            expect(progressUpdates[0]).not.toBe(progressUpdates[1]);
        }
    });
});