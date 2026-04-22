import { describe, it, expect, vi } from 'vitest';

/**
 * SHA-256 Verification Test (Browser-only)
 * 
 * Browser-only: crypto.subtle is always available in Secure Contexts.
 * No fallback needed — this is a Sovereign Browser project.
 */

// Unmock for this test file
const actualModule = await vi.importActual<typeof import('../../src/utils/resolve-sha256-browser')>(
    '../../src/utils/resolve-sha256-browser'
);
const { calculateSha256, calculateSha256CryptoSubtle, verifySha256 } = actualModule;

describe('SHA-256 Browser (Sovereign)', () => {
    describe('calculateSha256()', () => {
        it('should use crypto.subtle for hashing', async () => {
             const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
             const hash = await calculateSha256(input);
             const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
             expect(hash).toBe(expected);
        });
    });

    describe('calculateSha256CryptoSubtle()', () => {
        it('should calculate correct hash for known input', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const hash = await calculateSha256CryptoSubtle(input);
            expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
        });

        it('should handle string input', async () => {
            const hash = await calculateSha256CryptoSubtle('hello');
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

        it('should work without URL parameter', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const expectedHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
            await verifySha256(input, expectedHash);
        });
    });
});