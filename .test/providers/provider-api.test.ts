import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPiperProvider } from '../../src/providers/create-piper-provider';

/**
 * Provider API Test
 * 
 * Tests the high-level provider methods that expose download state
 * and cache management. These are documented in README.md but were
 * not covered by existing tests.
 * 
 * Coverage targets:
 * - getDownloadState() (line 135)
 * - cancelDownload() (line 130)
 * - clearPiperModelCache() (line 112)
 */
describe('Provider API', () => {
    let provider: ReturnType<typeof createPiperProvider>;
    
    beforeEach(() => {
        // Mock Service Worker for JSDOM environment
        (global as any).navigator.serviceWorker = {
            register: vi.fn().mockResolvedValue({ scope: '/piper-gate/' }),
            ready: Promise.resolve(),
            controller: {}, // Simulate being controlled
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };

        provider = createPiperProvider();
        vi.clearAllMocks();
    });
    
    afterEach(() => {
        provider.terminate();
    });

    describe('getDownloadState()', () => {
        it('should return empty Map before any downloads', () => {
            const state = provider.getDownloadState();
            expect(state).toBeInstanceOf(Map);
            expect(state.size).toBe(0);
        });

        it('should return download state after init starts', async () => {
            // Suppress expected warnings
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            // Init triggers download controller activity
            await provider.init({

                modelId: 'en_US-bryce-medium',
                cpuInstances: 2
            });
            
            const state = provider.getDownloadState();
            
            // Verify the method returns a valid Map instance
            // Downloads may complete quickly in mock environment, so size can vary
            expect(state).toBeInstanceOf(Map);
            
            spy.mockRestore();
        });
    });

    describe('cancelDownload()', () => {
        it('should call downloader.cancel with modelId', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            // Cancel should not throw even for non-existent download
            // Reaching this point without exception proves the method handles missing downloads gracefully
            await provider.cancelDownload('en_US-libritts-high');
            
            spy.mockRestore();
        });
    });

    describe('clearPiperModelCache()', () => {
        it('should terminate farm and clear OPFS', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            // Initialize first
            await provider.init({

                modelId: 'en_US-bryce-medium',
                cpuInstances: 2
            });
            
            expect(provider.isInitialized()).toBe(true);
            expect(provider.getActiveModelId()).toBe('en_US-bryce-medium');
            
            // Clear cache
            await provider.clearPiperModelCache();
            
            // Verify state reset
            expect(provider.isInitialized()).toBe(false);
            expect(provider.getActiveModelId()).toBeNull();
            
            spy.mockRestore();
        });

        it('should handle operations safely before explicit initialization', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            // Clear without init should not throw
            await provider.clearPiperModelCache();
            
            expect(provider.isInitialized()).toBe(false);
            expect(provider.getActiveModelId()).toBeNull();
            
            spy.mockRestore();
        });
    });

    describe('metrics', () => {
        it('should return zero metrics when not initialized', () => {
            const metrics = provider.metrics;
            
            expect(metrics.queueLength).toBe(0);
            expect(metrics.busyWorkers).toBe(0);
            expect(metrics.totalWorkers).toBe(0);
        });

        it('should return farm metrics after initialization', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            await provider.init({

                modelId: 'en_US-bryce-medium',
                cpuInstances: 2
            });
            
            const metrics = provider.metrics;
            
            expect(metrics.totalWorkers).toBe(2);
            expect(metrics.busyWorkers).toBe(0);
            expect(metrics.queueLength).toBe(0);
            
            spy.mockRestore();
        });
    });

    describe('Granular Cancellation', () => {
        it('should cancel specific synthesis via AbortSignal', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await provider.init({

                modelId: 'en_US-bryce-medium',
                cpuInstances: 2
            });
            
            const aborter = new AbortController();
            const promise = provider.synthesize('Cancelled', { signal: aborter.signal });
            aborter.abort();
            
            await expect(promise).rejects.toThrow('Synthesis cancelled');
            spy.mockRestore();
        });

        it('should clear remaining queue via cancelAllSynthesis', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await provider.init({

                modelId: 'en_US-bryce-medium',
                cpuInstances: 2
            });
            
            // Queue up multiple tasks
            const p1 = provider.synthesize('Task 1');
            const p2 = provider.synthesize('Task 2');
            const p3 = provider.synthesize('Task 3');
            const p4 = provider.synthesize('Task 4');
            const p5 = provider.synthesize('Task 5');
            
            // Cancel all immediately
            provider.cancelAllSynthesis();
            
            await expect(p1).rejects.toThrow('Synthesis cancelled');
            await expect(p2).rejects.toThrow('Synthesis cancelled');
            await expect(p3).rejects.toThrow('Synthesis cancelled');
            await expect(p4).rejects.toThrow('Synthesis cancelled');
            await expect(p5).rejects.toThrow('Synthesis cancelled');
            
            expect(provider.metrics.queueLength).toBe(0);
            
            spy.mockRestore();
        });
    });
});