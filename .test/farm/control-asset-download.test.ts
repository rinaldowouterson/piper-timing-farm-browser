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

    // NEW: Test prioritize() function (lines 140-159)
    it('should prioritize a model and pause others', async () => {
        const controller = createAssetDownloadController();

        // Make fetch hang until aborted
        mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
            return new Promise((_, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                }
            });
        });

        // Start two downloads
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        });

        // Prioritize model-b (should pause model-a)
        controller.prioritize('model-b');

        const state = controller.getState();
        // model-a should be paused
        expect(state.get('model-a')!.state).toBe('paused');
        // model-b should be downloading
        expect(state.get('model-b')!.state).toBe('downloading');
    });

    // NEW: Test error handling (lines 59-66)
    it('should set error state when download fails', async () => {
        const controller = createAssetDownloadController();

        // Make fetch fail with network error
        mockFetch.mockRejectedValue(new Error('Network failure'));

        // Suppress expected error logs
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await controller.request('model-fail', {
                onnx: 'https://example.com/model-fail.onnx',
                config: 'https://example.com/model-fail.onnx.json'
            });
        } catch (err) {
            // Expected to throw
        }

        const state = controller.getState();
        expect(state.get('model-fail')!.state).toBe('error');
        expect(state.get('model-fail')!.error).toBe('Network failure');

        errorSpy.mockRestore();
    });

    // NEW: Test resumePaused() after prioritize completes (lines 158-159)
    // Note: resumePaused() is only called when prioritized model was in 'paused' or 'queued' state
    // If prioritized model was already 'downloading', no new promise is created and resumePaused is not called
    it('should resume paused downloads when prioritized model (that was paused) completes', async () => {
        const controller = createAssetDownloadController();

        let modelAFetchAborted = false;
        let modelBFetchAborted = false;

        // Both models: hang until aborted, then succeed on retry
        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            if (url.includes('model-a')) {
                if (modelAFetchAborted) {
                    // Second attempt after resume
                    return Promise.resolve({
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
                }
                return new Promise((resolve, reject) => {
                    if (opts?.signal) {
                        opts.signal.addEventListener('abort', () => {
                            modelAFetchAborted = true;
                            reject(new DOMException('Aborted', 'AbortError'));
                        });
                    }
                });
            }
            if (url.includes('model-b')) {
                if (modelBFetchAborted) {
                    // Second attempt after being prioritized (was paused, now resumed)
                    return Promise.resolve({
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
                }
                return new Promise((resolve, reject) => {
                    if (opts?.signal) {
                        opts.signal.addEventListener('abort', () => {
                            modelBFetchAborted = true;
                            reject(new DOMException('Aborted', 'AbortError'));
                        });
                    }
                });
            }
            return Promise.resolve({
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

        // Start both downloads (both will hang in 'downloading' state)
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        });
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        });

        // Wait briefly for both to enter downloading state
        await new Promise(resolve => setTimeout(resolve, 5));

        // First prioritize model-a (this pauses model-b)
        controller.prioritize('model-a');

        // Verify model-b was paused
        const stateAfterFirstPrioritize = controller.getState();
        expect(stateAfterFirstPrioritize.get('model-b')!.state).toBe('paused');

        // Now prioritize model-b (which is in 'paused' state)
        // This should: pause model-a, start fresh download for model-b, and call resumePaused when model-b completes
        controller.prioritize('model-b');

        // Verify model-a was now paused
        const stateAfterSecondPrioritize = controller.getState();
        expect(stateAfterSecondPrioritize.get('model-a')!.state).toBe('paused');
        // model-b should be downloading (resumed from paused)
        expect(stateAfterSecondPrioritize.get('model-b')!.state).toBe('downloading');

        // Wait for model-b to complete (it was in 'paused' state, so prioritize created new promise with resumePaused callback)
        let stateAfter = controller.getState();
        for (let i = 0; i < 20 && stateAfter.get('model-b')?.state !== 'complete'; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            stateAfter = controller.getState();
        }

        // Verify model-b completed
        expect(stateAfter.get('model-b')!.state).toBe('complete');

        // resumePaused() should have been called, resuming model-a
        // Poll until model-a transitions from paused
        for (let i = 0; i < 10 && stateAfter.get('model-a')?.state === 'paused'; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            stateAfter = controller.getState();
        }

        // model-a should have been resumed (downloading or complete)
        expect(['downloading', 'complete']).toContain(stateAfter.get('model-a')!.state);
    });
});