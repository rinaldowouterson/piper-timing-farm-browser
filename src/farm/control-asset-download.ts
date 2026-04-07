import type { DownloadState, DownloadController } from "../types";
import { resolveOpfsAsset } from "../utils/resolve-opfs-asset";

/**
 * Stateful Download Controller for model assets.
 */
export function createAssetDownloadController(): DownloadController {
  const downloads = new Map<string, {
    state: DownloadState;
    controller: AbortController;
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: any) => void;
    urls: { onnx: string; config: string };
    expectedSha256?: { onnx?: string; config?: string };
    options?: { prioritizeSelected?: boolean; onProgress?: (state: DownloadState) => void };
  }>();

  async function executeDownload(
    modelId: string,
    urls: { onnx: string; config: string },
    controller: AbortController,
    state: DownloadState,
    expectedSha256?: { onnx?: string; config?: string },
    options?: { prioritizeSelected?: boolean; onProgress?: (state: DownloadState) => void }
  ): Promise<void> {
    state.state = 'downloading';

    try {
      const onProgress = (downloaded: number, total: number) => {
        state.bytesDownloaded = downloaded;
        state.bytesTotal = total;
        state.progress = total > 0 ? downloaded / total : 0;
        options?.onProgress?.({ ...state });
      };

      await resolveOpfsAsset(
        urls.config,
        modelId,
        "onnx.json",
        expectedSha256?.config,
        { signal: controller.signal, prioritizeSelected: options?.prioritizeSelected, onProgress }
      );

      if (controller.signal.aborted) return;

      await resolveOpfsAsset(
        urls.onnx,
        modelId,
        "onnx",
        expectedSha256?.onnx,
        { signal: controller.signal, prioritizeSelected: options?.prioritizeSelected, onProgress }
      );

      if (!controller.signal.aborted) {
        state.state = 'complete';
        state.progress = 1.0;
        const entry = downloads.get(modelId);
        if (entry) entry.resolve();
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      state.state = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      const entry = downloads.get(modelId);
      if (entry) entry.reject(err);
    }
  }

  async function purgeOpfs(modelId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const voicesDir = await root.getDirectoryHandle("voices");

      for (const ext of ["onnx", "onnx.json", "onnx.meta", "onnx.json.meta"]) {
        try {
          await voicesDir.removeEntry(`${modelId}.${ext}`);
        } catch {}
      }
    } catch {}
  }

  function resumeNextPaused(): void {
    const next = [...downloads.entries()]
      .find(([, d]) => d.state.state === 'paused');

    if (!next) return;
    const [modelId, entry] = next;

    entry.controller = new AbortController();
    executeDownload(
      modelId,
      entry.urls,
      entry.controller,
      entry.state,
      entry.expectedSha256,
      entry.options
    ).finally(() => {
      // Chain: when this one finishes (success, error, or abort), try the next
      resumeNextPaused();
    });
  }

  const api: DownloadController = {
    request(
      modelId: string, 
      urls: { onnx: string; config: string }, 
      expectedSha256?: { onnx?: string; config?: string },
      options?: { prioritizeSelected?: boolean; onProgress?: (state: DownloadState) => void }
    ): Promise<void> {
      const existing = downloads.get(modelId);
      if (existing && existing.state.state !== 'cancelled' && existing.state.state !== 'error') {
        return existing.promise;
      }
      
      const state: DownloadState = {
        modelId, state: 'queued', bytesDownloaded: 0, bytesTotal: 0, progress: 0
      };

      let resolveFunc!: () => void;
      let rejectFunc!: (e: any) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolveFunc = resolve;
        rejectFunc = reject;
      });

      const controller = new AbortController();
      downloads.set(modelId, { 
        state, controller, promise, resolve: resolveFunc, reject: rejectFunc, 
        urls, expectedSha256, options 
      });

      executeDownload(modelId, urls, controller, state, expectedSha256, options);
      return promise;
    },

    prioritize(modelId) {
      for (const [id, entry] of downloads) {
        if (id !== modelId && entry.state.state === 'downloading') {
          entry.controller.abort();
          entry.state.state = 'paused';
        }
      }

      const entry = downloads.get(modelId);
      if (entry && (entry.state.state === 'paused' || entry.state.state === 'queued')) {
        entry.controller = new AbortController();
        executeDownload(
          modelId, entry.urls, entry.controller, entry.state, entry.expectedSha256, entry.options
        ).finally(() => {
          resumeNextPaused();
        });
      } else if (entry && entry.state.state === 'downloading') {
        // Already active — attach resumption chain to the existing promise
        // so paused tasks resume when this download finishes.
        // .catch suppresses the rejection here — the consumer already handles it.
        entry.promise.finally(() => {
          resumeNextPaused();
        }).catch(() => {});
      } else if (entry && entry.state.state === 'complete') {
        // Already done — immediately resume any tasks we just paused
        resumeNextPaused();
      }
    },

    async cancel(modelId) {
      const entry = downloads.get(modelId);
      if (!entry) return;

      entry.controller.abort();
      const wasActive = entry.state.state === 'downloading' || entry.state.state === 'paused' || entry.state.state === 'queued';
      entry.state.state = 'cancelled';
      if (wasActive) entry.reject(new Error("Cancelled"));
      await purgeOpfs(modelId);
    },

    async cancelAll() {
      const cancelPromises: Promise<void>[] = [];

      for (const [modelId, entry] of downloads) {
        if (entry.state.state === 'downloading' || entry.state.state === 'paused' || entry.state.state === 'queued') {
          entry.controller.abort();
          entry.state.state = 'cancelled';
          entry.reject(new Error("Cancelled"));
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
    },

    async clearAndRedownloadModel(modelId) {
      const entry = downloads.get(modelId);
      if (!entry) return;

      const { urls, expectedSha256, options } = entry;

      // Abort any active download for this model
      entry.controller.abort();
      entry.state.state = 'cancelled';
      
      // Reject the original promise so it doesn't hang forever
      // The consumer's .catch() will handle this gracefully
      entry.reject(new Error('Download cleared for redownload'));

      // Purge OPFS files (model + config + .meta markers)
      await purgeOpfs(modelId);

      // Remove stale entry so request() treats this as fresh
      downloads.delete(modelId);

      // Re-request from scratch
      return api.request(modelId, urls, expectedSha256, options);
    }
  };

  return api;
}
