/**
 * Atomic, session-independent OPFS cache clearing.
 * 
 * Logic:
 * 1. Accesses the Origin Private File System root.
 * 2. Recursively deletes the 'voices' directory.
 * 3. Handles 'NotFoundError' gracefully (idempotent).
 */
export async function resolveCacheClearing(): Promise<void> {
    if (!navigator?.storage?.getDirectory) return;

    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('voices', { recursive: true });
    } catch (err: any) {
        // Idempotent: Ignore if it doesn't exist.
        if (err.name === 'NotFoundError') {
            return;
        }
        console.error('[PiperFarm] Cache clearing failed:', err);
        throw err;
    }
}
