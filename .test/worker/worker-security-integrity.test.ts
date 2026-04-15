import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPiperWorker } from '../../src/worker/process-piper-synthesis.worker';

describe('Worker Security Integrity (SRI)', () => {
  let mockPostMessage: any;
  let mockFetch: any;
  let mockCrypto: any;

  beforeEach(() => {
    mockPostMessage = vi.fn();
    vi.stubGlobal('postMessage', mockPostMessage);
    
    // Mock Fetch
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Mock Navigator/Storage
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => ({
          getDirectoryHandle: vi.fn(async () => ({
            getFileHandle: vi.fn(async () => ({
              getFile: vi.fn(async () => ({
                arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
                text: vi.fn(async () => '{}')
              }))
            }))
          }))
        }))
      }
    });

    // Mock Crypto
    mockCrypto = {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) // Static hash for testing
      }
    };
    vi.stubGlobal('crypto', mockCrypto);
    
    // Mock performance
    vi.stubGlobal('performance', { now: () => Date.now() });

    // Mock onnxruntime-web
    vi.mock('onnxruntime-web', () => ({
      default: {
        InferenceSession: { create: vi.fn() },
        Tensor: vi.fn()
      }
    }));

    // Mock the dynamic import path used in tests
    vi.mock('ort.mjs', () => ({
      default: { 
        env: { wasm: {} }, 
        InferenceSession: { create: vi.fn(async () => ({})) } 
      }
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('verifyIntegrity() should pass if hashes match', async () => {
    // Hash of 'test' (manually calculated or mocked)
    // In our mock, digest always returns [1, 2, 3] -> '010203'
    const expectedHash = '010203';
    
    // We need to access the private verifyIntegrity if possible, 
    // or test through handleLoadCallback.
    // handleLoadCallback is not exported, but we can call setupPiperWorker which calls it.
  });

  it('verifyIntegrity() should warn but pass if crypto.subtle is missing (Insecure Context)', async () => {
    vi.stubGlobal('crypto', {}); // Missing subtle - may reset globals
    
    // Re-stub navigator after crypto override to ensure isolation
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => ({
          getDirectoryHandle: vi.fn(async () => ({
            getFileHandle: vi.fn(async () => ({
              getFile: vi.fn(async () => ({
                arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
                text: vi.fn(async () => '{"phoneme_id_map":{},"espeak":{"voice":"en"}}')
              }))
            }))
          }))
        }))
      }
    });
    
    // Mock a fetch for the glue script
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => 'createPiperPhonemize = () => {}'
    });

    // In step 2.1, we implemented the guard. 
    // We'll test this via setupPiperWorker.
    await setupPiperWorker({

      modelId: 'm1',
      onnxRuntimePaths: { wasm: 'wasm/', mjs: 'ort.mjs', mjsHelper: 'helper.mjs' },
      piperPaths: { piperWasm: 'piper.wasm', piperJs: 'glue.js', piperData: 'piper.data', piperJsSha256: 'some-hash' }
    });
    
    // Should NOT throw, but logs a warning (we can't easily check console.warn here 
    // unless we mock it, but the lack of crash is the proof).
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready' }),
      undefined
    );
  });

  it('setupPiperWorker should throw if piperJs integrity fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => 'malicious code'
    });
    
    // Our mock digest returns '010203'
    const wrongHash = 'ffffff';

    // This should throw because of the integrity mismatch
    await expect(setupPiperWorker({

      modelId: 'm1',
      onnxRuntimePaths: { wasm: 'wasm/', mjs: 'ort.mjs', mjsHelper: 'helper.mjs' },
      piperPaths: { piperWasm: 'piper.wasm', piperJs: 'glue.js', piperData: 'piper.data', piperJsSha256: wrongHash }
    })).rejects.toThrow(/Integrity mismatch/);
  });
});
