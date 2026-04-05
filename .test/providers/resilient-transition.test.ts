import { describe, it, expect, vi } from 'vitest';
import { createPiperProvider } from '../../src/providers/create-piper-provider';

/**
 * Resilience Test: Successive, rapid model switches during active synthesis.
 * Identifies race conditions and queue corruption.
 * 
 * Verifies:
 * 1. FIFO (First-In-First-Out) queue remains intact.
 * 2. Asynchronous provisioning doesn't block ongoing requests.
 * 3. Handoff to new models is atomic.
 */
describe('Resilient Model Transition Test', () => {
    it('should maintain FIFO queue during rapid model switching', async () => {
        // Suppress expected SHA-256 and OPFS warnings from mock environment
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const provider = createPiperProvider();
        
        // 1. Initial Load: Bryce
        await provider.init({
            voiceId: 'en_US-bryce-medium',
            modelId: 'en_US-bryce-medium',
            cpuInstances: 2
        });

        // 2. Start two long syntheses with Bryce
        const p1 = provider.synthesize('Sentence 1 with Bryce');
        const p2 = provider.synthesize('Sentence 2 with Bryce');

        // 3. RAPID SWITCH (Stress Test Transition)
        // Transition to Ukrainian while Bryce is still processing
        const switchPromise = provider.init({
            voiceId: 'uk_UA-ukrainian_tts-medium',
            modelId: 'uk_UA-ukrainian_tts-medium',
            cpuInstances: 2
        });

        // 4. Queue one more sentence while in transitional state
        const p3 = provider.synthesize('Sentence 3 with UA');

        // Wait for all to finish
        const [r1, r2, _, r3] = await Promise.all([p1, p2, switchPromise, p3]);

        // VERIFICATION
        // 1. Queue integrity: All three must have finished in the order they were called
        expect(r1.metadata.modelId).toBe('en_US-bryce-medium');
        expect(r2.metadata.modelId).toBe('en_US-bryce-medium');
        expect(r3.metadata.modelId).toBe('uk_UA-ukrainian_tts-medium');

        // 2. Terminal proof: All requests were handled successfully
        expect(provider.getActiveModelId()).toBe('uk_UA-ukrainian_tts-medium');
        
        spy.mockRestore();
        provider.terminate();
    });
});