import { describe, it, expect } from 'vitest';
import { collectTransferables } from '../../src/worker/index';

describe('worker-utils', () => {
    describe('collectTransferables', () => {
        it('should collect ArrayBuffer objects', () => {
            const buffer = new ArrayBuffer(10);
            const result = collectTransferables(buffer);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('should collect buffers from TypedArrays', () => {
            const uint8 = new Uint8Array(5);
            const float32 = new Float32Array(5);
            const result = collectTransferables({ uint8, float32 });
            
            expect(result).toHaveLength(2);
            expect(result).toContain(uint8.buffer);
            expect(result).toContain(float32.buffer);
        });

        it('should traverse nested objects recursively', () => {
            const buffer1 = new ArrayBuffer(1);
            const buffer2 = new ArrayBuffer(2);
            const input = {
                a: {
                    b: buffer1,
                    c: [buffer2]
                }
            };
            
            const result = collectTransferables(input);
            expect(result).toHaveLength(2);
            expect(result).toContain(buffer1);
            expect(result).toContain(buffer2);
        });

        it('should handle null and undefined safely', () => {
            expect(collectTransferables(null)).toHaveLength(0);
            expect(collectTransferables(undefined)).toHaveLength(0);
            expect(collectTransferables({ a: null, b: undefined })).toHaveLength(0);
        });

        it('should ignore non-transferable primitives', () => {
            const input = {
                str: 'hello',
                num: 123,
                bool: true,
                fn: () => {}
            };
            expect(collectTransferables(input)).toHaveLength(0);
        });
    });
});
