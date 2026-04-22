import type { DownloadState, DownloadController } from "../types";

/**
 * Internal entry for tracking a download in the registry.
 * Each entry represents a single model's download lifecycle.
 */
interface DownloadEntry {
  file: DownloadState;
  controller: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  /** Reject the download promise. Accepts unknown to match catch clause semantics. */
  reject: (e: unknown) => void;
  urls: { onnx: string; config: string };
  expectedSha256?: { onnx?: string; config?: string };
  options?: { onProgress?: (file: DownloadState) => void };
}

/**
 * Stateful Download Controller for model assets.
 * 
 * Sovereign Gateway Architecture:
 * - All downloads route through `/piper-gate/voices/*` Service Worker gateway
 * - Service Worker handles: fetch → verify SHA-256 → write to OPFS → return
 * - Progress reporting via BroadcastChannel from Service Worker
 * - Browser propagates AbortSignal to Service Worker automatically
 * 
 * Uses a Registry (Map) for state tracking and a Queue (Array) for FIFO sequencing.
 */
export function createAssetDownloadController(): DownloadController {
  const registry = new Map<string, DownloadEntry>();
  const queue: string[] = [];
  let activeId: string | null = null;

  // ---------------------------------------------------------------------------
  // BroadcastChannel: Bridge from Service Worker to callbacks
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to progress messages from Service Worker.
   * The SW broadcasts progress during download; we dispatch to callbacks.
   * 
   * Timing: Subscription happens immediately when controller is created
   * (inside createAssetDownloadController, not lazy).
   */
  const progressChannel = new BroadcastChannel('piper-download-progress');

  progressChannel.onmessage = (event) => {
    const { type, filename, downloaded, total } = event.data;
    
    if (type === 'progress') {
      // Registry lookup: find the download entry for this model
      const modelId = filename.replace(/\.(onnx|onnx\.json)$/, '');
      const entry = registry.get(modelId);
      
      // Invoke callback if entry exists and has onProgress
      if (entry?.options?.onProgress) {
        entry.file.bytesDownloaded = downloaded;
        entry.file.bytesTotal = total;
        entry.file.progress = total > 0 ? downloaded / total : 0;
        entry.options.onProgress({ ...entry.file });
      }
    } else if (type === 'complete') {
      // Mark download as complete in registry
      const modelId = filename.replace(/\.(onnx|onnx\.json)$/, '');
      const entry = registry.get(modelId);
      if (entry) {
        entry.file.status = 'complete';
        entry.file.progress = 1.0;
      }
    } else if (type === 'error') {
      // Handle Generalized Error Broadcasts from Service Worker
      const { filename, message, code, stack } = event.data;
      const modelId = filename.replace(/\.(onnx|onnx\.json)$/, '');
      const entry = registry.get(modelId);
      
      if (entry) {
        entry.file.status = 'error';
        entry.file.error = `${code}: ${message}`;
        
        // Wrap the error with full diagnostic info
        const swError = new Error(message);
        (swError as any).code = code;
        (swError as any).stack = stack;
        (swError as any).filename = filename;
        
        entry.reject(swError);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // OPFS Cleanup (for cancel/clear operations)
  // ---------------------------------------------------------------------------

  async function purgeOpfs(modelId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const voicesDir = await root.getDirectoryHandle("voices");
      // Clean up all files for this model
      for (const ext of ["onnx", "onnx.json"]) {
        try {
          await voicesDir.removeEntry(`${modelId}.${ext}`);
        } catch { /* ignore if not exists */ }
      }
    } catch { /* ignore root handle failures */ }
  }

  // ---------------------------------------------------------------------------
  // Download Execution: fetch via /piper-gate/ gateway
  // ---------------------------------------------------------------------------

  async function executeDownload(modelId: string, entry: DownloadEntry): Promise<void> {
    entry.file.status = "downloading";

    try {
      // The Service Worker intercepts these fetch calls and handles:
      // 1. Check OPFS cache → verify SHA-256 → return if valid
      // 2. If missing/corrupted: fetch from source → verify → write to OPFS → return
      // 
      // We pass SHA-256 and custom URLs via headers for non-registered models.
      const headers: HeadersInit = {
        'x-piper-cache-download': 'true'
      };

      if (entry.expectedSha256?.onnx) {
        headers['x-piper-sha256-onnx'] = entry.expectedSha256.onnx;
      }
      if (entry.expectedSha256?.config) {
        headers['x-piper-sha256-config'] = entry.expectedSha256.config;
      }
      // For custom URLs (not in registry), pass the source URL
      if (!entry.urls.onnx.startsWith('https://huggingface.co/rinaldow/')) {
        headers['x-piper-url-onnx'] = entry.urls.onnx;
      }
      if (!entry.urls.config.startsWith('https://huggingface.co/rinaldow/')) {
        headers['x-piper-url-config'] = entry.urls.config;
      }

      // Download config first
      const configResponse = await fetch(`/piper-gate/voices/${modelId}.onnx.json`, {
        signal: entry.controller.signal,
        headers,
      });

      if (!configResponse.ok && configResponse.status !== 204) {
        throw new Error(`Config download failed: ${configResponse.status} ${configResponse.statusText}`);
      }

      if (entry.controller.signal.aborted) return;

      // Download ONNX model second
      const onnxResponse = await fetch(`/piper-gate/voices/${modelId}.onnx`, {
        signal: entry.controller.signal,
        headers,
      });

      if (!onnxResponse.ok && onnxResponse.status !== 204) {
        throw new Error(`Model download failed: ${onnxResponse.status} ${onnxResponse.statusText}`);
      }

      if (!entry.controller.signal.aborted) {
        entry.file.status = "complete";
        entry.file.progress = 1.0;
        entry.resolve();
      }
    } catch (err) {
      if (entry.controller.signal.aborted) {
        return; // Silent exit on abort (cancel handles rejections)
      }
      
      entry.file.status = "error";
      entry.file.error = err instanceof Error ? err.message : String(err);
      
      // Clean up partial files on any error to ensure a clean slate for retries
      await purgeOpfs(modelId);
      
      entry.reject(err);
    }
  }

  async function processQueue(): Promise<void> {
    // If something is already downloading or nothing is in queue, idle
    if (activeId || queue.length === 0) return;

    activeId = queue.shift()!;
    const entry = registry.get(activeId);
    
    // Safety check: if entry was deleted from registry while in queue
    if (!entry) {
      activeId = null;
      return processQueue();
    }

    try {
      await executeDownload(activeId, entry);
    } finally {
      activeId = null;
      processQueue(); // Chain to the next in line
    }
  }

  return {
    request(modelId, urls, expectedSha256, options) {
      const existing = registry.get(modelId);
      
      // Return existing promise if already and not in a terminal failure state
      if (existing && (
        existing.file.status === "complete" || 
        existing.file.status === "pending" || 
        existing.file.status === "downloading"
      )) {
        return existing.promise;
      }
      
      // If error or doesn't exist, create a fresh entry
      // This allows retry of failed downloads by just calling request() again
      const file: DownloadState = {
        modelId,
        status: "pending",
        bytesDownloaded: 0,
        bytesTotal: 0,
        progress: 0,
      };

      // Promise executor runs synchronously, so these are assigned before use.
      // The definite assignment assertion (!) is safe here.
      let resolveFunc!: () => void;
      let rejectFunc!: (e: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolveFunc = resolve;
        rejectFunc = reject;
      });

      const entry: DownloadEntry = {
        file,
        controller: new AbortController(),
        promise,
        resolve: resolveFunc,
        reject: rejectFunc,
        urls,
        expectedSha256,
        options,
      };

      registry.set(modelId, entry);
      
      // Add to sequence if it's not already in it
      if (!queue.includes(modelId)) {
        queue.push(modelId);
      }

      processQueue(); // Attempt to start
      return promise;
    },

    async cancel(modelId) {
      const entry = registry.get(modelId);
      if (!entry) return;

      // 1. Abort the logic (safe even if pending or already completed)
      entry.controller.abort();
      
      // 2. Reject the promise so listeners aren't suspended indefinitely
      const wasActive = entry.file.status === "pending" || entry.file.status === "downloading";
      if (wasActive) {
        entry.reject(new Error("Cancelled"));
      }

      // 3. Remove from sequencing queue if it hasn't started yet
      const idx = queue.indexOf(modelId);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }

      // 4. Wipe from registry and clean up OPFS
      registry.delete(modelId);
      await purgeOpfs(modelId);

      // 5. If this was the active download, force the queue to move on
      if (activeId === modelId) {
        activeId = null;
        processQueue();
      }
    },

    async cancelAll() {
      // Clear queue so nothing new starts
      queue.length = 0;

      const results: Promise<void>[] = [];
      for (const [id, entry] of registry) {
        // Abort and reject if it was in-flight or waiting
        entry.controller.abort();
        if (entry.file.status === "pending" || entry.file.status === "downloading") {
          entry.reject(new Error("CancelledAll"));
        }
        results.push(purgeOpfs(id));
      }

      registry.clear();
      activeId = null;
      await Promise.all(results);
    },

    getState() {
      const snapshot = new Map<string, DownloadState>();
      for (const [id, entry] of registry) {
        snapshot.set(id, { ...entry.file });
      }
      return snapshot;
    },

    async clearAndRedownloadModel(modelId) {
      const existing = registry.get(modelId);
      if (!existing) return;

      const { urls, expectedSha256, options } = existing;

      // 1. Fully cancel the previous entry
      await this.cancel(modelId);

      // 2. Re-request from scratch (this will add to registry and queue)
      return this.request(modelId, urls, expectedSha256, options);
    },
    
    destroy() {
      progressChannel.close();
    },
  };
}
