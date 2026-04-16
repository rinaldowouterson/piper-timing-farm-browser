import { verifySha256 } from "./resolve-sha256-browser";
import { downloadFile } from "@huggingface/hub";

function extractHFRepoPath(url: string): { repo: string; path: string; revision: string } | null {
  const match = url.match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (match) {
    return { repo: match[1], revision: match[2], path: match[3] };
  }
  return null;
}

/**
 * Fetches SHA-256 hash from HuggingFace API for a given file.
 * The HF API returns file metadata including lfs.oid (SHA-256 hash).
 * 
 * @param repo - Repository path (e.g., "rinaldow/piper-onnx-durations")
 * @param revision - Branch/revision (e.g., "main")
 * @param filePath - File path within repo (e.g., "english/US/male/Bryce/en_US-bryce-medium.onnx")
 * @returns SHA-256 hash string, or null if not found
 */
async function fetchHFSha256(
  repo: string,
  revision: string,
  filePath: string
): Promise<string | null> {
  try {
    // Get the directory path (remove filename)
    const pathParts = filePath.split('/');
    const filename = pathParts.pop() || '';
    const dirPath = pathParts.join('/');
    
    // Construct API URL
    const apiUrl = `https://huggingface.co/api/models/${repo}/tree/${revision}/${dirPath}`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) return null;
    
    const files: Array<{ path: string; lfs?: { oid: string } }> = await response.json();
    
    // Find the file and extract lfs.oid (SHA-256)
    const fileMeta = files.find(f => f.path === filePath || f.path.endsWith(filename));
    if (fileMeta?.lfs?.oid) {
      return fileMeta.lfs.oid;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads a `.meta` marker file from OPFS.
 * Returns the stored SHA-256 string, or null if not found.
 */
async function readMetaMarker(
  voicesDir: FileSystemDirectoryHandle,
  filename: string
): Promise<string | null> {
  try {
    const handle = await voicesDir.getFileHandle(`${filename}.meta`);
    const file = await handle.getFile();
    const text = await file.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Writes a `.meta` marker file containing the verified SHA-256 hash.
 * This marks the corresponding asset as integrity-verified.
 */
async function writeMetaMarker(
  voicesDir: FileSystemDirectoryHandle,
  filename: string,
  sha256: string
): Promise<void> {
  const handle = await voicesDir.getFileHandle(`${filename}.meta`, { create: true });
  // @ts-ignore — createWritable is available in OPFS contexts
  const writable = await handle.createWritable();
  await writable.write(sha256);
  await writable.close();
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
  options?: { signal?: AbortSignal; onProgress?: (downloaded: number, total: number) => void }
): Promise<ArrayBuffer> {

  const filename = `${modelId}.${extension}`;
  const hfInfo = extractHFRepoPath(url);
  
  try {
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle("voices", { create: true });
    
    try {
      const fileHandle = await voicesDir.getFileHandle(filename);
      const file = await fileHandle.getFile();

      if (file.size > 0 && expectedSha256) {
        // Check .meta marker — if it matches, the file was previously verified
        const verifiedHash = await readMetaMarker(voicesDir, filename);
        if (verifiedHash === expectedSha256.toLowerCase()) {
          console.log(`[OPFS] Resident asset verified: ${filename}`);
          return await file.arrayBuffer();
        }
        // .meta missing or mismatch — file may be partial/corrupt.
        // Fall through to clean download.
      }
    } catch {
      // File not found or empty, proceed to fetch
    }

    // SECURITY: SHA-256 is mandatory for integrity verification.
    // If not provided, attempt to fetch from HuggingFace API for HF URLs.
    if (!expectedSha256 && hfInfo) {
      const fetchedSha256 = await fetchHFSha256(hfInfo.repo, hfInfo.revision, hfInfo.path);
      if (fetchedSha256) {
        expectedSha256 = fetchedSha256;
      }
    }
    
    // If still no SHA-256, we cannot safely verify the download.
    if (!expectedSha256) {
      throw new Error(
        `SHA-256 hash is required for integrity verification of "${filename}". ` +
        `Provide the expectedSha256 parameter. ` +
        `For HuggingFace models, the hash is automatically fetched from the API.`
      );
    }

    // 2. Fetch from Network
    let stream: ReadableStream<Uint8Array>;
    let totalBytes = 0;

    if (hfInfo) {
      // Hugging Face Hub (Xet Protocol)
      const blob = await downloadFile({
        repo: hfInfo.repo,
        revision: hfInfo.revision,
        path: hfInfo.path,
      });
      if (!blob) throw new Error("Failed to resolve HF file");
      
      totalBytes = blob.size;
      stream = blob.stream() as ReadableStream<Uint8Array>;
    } else {
      // Standard Fetch
      const response = await fetch(url, { signal: options?.signal });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch asset: ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error(`Response body is null for ${url}`);
      }
      
      totalBytes = Number(response.headers.get("Content-Length")) || 0;
      stream = response.body;
    }

    // 3. Download to RAM First (Atomic Buffer)
    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    let lastProgressTime = 0;
    const reader = stream.getReader();

    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        downloadedBytes += value.length;

        // Throttled UI Updates: at most every 100ms to prevent main-thread saturation
        const now = Date.now();
        const throttleTime = 100;
        if (options?.onProgress && (now - lastProgressTime > throttleTime || done)) {
          options.onProgress(downloadedBytes, totalBytes || downloadedBytes);
          lastProgressTime = now;
        }
      }
    } finally {
      reader.releaseLock();
    }
    
    // Concatenate chunks into a single ArrayBuffer efficiently
    const finalBuffer = await new Blob(chunks as BlobPart[]).arrayBuffer();

    // 4. Verify Integrity in RAM BEFORE writing to disk
    await verifySha256(finalBuffer, expectedSha256!, url);
    console.log(`[OPFS] Downloaded asset verified: ${filename}`);

    // 5. Atomic Persistence — Write to OPFS only after verification passes
    const fileHandle = await voicesDir.getFileHandle(filename, { create: true });
    // @ts-ignore
    const writable = await fileHandle.createWritable();
    
    try {
      await writable.write(finalBuffer);
    } finally {
      await writable.close();
    }
    
    // Mark as verified
    await writeMetaMarker(voicesDir, filename, expectedSha256!.toLowerCase());

    return finalBuffer;

  } catch (err) {
    const errorVal = err instanceof Error ? err : new Error(String(err));
    console.error(`[OPFS] Resolution failed for ${filename}:`, errorVal.message);
    throw errorVal;
  }
}
