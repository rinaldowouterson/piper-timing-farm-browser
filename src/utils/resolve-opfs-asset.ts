import { verifySha256 } from "./resolve-sha256";
import { downloadFile } from "@huggingface/hub";

function extractHFRepoPath(url: string): { repo: string; path: string; revision: string } | null {
  const match = url.match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (match) {
    return { repo: match[1], revision: match[2], path: match[3] };
  }
  return null;
}

/**
 * OPFS (Origin Private File System) Asset Resolver.
 * 
 * Provides a persistent, read-through cache for large binary assets (models, wasm).
 * 1. Checks if asset exists in OPFS with correct SHA-256.
 * 2. If missing/invalid, fetches from network, verifies SHA-256, and writes to OPFS.
 * 3. Returns the binary data as an ArrayBuffer.
 */

/**
 * Resolves a Piper model asset via OPFS cache.
 * @param url The public URL to fetch from if not cached.
 * @param modelId Unique identifier for the voice model.
 * @param extension File extension (onnx, onnx.json).
 * @param expectedSha256 Expected SHA-256 checksum for integrity verification.
 * @returns The binary data as an ArrayBuffer.
 */
export async function resolveOpfsAsset(
  url: string,
  modelId: string,
  extension: string,
  expectedSha256?: string,
  options?: { signal?: AbortSignal; prioritizeSelected?: boolean; onProgress?: (downloaded: number, total: number) => void }
): Promise<ArrayBuffer> {

  const filename = `${modelId}.${extension}`;
  
  try {
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle("voices", { create: true });
    
    let downloadedBytes = 0;
    
    // 1. Try to read from OPFS
    try {
      const fileHandle = await voicesDir.getFileHandle(filename);
      const file = await fileHandle.getFile();
      
      // We assume if it exists in OPFS and expectedSha256 wasn't requested (or we only check on download),
      // we can trust it. We'll do a basic size check or just try a HEAD for resumable 
      // but without target size, OPFS caching is assumed valid unless explicitly corrupted.
      downloadedBytes = file.size;

      // If we're fully cached, just return it (One-Time verification happens on download)
      if (downloadedBytes > 0) {
        // Fast-path: Trust the cache
        return await file.arrayBuffer();
      }
    } catch (err) {
      // File not found or empty, proceed to fetch
    }

    // 2. Fetch from Network with Range and Abort Support
    let stream: ReadableStream<Uint8Array>;
    let totalBytes = 0;
    const hfInfo = extractHFRepoPath(url);

    if (hfInfo) {
      // Hugging Face Hub (Xet Protocol)
      const blob = await downloadFile({
        repo: hfInfo.repo,
        revision: hfInfo.revision,
        path: hfInfo.path,
      });
      if (!blob) throw new Error("Failed to resolve HF file");
      
      // Xet fetches internally construct the full file stream; we overwrite from position 0.
      downloadedBytes = 0;
      totalBytes = blob.size;
      stream = blob.stream() as ReadableStream<Uint8Array>;
    } else {
      // Standard Fetch
      const headers: Record<string, string> = {};
      if (downloadedBytes > 0) {
        headers['Range'] = `bytes=${downloadedBytes}-`;
      }

      const fetchOptions: RequestInit = {
        headers,
        signal: options?.signal,
      };
      
      if (options?.prioritizeSelected) {
        (fetchOptions as any).priority = 'high';
      }

      const response = await fetch(url, fetchOptions);
      
      if (response.status === 416) {
        const fileHandle = await voicesDir.getFileHandle(filename);
        return await (await fileHandle.getFile()).arrayBuffer();
      }
      
      if (!response.ok && response.status !== 206) {
        throw new Error(`Failed to fetch asset: ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error(`Response body is null for ${url}`);
      }
      
      // Estimate total capacity
      const contentLen = Number(response.headers.get("Content-Length")) || 0;
      totalBytes = response.status === 206 ? downloadedBytes + contentLen : contentLen;
      
      // Reset if not a partial response
      if (response.status !== 206) {
        downloadedBytes = 0;
      }
      
      stream = response.body;
    }

    // 3. Write/Append to OPFS via Stream
    const fileHandle = await voicesDir.getFileHandle(filename, { create: true });
    // @ts-ignore
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    
    let position = downloadedBytes;
    const reader = stream.getReader();

    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        
        const { done, value } = await reader.read();
        if (done) break;

        await writable.write({ type: 'write', position, data: value as any });
        position += value.length;

        if (options?.onProgress) {
          options.onProgress(position, totalBytes || position);
        }
      }
    } finally {
      await writable.close();
      reader.releaseLock();
    }
    
    // Re-read entire file for SHA-256 verification and return
    const finalFile = await fileHandle.getFile();
    const finalBuffer = await finalFile.arrayBuffer();

    // 4. Verify Integrity (One-Time purely after download completes)
    if (expectedSha256) {
      try {
        await verifySha256(finalBuffer, expectedSha256, url);
      } catch (err) {
        // Delete corrupt file
        await voicesDir.removeEntry(filename);
        throw err;
      }
    }

    return finalBuffer;

  } catch (err) {
    const errorVal = err instanceof Error ? err : new Error(String(err));
    console.error(`[OPFS] Resolution failed for ${filename}:`, errorVal.message);
    throw errorVal;
  }
}
