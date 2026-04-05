import { describe, it, expect, vi } from 'vitest';
import { createPiperProvider } from '../../src/providers/create-piper-provider';

/**
 * Worker-Thread Callback Test
 * 
 * Verifies the callbackModule feature documented in README.md:
 * - Callback module can be configured during init
 * - Synthesis returns callbackResult when callback is loaded
 * - Callback result has expected structure
 * 
 * Implementation: See process-piper-synthesis.worker.ts lines 45-47, 180-208
 */
describe('Worker-Thread Callback Module', () => {
    it('should return callbackResult when callbackModule is configured', async () => {
        // Suppress expected warnings from mock environment
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        // Initialize with callback module configuration
        await provider.init({
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            callbackModule: {
                path: '/test/fixtures/callback-module.ts',
                functionName: 'onSynthesisComplete'
            }
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

    it('should NOT return callbackResult when callbackModule is NOT configured', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        // Initialize WITHOUT callback module
        await provider.init({
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2
            // No callbackModule config
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
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2,
            callbackModule: {
                path: '/test/fixtures/callback-module.ts',
                functionName: 'onSynthesisComplete'
            }
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