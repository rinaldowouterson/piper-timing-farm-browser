import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssetDownloadController } from '../../src/farm/control-asset-download';

// Mock fetch globally for download simulation
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Download Controller FIFO (Option B)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        // Default behavior: return a successful response
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

    it('should process downloads one at a time in FIFO order', async () => {
        const controller = createAssetDownloadController();
        const startTimes: Record<string, number> = {};
        const endTimes: Record<string, number> = {};

        // Mock fetch with a delay so we can overlap requests
        mockFetch.mockImplementation(async (url: string) => {
            const modelId = url.split('/').pop()?.split('.')[0] || 'unknown';
            startTimes[modelId] = Date.now();
            
            // Artificial delay
            await new Promise(resolve => setTimeout(resolve, 50));
            
            endTimes[modelId] = Date.now();
            return {
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            };
        });

        // Start 3 downloads simultaneously
        const p1 = controller.request('model-1').catch(e => {
            console.error('model-1 failed:', e);
            throw e;
        });
        const p2 = controller.request('model-2');
        const p3 = controller.request('model-3');

        // Check initial state
        const state1 = controller.getState();
        expect(state1.get('model-1')!.status).toBe('downloading');
        expect(state1.get('model-2')!.status).toBe('pending');
        expect(state1.get('model-3')!.status).toBe('pending');

        await Promise.all([p1, p2, p3]);

        // Check completion
        const stateFinal = controller.getState();
        expect(stateFinal.get('model-1')!.status).toBe('complete');
        expect(stateFinal.get('model-2')!.status).toBe('complete');
        expect(stateFinal.get('model-3')!.status).toBe('complete');

        // Verify sequential execution: end of N <= start of N+1
        // (Note: there might be a few ms of overhead in JS event loop)
        expect(endTimes['model-1']).toBeLessThanOrEqual(startTimes['model-2'] + 5);
        expect(endTimes['model-2']).toBeLessThanOrEqual(startTimes['model-3'] + 5);
    });

    it('should continue queue even after an error', async () => {
        const controller = createAssetDownloadController();
        
        // Suppress expected error logs
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes('model-fail')) {
                await new Promise(resolve => setTimeout(resolve, 20));
                throw new Error('Network failure');
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => '100' },
                body: new ReadableStream({
                    start(ctrl) {
                        ctrl.enqueue(new Uint8Array(100));
                        ctrl.close();
                    }
                })
            };
        });

        const pFail = controller.request('model-fail').catch(() => {});
        const pSuccess = controller.request('model-success');

        try { await pFail; } catch {}
        await pSuccess;

        const state = controller.getState();
        expect(state.get('model-fail')!.status).toBe('error');
        expect(state.get('model-success')!.status).toBe('complete');
        
        errorSpy.mockRestore();
    });

    it('should remove from queue and registry on cancel', async () => {
        const controller = createAssetDownloadController();

        mockFetch.mockImplementation(() => new Promise(() => {})); // Hangs

        const p1 = controller.request('model-1').catch(() => {});
        const p2 = controller.request('model-2').catch(() => {});

        expect(controller.getState().has('model-2')).toBe(true);
        
        await controller.cancel('model-2');
        
        expect(controller.getState().has('model-2')).toBe(false);
        
        // Now cancel the active one
        await controller.cancel('model-1');
        expect(controller.getState().has('model-1')).toBe(false);
    });
});
