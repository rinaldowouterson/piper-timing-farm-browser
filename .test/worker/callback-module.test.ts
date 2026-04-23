import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPiperProvider } from '../../src/providers/create-piper-provider';

/**
 * Sovereign Callback Test
 * 
 * Verifies the sovereign callback feature:
 * - Callback module can be enabled via useCallback during init
 * - Synthesis returns callbackResult when callback is loaded
 * - Callback result has expected structure
 * 
 * Implementation: See process-piper-synthesis.worker.ts (toggleCallback)
 */
describe('Sovereign Callback Module', () => {
    beforeEach(() => {
        // Mock Service Worker for JSDOM environment
        (global as any).navigator.serviceWorker = {
            register: vi.fn().mockResolvedValue({ scope: '/piper-gate/' }),
            ready: Promise.resolve(),
            controller: {},
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
    });

    it('should return callbackResult when useCallback is true', async () => {
        // Suppress expected warnings from mock environment
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        // Initialize with callback module configuration
        await provider.init({
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            useCallback: true
        });

        // Synthesize with callback enabled
        const result = await provider.synthesize('Hello, world!');
        
        // VERIFICATION: callbackResult should be present
        expect(result.callbackResult).toBeDefined();
        expect(result.callbackResult).toHaveProperty('success', true);
        expect(result.callbackResult).toHaveProperty('phonemeCount');
        expect(result.callbackResult).toHaveProperty('audioSampleCount');
        
        // Metadata should also be populated (for callback processing)
        expect(result.metadata.phonemes).toBeDefined();
        expect(result.metadata.durations).toBeDefined();
        
        spy.mockRestore();
        provider.terminate();
    });

    it('should NOT return callbackResult when useCallback is false/undefined', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        // Initialize WITHOUT callback module
        await provider.init({
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2
            // No useCallback config (defaults to false)
        });

        const result = await provider.synthesize('Hello, world!');
        
        // VERIFICATION: callbackResult should be undefined
        expect(result.callbackResult).toBeUndefined();
        
        spy.mockRestore();
        provider.terminate();
    });

    it('should support multiple sequential syntheses with callback', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        await provider.init({
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            useCallback: true
        });

        // Sequential syntheses should each get callback results
        const r1 = await provider.synthesize('First sentence');
        const r2 = await provider.synthesize('Second sentence');
        
        expect(r1.callbackResult).toBeDefined();
        expect(r2.callbackResult).toBeDefined();
        expect(r1.callbackResult.success).toBe(true);
        expect(r2.callbackResult.success).toBe(true);
        
        spy.mockRestore();
        provider.terminate();
    });
});