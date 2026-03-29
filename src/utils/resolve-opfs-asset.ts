import { verifyMd5 } from "./resolve-md5";

/**
 * OPFS (Origin Private File System) Asset Resolver.
 * 
 * Provides a persistent, read-through cache for large binary assets (models, wasm).
 * 1. Checks if asset exists in OPFS with correct MD5.
 * 2. If missing/invalid, fetches from network, verifies MD5, and writes to OPFS.
 * 3. Returns a URL (typically a blob or the OPFS entry) for use in Workers.
 */

/**
 * Resolves a Piper model asset via OPFS cache.
 * @param url The public URL to fetch from if not cached.
 * @param modelId Unique identifier for the voice model.
 * @param extension File extension (onnx, onnx.json).
 * @param expectedMd5 Expected MD5 checksum for integrity verification.
 * @returns The binary data as an ArrayBuffer.
 */
export async function resolveOpfsAsset(
  url: string,
  modelId: string,
  extension: string,
  expectedMd5?: string
): Promise<ArrayBuffer> {
  const filename = `${modelId}.${extension}`;
  
  try {
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle("voices", { create: true });
    
    // 1. Try to read from OPFS
    try {
      const fileHandle = await voicesDir.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      
      // Verification: If MD5 is provided, verify integrity of cached file
      if (expectedMd5) {
        try {
          await verifyMd5(buffer, expectedMd5, url);
          // console.log(`[OPFS] Cache Hit & Verified: ${filename}`);
          return buffer;
        } catch (err) {
          console.warn(`[OPFS] Cache Corrupted for ${filename}. Re-fetching...`);
          // Fall through to fetch
        }
      } else {
        return buffer;
      }
    } catch (err) {
      // File not found, proceed to fetch
    }

    // 2. Fetch from Network
    // console.log(`[OPFS] Cache Miss: Fetching ${url}...`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch asset: ${response.statusText}`);
    
    const buffer = await response.arrayBuffer();
    
    // 3. Verify Integrity before caching
    if (expectedMd5) {
      await verifyMd5(buffer, expectedMd5, url);
    }

    // 4. Write to OPFS for persistence
    const fileHandle = await voicesDir.getFileHandle(filename, { create: true });
    // @ts-ignore - createWritable is still emerging in some type definitions
    const writable = await fileHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    
    // console.log(`[OPFS] Successfully cached: ${filename}`);
    return buffer;

  } catch (err) {
    const errorVal = err instanceof Error ? err : new Error(String(err));
    console.error(`[OPFS] Resolution failed for ${filename}:`, errorVal.message);
    throw errorVal;
  }
}
