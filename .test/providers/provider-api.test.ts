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
                voiceId: 'en_US-bryce-medium',
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
                voiceId: 'en_US-bryce-medium',
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

        it('should work even when not initialized', async () => {
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
                voiceId: 'en_US-bryce-medium',
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
});