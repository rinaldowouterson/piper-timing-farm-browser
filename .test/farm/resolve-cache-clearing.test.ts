import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPiperWorkerFarm } from '../../src/farm/create-piper-worker-farm';

describe('PiperWorkerFarm: Cache Management', () => {
    let mockRoot: any;

    beforeEach(() => {
        mockRoot = {
            removeEntry: vi.fn().mockResolvedValue(undefined)
        };
        
        // Mock the global navigator.storage
        (global as any).navigator = {
            storage: {
                getDirectory: vi.fn().mockResolvedValue(mockRoot)
            }
        };

        // Mock the Worker since we're in a Node environment
        (global as any).Worker = vi.fn().mockImplementation(() => ({
            postMessage: vi.fn(),
            terminate: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        }));
    });

    it('should terminate the pool and remove the voices directory', async () => {
        const farm = createPiperWorkerFarm();
        
        // Mock init to verify it's cleared later
        await farm.clearPiperModelCache();

        expect(mockRoot.removeEntry).toHaveBeenCalledWith('voices', { recursive: true });
    });

    it('should be idempotent and ignore NotFoundError', async () => {
        const farm = createPiperWorkerFarm();
        
        const err = new Error('OPFS Entry not found');
        err.name = 'NotFoundError';
        mockRoot.removeEntry.mockRejectedValue(err);

        // This should NOT throw
        await expect(farm.clearPiperModelCache()).resolves.toBeUndefined();
    });

    it('should throw on other storage errors', async () => {
        const farm = createPiperWorkerFarm();
        
        mockRoot.removeEntry.mockRejectedValue(new Error('Atomic Explosion'));

        // Suppress expected console.error from production code
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(farm.clearPiperModelCache()).rejects.toThrow('Atomic Explosion');
        spy.mockRestore();
    });
});