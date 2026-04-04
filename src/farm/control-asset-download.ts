import type { DownloadState, DownloadController } from "../types";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";

/**
 * Stateful Download Controller for model assets.
 *
 * Manages the lifecycle of model downloads with:
 * - Deduplication: same modelId returns existing promise
 * - Prioritization: pause others, fast-track the selected model
 * - Cancellation: abort + purge OPFS partial files
 * - Observability: getState() returns full snapshot per model
 */
export function createAssetDownloadController(): DownloadController {
  const downloads = new Map<string, {
    state: DownloadState;
    controller: AbortController;
    promise: Promise<void>;
    urls: { onnx: string; config: string };
    expectedSha256?: { onnx?: string; config?: string };
    options?: { prioritizeSelected?: boolean };
  }>();

  /** Internal: execute a single model download (both .onnx and .onnx.json). */
  async function executeDownload(
    modelId: string,
    urls: { onnx: string; config: string },
    controller: AbortController,
    state: DownloadState,
    expectedSha256?: { onnx?: string; config?: string },
    options?: { prioritizeSelected?: boolean }
  ): Promise<void> {
    state.state = 'downloading';

    try {
      // Download both files. Config first (small), then model (large).
      await resolveOpfsAsset(
        urls.config,
        modelId,
        "onnx.json",
        expectedSha256?.config,
        { signal: controller.signal, prioritizeSelected: options?.prioritizeSelected }
      );

      // Check abort between downloads
      if (controller.signal.aborted) return;

      await resolveOpfsAsset(
        urls.onnx,
        modelId,
        "onnx",
        expectedSha256?.onnx,
        { signal: controller.signal, prioritizeSelected: options?.prioritizeSelected }
      );

      if (!controller.signal.aborted) {
        state.state = 'complete';
        state.progress = 1.0;
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // State already set by cancel() or prioritize()
        return;
      }
      state.state = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Internal: purge OPFS files for a model. */
  async function purgeOpfs(modelId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const voicesDir = await root.getDirectoryHandle("voices");

      for (const ext of ["onnx", "onnx.json"]) {
        try {
          await voicesDir.removeEntry(`${modelId}.${ext}`);
        } catch {
          // NotFoundError or similar — idempotent
        }
      }
    } catch {
      // voices dir doesn't exist — nothing to clean
    }
  }

  /** Internal: resume any paused downloads in LIFO order. */
  function resumePaused(): void {
    const paused = [...downloads.entries()]
      .filter(([, d]) => d.state.state === 'paused')
      .reverse(); // LIFO: most recently requested first

    for (const [modelId, entry] of paused) {
      const newController = new AbortController();
      entry.controller = newController;
      entry.promise = executeDownload(
        modelId,
        entry.urls,
        newController,
        entry.state,
        entry.expectedSha256,
        entry.options
      ).catch(() => {
        // Error state already set inside executeDownload
      });
    }
  }

  return {
    request(
      modelId: string, 
      urls: { onnx: string; config: string }, 
      expectedSha256?: { onnx?: string; config?: string },
      options?: { prioritizeSelected?: boolean }
    ): Promise<void> {
      const existing = downloads.get(modelId);
      if (existing && existing.state.state !== 'cancelled' && existing.state.state !== 'error') {
        return existing.promise;
      }
      
      const state: DownloadState = {
        modelId,
        state: 'queued',
        bytesDownloaded: 0,
        bytesTotal: 0,
        progress: 0
      };

      const controller = new AbortController();
      const promise = executeDownload(modelId, urls, controller, state, expectedSha256, options);
      
      downloads.set(modelId, { state, controller, promise, urls, expectedSha256, options });
      return promise;
    },

    prioritize(modelId) {
      // Pause all other active downloads
      for (const [id, entry] of downloads) {
        if (id !== modelId && entry.state.state === 'downloading') {
          entry.controller.abort();
          entry.state.state = 'paused';
        }
      }

      // Start or resume the prioritized one
      const entry = downloads.get(modelId);
      if (entry && (entry.state.state === 'paused' || entry.state.state === 'queued')) {
        const newController = new AbortController();
        entry.controller = newController;
        entry.promise = executeDownload(
          modelId,
          entry.urls,
          newController,
          entry.state,
          entry.expectedSha256
        ).then(() => {
          // After prioritized completes, resume paused downloads
          resumePaused();
        }).catch(() => {
          // Error state already set
        });
      }
    },

    async cancel(modelId) {
      const entry = downloads.get(modelId);
      if (!entry) return;

      entry.controller.abort();
      entry.state.state = 'cancelled';

      // Purge OPFS partial files
      await purgeOpfs(modelId);
    },

    async cancelAll() {
      const cancelPromises: Promise<void>[] = [];

      for (const [modelId, entry] of downloads) {
        if (entry.state.state === 'downloading' || entry.state.state === 'paused' || entry.state.state === 'queued') {
          entry.controller.abort();
          entry.state.state = 'cancelled';
          cancelPromises.push(purgeOpfs(modelId));
        }
      }

      await Promise.all(cancelPromises);
    },

    getState() {
      const snapshot = new Map<string, DownloadState>();
      for (const [id, entry] of downloads) {
        snapshot.set(id, { ...entry.state });
      }
      return snapshot;
    }
  };
}
