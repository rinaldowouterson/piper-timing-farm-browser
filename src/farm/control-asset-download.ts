import type { DownloadState, DownloadController } from "../types";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";

/**
 * Internal entry for tracking a download in the registry.
 * Each entry represents a single model's download lifecycle.
 */
interface DownloadEntry {
  state: DownloadState;
  controller: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  /** Reject the download promise. Accepts unknown to match catch clause semantics. */
  reject: (e: unknown) => void;
  urls: { onnx: string; config: string };
  expectedSha256?: { onnx?: string; config?: string };
  options?: { onProgress?: (state: DownloadState) => void };
}

/**
 * Stateful Download Controller for model assets.
 * Uses a Registry (Map) for state tracking and a Queue (Array) for FIFO sequencing.
 */
export function createAssetDownloadController(): DownloadController {
  const registry = new Map<string, DownloadEntry>();
  const queue: string[] = [];
  let activeId: string | null = null;

  async function purgeOpfs(modelId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const voicesDir = await root.getDirectoryHandle("voices");
      // Clean up all possible markers and files for this model
      for (const ext of ["onnx", "onnx.json", "onnx.meta", "onnx.json.meta"]) {
        try {
          await voicesDir.removeEntry(`${modelId}.${ext}`);
        } catch { /* ignore if not exists */ }
      }
    } catch { /* ignore root handle failures */ }
  }

  async function executeDownload(modelId: string, entry: DownloadEntry): Promise<void> {
    entry.state.state = "downloading";

    try {
      const onProgress = (downloaded: number, total: number) => {
        entry.state.bytesDownloaded = downloaded;
        entry.state.bytesTotal = total;
        entry.state.progress = total > 0 ? downloaded / total : 0;
        entry.options?.onProgress?.({ ...entry.state });
      };

      // Download config first
      await resolveOpfsAsset(
        entry.urls.config,
        modelId,
        "onnx.json",
        entry.expectedSha256?.config,
        { signal: entry.controller.signal, onProgress }
      );

      if (entry.controller.signal.aborted) return;

      // Download ONNX model second
      await resolveOpfsAsset(
        entry.urls.onnx,
        modelId,
        "onnx",
        entry.expectedSha256?.onnx,
        { signal: entry.controller.signal, onProgress }
      );

      if (!entry.controller.signal.aborted) {
        entry.state.state = "complete";
        entry.state.progress = 1.0;
        entry.resolve();
      }
    } catch (err) {
      if (entry.controller.signal.aborted) {
        return; // Silent exit on abort (cancel handles rejections)
      }
      
      entry.state.state = "error";
      entry.state.error = err instanceof Error ? err.message : String(err);
      
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
        existing.state.state === "complete" || 
        existing.state.state === "pending" || 
        existing.state.state === "downloading"
      )) {
        return existing.promise;
      }
      
      // If error or doesn't exist, create a fresh entry
      // This allows retry of failed downloads by just calling request() again
      const state: DownloadState = {
        modelId,
        state: "pending",
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
        state,
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
      const wasActive = entry.state.state === "pending" || entry.state.state === "downloading";
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
        if (entry.state.state === "pending" || entry.state.state === "downloading") {
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
        snapshot.set(id, { ...entry.state });
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
  };
}
