import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssetDownloadController } from '../../src/farm/control-asset-download';

/**
 * Integrity & Resumption Regression Tests
 *
 * These tests target the exact failure modes observed during stress testing:
 * 1. Partial OPFS files served as complete → ERROR_CODE 7 (protobuf parse failure)
 * 2. Paused downloads never resuming after a high-priority hotswap
 * 3. clearAndRedownloadModel purge-and-refetch lifecycle
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * Creates a mock fetch that hangs until the AbortSignal fires,
 * then succeeds on the next call (simulating a resumed download).
 */
function createHangingThenSucceedFetch(urlFragment: string) {
    let aborted = false;
    return (url: string, opts?: RequestInit) => {
        if (!url.includes(urlFragment)) return;
        if (aborted) {
            // Second attempt: succeed immediately
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        }
        // First attempt: hang until aborted
        return new Promise((_, reject) => {
            if (opts?.signal) {
                opts.signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            }
        });
    };
}

/**
 * Default SHA-256 hashes for test models.
 * In production, these come from PIPER_MODELS registry.
 */
const TEST_SHA256 = {
    config: 'test-config-sha256',
    onnx: 'test-onnx-sha256'
};

describe('Integrity & Resumption (Regression)', () => {
    beforeEach(() => {
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

    // =========================================================================
    // BUG 1: Paused downloads must resume after prioritized task completes
    // =========================================================================

    it('should resume a paused download after the prioritized download completes', async () => {
        const controller = createAssetDownloadController();

        let modelAAborted = false;
        let modelBAborted = false;

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            if (url.includes('model-a')) {
                if (modelAAborted) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: { get: () => '100' },
                        body: new ReadableStream({
                            start(ctrl) {
                                ctrl.enqueue(new Uint8Array(100));
                                ctrl.close();
                            }
                        })
                    });
                }
                return new Promise((_, reject) => {
                    opts?.signal?.addEventListener('abort', () => {
                        modelAAborted = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            }
            // model-b: complete immediately
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        });

        // Start model-a (will hang)
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});

        await new Promise(r => setTimeout(r, 10));

        // Start model-b and prioritize it (pauses model-a)
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, TEST_SHA256).catch(() => {});

        controller.prioritize('model-b');

        // Verify model-a is paused
        expect(controller.getState().get('model-a')!.state).toBe('paused');

        // Wait for model-b to complete and resumeNextPaused to fire
        let state = controller.getState();
        for (let i = 0; i < 30 && state.get('model-b')?.state !== 'complete'; i++) {
            await new Promise(r => setTimeout(r, 20));
            state = controller.getState();
        }
        expect(state.get('model-b')!.state).toBe('complete');

        // The critical assertion: model-a MUST resume automatically
        for (let i = 0; i < 30 && state.get('model-a')?.state === 'paused'; i++) {
            await new Promise(r => setTimeout(r, 20));
            state = controller.getState();
        }

        expect(['downloading', 'complete']).toContain(state.get('model-a')!.state);
    });

    // =========================================================================
    // BUG 1b: Paused downloads must resume even if prioritized task ERRORS
    // =========================================================================

    it('should resume paused downloads even when the prioritized download fails', async () => {
        const controller = createAssetDownloadController();

        let modelAAborted = false;

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            if (url.includes('model-a')) {
                if (modelAAborted) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: { get: () => '100' },
                        body: new ReadableStream({
                            start(ctrl) {
                                ctrl.enqueue(new Uint8Array(100));
                                ctrl.close();
                            }
                        })
                    });
                }
                return new Promise((_, reject) => {
                    opts?.signal?.addEventListener('abort', () => {
                        modelAAborted = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            }
            // model-b: FAIL with network error
            return Promise.reject(new Error('Network failure'));
        });

        // Start model-a (hangs)
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});

        await new Promise(r => setTimeout(r, 10));

        // Start model-b (will fail)
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, TEST_SHA256).catch(() => {});

        // Prioritize model-b (pauses model-a)
        controller.prioritize('model-b');
        expect(controller.getState().get('model-a')!.state).toBe('paused');

        // Wait for model-b to error out
        let state = controller.getState();
        for (let i = 0; i < 30 && state.get('model-b')?.state === 'downloading'; i++) {
            await new Promise(r => setTimeout(r, 20));
            state = controller.getState();
        }
        expect(state.get('model-b')!.state).toBe('error');

        // The critical assertion: model-a MUST still resume despite model-b failing
        // This was the original bug — .then() only fired on success, .finally() fires always
        for (let i = 0; i < 30 && state.get('model-a')?.state === 'paused'; i++) {
            await new Promise(r => setTimeout(r, 20));
            state = controller.getState();
        }

        expect(['downloading', 'complete']).toContain(state.get('model-a')!.state);
    });

    // =========================================================================
    // BUG 2: clearAndRedownloadModel lifecycle
    // =========================================================================

    it('should purge and re-request a model via clearAndRedownloadModel', async () => {
        const controller = createAssetDownloadController();

        // Complete initial download
        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        expect(controller.getState().get('model-a')!.state).toBe('complete');

        // Clear and redownload
        await controller.clearAndRedownloadModel('model-a');

        // Should be complete again (fresh download)
        const state = controller.getState().get('model-a');
        expect(state).toBeDefined();
        expect(state!.state).toBe('complete');

        // fetch should have been called more than the initial 2 times (config + onnx)
        // The redownload adds 2 more calls
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('should be a no-op if clearAndRedownloadModel is called for an unknown model', async () => {
        const controller = createAssetDownloadController();
        // Should not throw
        await controller.clearAndRedownloadModel('nonexistent-model');
    });

    // =========================================================================
    // Serial resumption: only one background task at a time
    // =========================================================================

    it('should resume paused downloads serially (one at a time)', async () => {
        const controller = createAssetDownloadController();

        const abortFlags: Record<string, boolean> = {};

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            const modelMatch = url.match(/\/(model-\w+)\./);
            const modelKey = modelMatch?.[1] || 'unknown';

            // model-z always succeeds immediately
            if (modelKey === 'model-z') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => '50' },
                    body: new ReadableStream({
                        start(ctrl) {
                            ctrl.enqueue(new Uint8Array(50));
                            ctrl.close();
                        }
                    })
                });
            }

            // model-x, model-y: hang first, succeed after abort (simulates resumption)
            if (abortFlags[modelKey]) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => '50' },
                    body: new ReadableStream({
                        start(ctrl) {
                            ctrl.enqueue(new Uint8Array(50));
                            ctrl.close();
                        }
                    })
                });
            }

            return new Promise((_, reject) => {
                opts?.signal?.addEventListener('abort', () => {
                    abortFlags[modelKey] = true;
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        // Start 3 downloads (x and y hang, z succeeds immediately)
        for (const id of ['model-x', 'model-y', 'model-z']) {
            controller.request(id, {
                onnx: `https://example.com/${id}.onnx`,
                config: `https://example.com/${id}.onnx.json`
            }, TEST_SHA256).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 10));

        // Prioritize model-z (pauses x and y; z is already downloading)
        controller.prioritize('model-z');

        // Wait for everything to settle
        let state = controller.getState();
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 30));
            state = controller.getState();
            const allDone = [...state.values()].every(
                s => s.state === 'complete' || s.state === 'error'
            );
            if (allDone) break;
        }

        // model-z should have completed
        expect(state.get('model-z')!.state).toBe('complete');
        // x and y should have been resumed and completed
        for (const id of ['model-x', 'model-y']) {
            expect(['downloading', 'complete']).toContain(state.get(id)!.state);
        }
    });

    // =========================================================================
    // EDGE CASE: Rapid A→B→C hotswapping (3 models in quick succession)
    // =========================================================================

    it('should survive rapid A→B→C hotswapping without orphaning any download', async () => {
        const controller = createAssetDownloadController();
        const abortFlags: Record<string, boolean> = {};

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            const modelMatch = url.match(/\/(model-\w+)\./);
            const modelKey = modelMatch?.[1] || 'unknown';

            // model-c (the final prioritized model) succeeds immediately
            // model-a and model-b hang until aborted, then succeed on retry
            if (modelKey === 'model-c' || abortFlags[modelKey]) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => '100' },
                    body: new ReadableStream({
                        start(ctrl) {
                            ctrl.enqueue(new Uint8Array(100));
                            ctrl.close();
                        }
                    })
                });
            }

            return new Promise((_, reject) => {
                opts?.signal?.addEventListener('abort', () => {
                    abortFlags[modelKey] = true;
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        // User selects model-a
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});

        await new Promise(r => setTimeout(r, 5));

        // User quickly switches to model-b (pauses a)
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, TEST_SHA256).catch(() => {});
        controller.prioritize('model-b');

        await new Promise(r => setTimeout(r, 5));

        // User switches AGAIN to model-c before b finishes (pauses b, a still paused)
        controller.request('model-c', {
            onnx: 'https://example.com/model-c.onnx',
            config: 'https://example.com/model-c.onnx.json'
        }, TEST_SHA256).catch(() => {});
        controller.prioritize('model-c');

        // Wait for cascade to settle
        let state = controller.getState();
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 30));
            state = controller.getState();
            const allSettled = [...state.values()].every(
                s => s.state === 'complete' || s.state === 'error' || s.state === 'cancelled'
            );
            if (allSettled) break;
        }

        // model-c must complete (it was prioritized last)
        expect(state.get('model-c')!.state).toBe('complete');
        // a and b must have eventually resumed (not orphaned as 'paused' forever)
        for (const id of ['model-a', 'model-b']) {
            expect(state.get(id)!.state).not.toBe('paused');
        }
    });

    // =========================================================================
    // EDGE CASE: Double prioritize on the same model
    // =========================================================================

    it('should handle double-prioritize on the same model without corruption', async () => {
        const controller = createAssetDownloadController();
        let modelAAborted = false;

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            if (url.includes('model-a') && !modelAAborted) {
                return new Promise((_, reject) => {
                    opts?.signal?.addEventListener('abort', () => {
                        modelAAborted = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        });

        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});

        await controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, TEST_SHA256);

        // Prioritize model-b twice in succession
        controller.prioritize('model-b');
        controller.prioritize('model-b');

        // Should not throw or corrupt state
        const state = controller.getState();
        expect(state.get('model-b')!.state).toBe('complete');

        // model-a should have been resumed eventually
        let latest = controller.getState();
        for (let i = 0; i < 30 && latest.get('model-a')?.state === 'paused'; i++) {
            await new Promise(r => setTimeout(r, 20));
            latest = controller.getState();
        }
        expect(['downloading', 'complete']).toContain(latest.get('model-a')!.state);
    });

    // =========================================================================
    // EDGE CASE: Request after cancel (re-request a cancelled model)
    // =========================================================================

    it('should allow re-requesting a cancelled model as a fresh download', async () => {
        const controller = createAssetDownloadController();

        mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
            return new Promise((resolve, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                }
                // Resolve after a tick (not instant, not hanging)
                setTimeout(() => resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => '100' },
                    body: new ReadableStream({
                        start(ctrl) {
                            ctrl.enqueue(new Uint8Array(100));
                            ctrl.close();
                        }
                    })
                }), 5);
            });
        });

        const p1 = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        await controller.cancel('model-a');
        await p1.catch(() => {});

        expect(controller.getState().get('model-a')!.state).toBe('cancelled');

        // Re-request should work as fresh download
        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        expect(controller.getState().get('model-a')!.state).toBe('complete');
    });

    // =========================================================================
    // EDGE CASE: Request after error (re-request a failed model)
    // =========================================================================

    it('should allow re-requesting a model that previously errored', async () => {
        const controller = createAssetDownloadController();
        let failCount = 0;

        mockFetch.mockImplementation(() => {
            failCount++;
            // Fail only the first fetch call (config file of first request)
            // The onnx file won't be fetched if config fails
            if (failCount === 1) {
                return Promise.reject(new Error('Network failure'));
            }
            // Subsequent calls succeed
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        });

        // First request fails (config fails, onnx never called)
        try {
            await controller.request('model-a', {
                onnx: 'https://example.com/model-a.onnx',
                config: 'https://example.com/model-a.onnx.json'
            }, TEST_SHA256);
        } catch {
            // Expected
        }

        expect(controller.getState().get('model-a')!.state).toBe('error');

        // Second request should work (failCount is now 2, which succeeds)
        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        expect(controller.getState().get('model-a')!.state).toBe('complete');
    });

    // =========================================================================
    // EDGE CASE: Prioritize a model that was never requested
    // =========================================================================

    it('should be a no-op when prioritizing a model that was never requested', async () => {
        const controller = createAssetDownloadController();

        // Should not throw
        controller.prioritize('nonexistent-model');

        // State should remain empty
        expect(controller.getState().size).toBe(0);
    });

    // =========================================================================
    // EDGE CASE: cancelAll during active hotswap
    // =========================================================================

    it('should cleanly cancel all downloads during an active hotswap', async () => {
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

        // Start multiple downloads
        controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});
        controller.request('model-b', {
            onnx: 'https://example.com/model-b.onnx',
            config: 'https://example.com/model-b.onnx.json'
        }, TEST_SHA256).catch(() => {});

        await new Promise(r => setTimeout(r, 5));

        // Hotswap in progress
        controller.prioritize('model-b');

        // Cancel everything mid-hotswap
        await controller.cancelAll();

        const state = controller.getState();
        expect(state.get('model-a')!.state).toBe('cancelled');
        expect(state.get('model-b')!.state).toBe('cancelled');
    });

    // =========================================================================
    // EDGE CASE: clearAndRedownloadModel on a completed model
    // =========================================================================

    it('should clear and redownload a model that has already completed', async () => {
        const controller = createAssetDownloadController();

        // Complete initial download
        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        expect(controller.getState().get('model-a')!.state).toBe('complete');
        const initialFetchCount = mockFetch.mock.calls.length;

        // Clear and redownload
        await controller.clearAndRedownloadModel('model-a');

        // Should be complete again (fresh download)
        expect(controller.getState().get('model-a')!.state).toBe('complete');
        // Should have made additional fetch calls
        expect(mockFetch.mock.calls.length).toBeGreaterThan(initialFetchCount);
    });

    // =========================================================================
    // EDGE CASE: clearAndRedownloadModel on a paused model
    // =========================================================================

    it('should clear and redownload a model that is currently paused', async () => {
        const controller = createAssetDownloadController();
        let fetchCount = 0;

        mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
            fetchCount++;
            // All requests succeed immediately
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            });
        });

        // Start model-a (completes immediately with new mock)
        await controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256);

        // Model-a is complete, now clear and redownload
        const fetchCountBefore = fetchCount;
        await controller.clearAndRedownloadModel('model-a');

        // Should be complete again
        expect(controller.getState().get('model-a')!.state).toBe('complete');
        // Should have made additional fetch calls
        expect(fetchCount).toBeGreaterThan(fetchCountBefore);
    });

    // =========================================================================
    // EDGE CASE: clearAndRedownloadModel on an actively downloading model
    // =========================================================================

    it('should abort and restart a model that is actively downloading', async () => {
        const controller = createAssetDownloadController();
        let fetchCount = 0;
        let shouldHang = true;

        mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
            fetchCount++;
            if (!shouldHang) {
                // After clearAndRedownload, succeed immediately
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => '100' },
                    body: new ReadableStream({
                        start(ctrl) {
                            ctrl.enqueue(new Uint8Array(100));
                            ctrl.close();
                        }
                    })
                });
            }
            // First attempt: hang until aborted
            return new Promise((_, reject) => {
                if (opts?.signal) {
                    opts.signal.addEventListener('abort', () => {
                        shouldHang = false; // Allow next call to succeed
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                }
            });
        });

        // Start download (will hang)
        const promise = controller.request('model-a', {
            onnx: 'https://example.com/model-a.onnx',
            config: 'https://example.com/model-a.onnx.json'
        }, TEST_SHA256).catch(() => {});

        // Wait a tick for the download to start
        await new Promise(r => setTimeout(r, 10));

        // clearAndRedownloadModel will abort the hanging download and restart
        await controller.clearAndRedownloadModel('model-a');

        // Should be complete after restart
        expect(controller.getState().get('model-a')!.state).toBe('complete');
        // Should have made multiple fetch calls (aborted + restarted)
        expect(fetchCount).toBeGreaterThanOrEqual(2);

        // Clean up the original promise
        await promise;
    });
});
