import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * SHA-256 Verification Test
 * 
 * Tests the actual cryptographic implementation (not mocked).
 * The setup.ts mocks this module globally, so we need to unmock
 * for this specific test file.
 * 
 * Coverage target: resolve-sha256.ts (currently 100% mocked)
 */

// Unmock for this test file - import actual implementation
const actualModule = await vi.importActual<typeof import('../../src/utils/resolve-sha256')>(
    '../../src/utils/resolve-sha256'
);
const { calculateSha256, verifySha256 } = actualModule;

describe('SHA-256 Verification', () => {
    describe('calculateSha256()', () => {
        it('should calculate correct SHA-256 hash for known input', async () => {
            // Known test vector: "hello" → SHA-256
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const hash = await calculateSha256(input);
            
            // Expected SHA-256 of "hello" (lowercase hex)
            const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
            expect(hash).toBe(expected);
        });

        it('should produce consistent hashes for same input', async () => {
            const input = new TextEncoder().encode('test data').buffer as ArrayBuffer;
            
            const hash1 = await calculateSha256(input);
            const hash2 = await calculateSha256(input);
            
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different inputs', async () => {
            const input1 = new TextEncoder().encode('data1').buffer as ArrayBuffer;
            const input2 = new TextEncoder().encode('data2').buffer as ArrayBuffer;
            
            const hash1 = await calculateSha256(input1);
            const hash2 = await calculateSha256(input2);
            
            expect(hash1).not.toBe(hash2);
        });

        it('should handle empty buffer', async () => {
            const empty = new ArrayBuffer(0);
            const hash = await calculateSha256(empty);
            
            // SHA-256 of empty string
            const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
            expect(hash).toBe(expected);
        });
    });

    describe('verifySha256()', () => {
        it('should pass verification when hash matches', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const expectedHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
            
            // Should not throw
            await verifySha256(input, expectedHash, 'test-url');
        });

        it('should throw error when hash does not match', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';
            
            await expect(verifySha256(input, wrongHash, 'test-url')).rejects.toThrow(
                'Binary Integrity Verification Failed'
            );
        });

        it('should be case-insensitive for hash comparison', async () => {
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const uppercaseHash = '2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824';
            
            // Should not throw (case-insensitive)
            await verifySha256(input, uppercaseHash, 'test-url');
        });

        it('should log error on mismatch', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            
            const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
            const wrongHash = 'wronghash';
            
            await expect(verifySha256(input, wrongHash, 'https://example.com/file.onnx')).rejects.toThrow();
            
            // Should have logged the mismatch details
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('SHA-256 Mismatch')
            );
            
            errorSpy.mockRestore();
        });
    });
});