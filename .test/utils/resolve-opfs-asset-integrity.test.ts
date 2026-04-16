import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * OPFS Asset Integrity Tests
 *
 * These tests validate the .meta marker system that prevents partial files
 * from being served as complete. This is the core fix for ERROR_CODE 7
 * (protobuf parsing failed on truncated .onnx files).
 */

// Mock fetch for this test file
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking fetch
import { resolveOpfsAsset } from '../../src/utils/resolve-opfs-asset';
import { verifySha256 } from '../../src/utils/resolve-sha256-browser';

describe('OPFS Asset Integrity (.meta marker)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '100' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(100));
          controller.close();
        }
      })
    });
    vi.clearAllMocks();
  });

  // =========================================================================
  // CRITICAL: Partial file without .meta must trigger network fetch
  // =========================================================================

  it('should NOT return a partial file from OPFS cache without .meta marker verification', async () => {
    /**
     * This is the exact bug that caused ERROR_CODE 7:
     * - A 5MB partial of a 30MB model was stored in OPFS
     * - The code blindly returned it as complete
     * - The worker failed with protobuf parsing error
     *
     * Expected behavior:
     * - Check for .meta marker
     * - If missing, trigger full network fetch
     * - After successful download + SHA verification, write .meta marker
     */

    // Get access to the mock OPFS from setup.ts
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle('voices', { create: true });

    // Pre-populate OPFS with a partial file (5MB of a 30MB model)
    const partialData = new Uint8Array(5 * 1024 * 1024); // 5MB
    const partialFileHandle = await voicesDir.getFileHandle('test-model.onnx', { create: true });
    const writable = await partialFileHandle.createWritable();
    await writable.write(partialData.buffer);
    await writable.close();

    // Verify the partial file exists
    const partialFile = await partialFileHandle.getFile();
    expect(partialFile.size).toBe(5 * 1024 * 1024);

    // NO .meta marker is written — this simulates an interrupted download

    // Mock fetch to return the complete file (30MB)
    const completeData = new Uint8Array(30 * 1024 * 1024); // 30MB
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => (30 * 1024 * 1024).toString() },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(completeData);
          controller.close();
        }
      })
    });

    // Call resolveOpfsAsset with expected SHA-256
    const expectedSha256 = 'abc123def456'; // The expected hash of the complete file

    const result = await resolveOpfsAsset(
      'https://example.com/test-model.onnx',
      'test-model',
      'onnx',
      expectedSha256,
      {}
    );

    // CRITICAL ASSERTION 1: fetch was called (network fetch triggered, not just returning partial)
    expect(mockFetch).toHaveBeenCalled();

    // CRITICAL ASSERTION 2: The result is the complete file, not the partial
    expect(result.byteLength).toBe(30 * 1024 * 1024);

    // CRITICAL ASSERTION 3: .meta marker was written after successful download
    const metaHandle = await voicesDir.getFileHandle('test-model.onnx.meta');
    const metaFile = await metaHandle.getFile();
    const metaContent = await metaFile.text();
    expect(metaContent.trim()).toBe(expectedSha256);
  });

  // =========================================================================
  // Fast-path: .meta marker matches → instant return
  // =========================================================================

  it('should return cached file instantly when .meta marker matches expected SHA-256', async () => {
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle('voices', { create: true });

    // Pre-populate OPFS with a complete file
    const completeData = new Uint8Array(30 * 1024 * 1024);
    const fileHandle = await voicesDir.getFileHandle('cached-model.onnx', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(completeData.buffer);
    await writable.close();

    // Write the .meta marker (simulating a previously verified download)
    const expectedSha256 = 'verified-hash-123';
    const metaHandle = await voicesDir.getFileHandle('cached-model.onnx.meta', { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(expectedSha256);
    await metaWritable.close();

    // Reset fetch mock to ensure it's not called
    mockFetch.mockReset();

    // Call resolveOpfsAsset
    const result = await resolveOpfsAsset(
      'https://example.com/cached-model.onnx',
      'cached-model',
      'onnx',
      expectedSha256,
      {}
    );

    // CRITICAL: fetch should NOT be called (fast-path)
    expect(mockFetch).not.toHaveBeenCalled();

    // Result should be the cached file
    expect(result.byteLength).toBe(30 * 1024 * 1024);
  });

  // =========================================================================
  // Mismatch: .meta marker doesn't match → re-download
  // =========================================================================

  it('should re-download when .meta marker mismatches expected SHA-256', async () => {
    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle('voices', { create: true });

    // Pre-populate OPFS with a file
    const fileData = new Uint8Array(30 * 1024 * 1024);
    const fileHandle = await voicesDir.getFileHandle('mismatch-model.onnx', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(fileData.buffer);
    await writable.close();

    // Write a WRONG .meta marker (simulating corruption or wrong file)
    const wrongSha256 = 'wrong-hash-000';
    const metaHandle = await voicesDir.getFileHandle('mismatch-model.onnx.meta', { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(wrongSha256);
    await metaWritable.close();

    // Mock fetch to return new data
    const newData = new Uint8Array(30 * 1024 * 1024);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => (30 * 1024 * 1024).toString() },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(newData);
          controller.close();
        }
      })
    });

    const expectedSha256 = 'correct-hash-456';

    const result = await resolveOpfsAsset(
      'https://example.com/mismatch-model.onnx',
      'mismatch-model',
      'onnx',
      expectedSha256,
      {}
    );

    // CRITICAL: fetch WAS called (mismatch triggered re-download)
    expect(mockFetch).toHaveBeenCalled();

    // .meta marker should be updated to the correct hash
    const updatedMetaHandle = await voicesDir.getFileHandle('mismatch-model.onnx.meta');
    const updatedMetaFile = await updatedMetaHandle.getFile();
    const updatedMetaContent = await updatedMetaFile.text();
    expect(updatedMetaContent.trim()).toBe(expectedSha256);
  });

  // =========================================================================
  // No SHA-256 provided for non-HF URL → MUST throw error (strict integrity)
  // =========================================================================

  it('should throw an error when no SHA-256 is provided for non-HuggingFace URLs', async () => {
    /**
     * SECURITY: SHA-256 is mandatory for integrity verification.
     * Without it, we cannot verify the downloaded file is correct.
     * This prevents serving partial/corrupted files that cause ERROR_CODE 7.
     *
     * For non-HuggingFace URLs, users must provide the hash manually.
     */

    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle('voices', { create: true });

    // Pre-populate OPFS with a file (could be partial/corrupted)
    const fileData = new Uint8Array(10 * 1024);
    const fileHandle = await voicesDir.getFileHandle('legacy-model.onnx', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(fileData.buffer);
    await writable.close();

    // No .meta marker

    // Call WITHOUT expected SHA-256 for a non-HF URL — should throw
    await expect(
      resolveOpfsAsset(
        'https://example.com/legacy-model.onnx', // Non-HF URL
        'legacy-model',
        'onnx',
        undefined, // No SHA-256 provided — SECURITY VIOLATION
        {}
      )
    ).rejects.toThrow('SHA-256 hash is required for integrity verification');

    // fetch should NOT be called for the model download (error thrown before network request)
    // Note: fetch may have been called for HF API check, but not for the actual file
  });

  // =========================================================================
  // HuggingFace URL without SHA-256 → Auto-fetch from HF API
  // =========================================================================

  it('should auto-fetch SHA-256 from HuggingFace API when not provided', async () => {
    /**
     * CONVENIENCE: For HuggingFace URLs, the library automatically fetches
     * the SHA-256 hash from the HF API (lfs.oid field).
     *
     * This is a strong suggestion for consumers to host models on HuggingFace.
     * Example API: https://huggingface.co/api/models/{repo}/tree/{revision}/{path}
     * Returns: [{ "path": "...", "lfs": { "oid": "sha256-hash" } }]
     */

    const root = await navigator.storage.getDirectory();
    const voicesDir = await root.getDirectoryHandle('voices', { create: true });

    // Mock HF API response
    const hfApiSha256 = '330c232c12b8a08eb241599190f2ee8ccd6072dce323d10e06684fb0cde8a241';
    mockFetch.mockImplementation((url: string) => {
      // HF API call
      if (url.includes('huggingface.co/api/models')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([
            {
              path: 'english/US/male/Bryce/en_US-bryce-medium.onnx',
              lfs: { oid: hfApiSha256 }
            }
          ])
        });
      }
      // Model file download
      if (url.includes('huggingface.co/') && url.includes('/resolve/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => '100' },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(100));
              controller.close();
            }
          })
        });
      }
      return Promise.reject(new Error('Unexpected URL'));
    });

    // Call with HF URL but NO SHA-256 — should auto-fetch from API
    const result = await resolveOpfsAsset(
      'https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/english/US/male/Bryce/en_US-bryce-medium.onnx',
      'bryce-medium',
      'onnx',
      undefined, // No SHA-256 — library will fetch from HF API
      {}
    );

    // CRITICAL: HF API was called to get SHA-256
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('huggingface.co/api/models')
    );

    // .meta marker should be written with the auto-fetched SHA-256
    const metaHandle = await voicesDir.getFileHandle('bryce-medium.onnx.meta');
    const metaFile = await metaHandle.getFile();
    const metaContent = await metaFile.text();
    expect(metaContent.trim()).toBe(hfApiSha256);
  });
});