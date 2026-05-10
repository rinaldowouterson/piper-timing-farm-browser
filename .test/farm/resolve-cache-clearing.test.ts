import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearModelCache, deletePiperModel } from '../../src/utils/resolve-cache-clearing';

// Mock setupAssetSW to avoid real SW registration
vi.mock('../../src/utils/setup-asset-sw', () => ({
    setupAssetSW: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Sovereign Cache Management', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe('clearModelCache', () => {
        it('should send DELETE /piper-gate/voices/ to the Sovereign Gateway', async () => {
            mockFetch.mockResolvedValue({ ok: true, status: 204 });

            await clearModelCache();

            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/piper-gate/voices/'), { method: 'DELETE' });
        });

        it('should accept 204 No Content as success', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 204 });

            await expect(clearModelCache()).resolves.toBeUndefined();
        });

        it('should throw on gateway error (500)', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(clearModelCache()).rejects.toThrow('Gateway returned 500');
            spy.mockRestore();
        });

        it('should throw on network failure', async () => {
            mockFetch.mockRejectedValue(new Error('Network unreachable'));

            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(clearModelCache()).rejects.toThrow('Network unreachable');
            spy.mockRestore();
        });
    });

    describe('deletePiperModel', () => {
        it('should send DELETE /piper-gate/voices/{modelId} to the Sovereign Gateway', async () => {
            mockFetch.mockResolvedValue({ ok: true, status: 204 });

            await deletePiperModel('en_US-lessac-medium');

            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/piper-gate/voices/en_US-lessac-medium'), { method: 'DELETE' });
        });

        it('should accept 204 No Content as success', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 204 });

            await expect(deletePiperModel('en_US-lessac-medium')).resolves.toBeUndefined();
        });

        it('should throw on gateway error (400)', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(deletePiperModel('bad-model')).rejects.toThrow('Gateway returned 400');
            spy.mockRestore();
        });
    });
});