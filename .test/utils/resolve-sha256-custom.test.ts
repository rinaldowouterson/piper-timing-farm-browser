import { describe, it, expect } from 'vitest';
import { calculateSha256Custom } from '../../src/utils/resolve-sha256-custom';

describe('SHA-256 Custom Implementation (JS Fallback)', () => {
    it('should calculate correct SHA-256 hash for known input (hello)', () => {
        const input = new TextEncoder().encode('hello').buffer as ArrayBuffer;
        const hash = calculateSha256Custom(input);
        
        const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
        expect(hash).toBe(expected);
    });

    it('should handle empty buffer correctly', () => {
        const empty = new ArrayBuffer(0);
        const hash = calculateSha256Custom(empty);
        
        const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        expect(hash).toBe(expected);
    });

    it('should work with string input', () => {
        const hash = calculateSha256Custom('hello');
        const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
        expect(hash).toBe(expected);
    });

    it('should work with Uint8Array input', () => {
        const input = new TextEncoder().encode('hello');
        const hash = calculateSha256Custom(input);
        const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
        expect(hash).toBe(expected);
    });

    it('should produce consistent hashes for same input', () => {
        const input = new TextEncoder().encode('consistent test').buffer;
        const h1 = calculateSha256Custom(input);
        const h2 = calculateSha256Custom(input);
        expect(h1).toBe(h2);
    });

    it('should produce different hashes for different inputs', () => {
        const h1 = calculateSha256Custom('abc');
        const h2 = calculateSha256Custom('abd');
        expect(h1).not.toBe(h2);
    });
});
