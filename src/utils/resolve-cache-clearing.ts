import { setupAssetSW } from "./setup-asset-sw";
import { GATEWAY_ROOT } from "./resolve-gateway-path";

/**
 * Atomic, session-independent OPFS cache clearing.
 * 
 * Service Worker Gateway Architecture:
 * - Delegates all storage operations to the Service Worker via DELETE /piper-gate/voices/
 * - Uses setupAssetSW() as a guard to ensure the gateway is active.
 */
export async function clearModelCache(): Promise<void> {
    try {
        // Ensure Service Worker Gateway is active before dispatching deletion
        await setupAssetSW().catch(() => {});

        const res = await fetch(`${GATEWAY_ROOT}voices/`, { method: 'DELETE' });
        
        if (!res.ok && res.status !== 204) {
            throw new Error(`Gateway returned ${res.status}: ${res.statusText}`);
        }
        
        console.log('[PiperFarm] Voice cache cleared via Service Worker Gateway');
    } catch (err) {
        console.error('[PiperFarm] Voice cache clearing failed:', err);
        throw err;
    }
}

/**
 * Clear the Piper infra asset cache (WASM, worker scripts).
 * Delegates to the Service Worker Gateway.
 */
export async function clearInfraCache(): Promise<void> {
    try {
        await setupAssetSW().catch(() => {});

        const res = await fetch(`${GATEWAY_ROOT}infra/`, { method: 'DELETE' });

        if (!res.ok && res.status !== 204) {
            throw new Error(`Gateway returned ${res.status}: ${res.statusText}`);
        }

        console.log('[PiperFarm] Infra asset cache cleared via Service Worker Gateway');
    } catch (err) {
        console.error('[PiperFarm] Infra cache clearing failed:', err);
        throw err;
    }
}

/**
 * Delete a specific model's cached OPFS files.
 * Routes through the Service Worker Gateway for atomic cleanup.
 */
export async function deletePiperModel(modelId: string): Promise<void> {
    try {
        await setupAssetSW().catch(() => {});

        const res = await fetch(`${GATEWAY_ROOT}voices/${modelId}`, { method: 'DELETE' });

        if (!res.ok && res.status !== 204) {
            throw new Error(`Gateway returned ${res.status}: ${res.statusText}`);
        }

        console.log(`[PiperFarm] Model deleted from cache: ${modelId}`);
    } catch (err) {
        console.error(`[PiperFarm] Model deletion failed for ${modelId}:`, err);
        throw err;
    }
}
