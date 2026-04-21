import { describe, it } from 'vitest';
import { calculateSha256Custom } from '../../src/utils/resolve-sha256-custom';
import { calculateSha256CryptoSubtle } from '../../src/utils/resolve-sha256-browser';

/**
 * SHA-256 Performance Benchmark (60MB Stress Test)
 * 
 * This test evaluates the overhead of hashing a large binary asset (standard TTS model size).
 */

describe('SHA-256 Performance Benchmark (60MB)', () => {
    it('should measure hashing performance for 60MB of random data', async () => {
        const SIXTY_MB = 60 * 1024 * 1024;
        console.log(`\n--- Hashing Benchmark: 60MB ---`);
        
        // Initialize the buffer manually to avoid the 65KB limit of getRandomValues
        const buffer = new Uint8Array(SIXTY_MB);
        for (let i = 0; i < SIXTY_MB; i++) {
            buffer[i] = i % 256;
        }
        const arrayBuffer = buffer.buffer as ArrayBuffer;

        // 1. Native Path (Web Crypto / Subtle)
        const t0 = performance.now();
        const nativeHash = await calculateSha256CryptoSubtle(arrayBuffer);
        const t1 = performance.now();
        const nativeTime = (t1 - t0).toFixed(2);
        console.log(`[Native Path] Time: ${nativeTime}ms (Hash: ${nativeHash.slice(0, 8)}...)`);

        // 2. Custom Path (JS Fallback)
        const t2 = performance.now();
        const customHash = calculateSha256Custom(arrayBuffer);
        const t3 = performance.now();
        const customTime = (t3 - t2).toFixed(2);
        console.log(`[Custom Path] Time: ${customTime}ms (Hash: ${customHash.slice(0, 8)}...)`);

        const factor = (Number(customTime) / Number(nativeTime)).toFixed(1);
        console.log(`\nConclusion: Native is ${factor}x faster than JS fallback for 60MB.`);
        console.log(`-------------------------------\n`);
    }, 30000); // Higher timeout for the slow JS path
});
