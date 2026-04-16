import { describe, it, expect, vi } from 'vitest';
import { calculateSha256Custom } from '../../src/utils/resolve-sha256-custom';

/**
 * SHA-256 Verification Test (Browser Orchestrator)
 */

// Unmock for this test file
const actualModule = await vi.importActual<typeof import('../../src/utils/resolve-sha256-browser')>(
    '../../src/utils/resolve-sha256-browser'
);
const { calculateSha256, calculateSha256CryptoSubtle, verifySha256 } = actualModule;

describe('SHA-256 Browser Orchestrator', () => {
    describe('Symmetry Proof (Native vs Custom)', () => {
        it('should produce bitwise identical results for both implementations', async () => {
            const testVectors = [
                'hello',
                '',
                'The quick brown fox jumps over the lazy dog',
                'Piper synthesis timing farm security hardening'
            ];

            for (const text of testVectors) {
                const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer;
                
                const nativeHash = await calculateSha256CryptoSubtle(buffer);
                const customHash = calculateSha256Custom(buffer);

                expect(customHash).toBe(nativeHash);
            }
        });
    });

    describe('calculateSha256() - Automatic Branching', () => {
        it('should use calculateSha256CryptoSubtle when crypto.subtle is available', async () => {
             const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
             const hash = await calculateSha256(input);
             const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
             expect(hash).toBe(expected);
        });

        it('should fallback to calculateSha256Custom when crypto.subtle is absent', async () => {
            const originalCrypto = globalThis.crypto;
            Object.defineProperty(globalThis, 'crypto', {
                value: { subtle: undefined },
                configurable: true
            });

            try {
                const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
                const hash = await calculateSha256(input);
                const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
                expect(hash).toBe(expected);
            } finally {
                Object.defineProperty(globalThis, 'crypto', {
                    value: originalCrypto,
                    configurable: true
                });
            }
        });
    });

    describe('calculateSha256CryptoSubtle()', () => {
        it('should calculate correct hash for known input', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const hash = await calculateSha256CryptoSubtle(input);
            expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
        });
    });

    describe('verifySha256()', () => {
        it('should pass verification when hash matches', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const expectedHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
            await verifySha256(input, expectedHash, 'test-url');
        });

        it('should throw error when hash does not match', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            await expect(verifySha256(input, 'wrong', 'test-url')).rejects.toThrow();
        });
    });
});