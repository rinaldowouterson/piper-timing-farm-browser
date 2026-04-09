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
        const p1 = controller.request('model-1', { 
            onnx: 'https://example.com/model-1.onnx', 
            config: 'https://example.com/model-1.onnx.json' 
        }, { onnx: 'hash', config: 'hash' }).catch(e => {
            console.error('model-1 failed:', e);
            throw e;
        });
        const p2 = controller.request('model-2', { 
            onnx: 'https://example.com/model-2.onnx', 
            config: 'https://example.com/model-2.onnx.json' 
        }, { onnx: 'hash', config: 'hash' });
        const p3 = controller.request('model-3', { 
            onnx: 'https://example.com/model-3.onnx', 
            config: 'https://example.com/model-3.onnx.json' 
        }, { onnx: 'hash', config: 'hash' });

        // Check initial state
        const state1 = controller.getState();
        expect(state1.get('model-1')!.state).toBe('downloading');
        expect(state1.get('model-2')!.state).toBe('pending');
        expect(state1.get('model-3')!.state).toBe('pending');

        await Promise.all([p1, p2, p3]);

        // Check completion
        const stateFinal = controller.getState();
        expect(stateFinal.get('model-1')!.state).toBe('complete');
        expect(stateFinal.get('model-2')!.state).toBe('complete');
        expect(stateFinal.get('model-3')!.state).toBe('complete');

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

        const pFail = controller.request('model-fail', { 
            onnx: 'https://example.com/model-fail.onnx', 
            config: 'https://example.com/model-fail.onnx.json' 
        }, { onnx: 'hash', config: 'hash' }).catch(() => {});
        const pSuccess = controller.request('model-success', { 
            onnx: 'https://example.com/model-success.onnx', 
            config: 'https://example.com/model-success.onnx.json' 
        }, { onnx: 'hash', config: 'hash' });

        try { await pFail; } catch {}
        await pSuccess;

        const state = controller.getState();
        expect(state.get('model-fail')!.state).toBe('error');
        expect(state.get('model-success')!.state).toBe('complete');
        
        errorSpy.mockRestore();
    });

    it('should remove from queue and registry on cancel', async () => {
        const controller = createAssetDownloadController();

        mockFetch.mockImplementation(() => new Promise(() => {})); // Hangs

        const p1 = controller.request('model-1', { onnx: 'url1.onnx', config: 'url1.json' }).catch(() => {});
        const p2 = controller.request('model-2', { onnx: 'url2.onnx', config: 'url2.json' }).catch(() => {});

        expect(controller.getState().has('model-2')).toBe(true);
        
        await controller.cancel('model-2');
        
        expect(controller.getState().has('model-2')).toBe(false);
        
        // Now cancel the active one
        await controller.cancel('model-1');
        expect(controller.getState().has('model-1')).toBe(false);
    });
});
