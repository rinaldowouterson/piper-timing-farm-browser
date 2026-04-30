import { vi, beforeEach } from 'vitest';

/**
 * Vitest Global Setup & Mocks
 * 
 * Provides a simulation of the browser environment.
 */

// --- 1. OPFS Mock ---
const mockOpfsFiles = new Map<string, ArrayBuffer>();

const mockFileHandle = (name: string) => ({
    getFile: async () => {
        const buf = mockOpfsFiles.get(name) || new ArrayBuffer(0);
        return {
            size: buf.byteLength,
            arrayBuffer: async () => buf,
            text: async () => new TextDecoder().decode(buf)
        };
    },
    createWritable: async (opts?: { keepExistingData?: boolean }) => {
        // Start with existing data if keepExistingData is true, else empty
        let chunks: { position: number; data: Uint8Array }[] = [];
        let existingData = (opts?.keepExistingData && mockOpfsFiles.has(name))
            ? new Uint8Array(mockOpfsFiles.get(name)!)
            : new Uint8Array(0);
        let closed = false;
        
        const writer = {
            write: async (input: ArrayBuffer | string | { type: string; position: number; data: any }) => {
                if (closed) throw new Error('Writer is closed');
                if (input instanceof ArrayBuffer || typeof input === 'string') {
                    // Simple overwrite (used by writeMetaMarker)
                    const encoded = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
                    existingData = encoded;
                } else if (input && typeof input === 'object' && 'position' in input) {
                    // Positional write (used by stream writer)
                    chunks.push({ position: input.position, data: new Uint8Array(input.data.buffer || input.data) });
                }
            },
            close: async () => {
                closed = true;
                if (chunks.length > 0) {
                    // Calculate total size from existing + new chunks
                    let maxEnd = existingData.length;
                    for (const c of chunks) {
                        maxEnd = Math.max(maxEnd, c.position + c.data.length);
                    }
                    const merged = new Uint8Array(maxEnd);
                    merged.set(existingData);
                    for (const c of chunks) {
                        merged.set(c.data, c.position);
                    }
                    mockOpfsFiles.set(name, merged.buffer);
                } else {
                    // Simple write (meta markers, etc.)
                    mockOpfsFiles.set(name, existingData.buffer);
                }
            },
            abort: async () => { closed = true; }
        };
        
        return {
            write: writer.write,
            close: writer.close,
            // Support both direct write and getWriter() patterns
            getWriter: () => writer
        };
    }
});

const mockDirectoryHandle = {
    getDirectoryHandle: async () => mockDirectoryHandle,
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!mockOpfsFiles.has(name) && !options?.create) throw new Error('File not found');
        return mockFileHandle(name);
    },
    removeEntry: async (name: string) => {
        mockOpfsFiles.delete(name);
    },
    keys: async function* () {
        for (const key of mockOpfsFiles.keys()) yield key;
    }
};

vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    storage: { getDirectory: async () => mockDirectoryHandle }
});

// --- 2. Fetch Mock ---
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({})
}));

// --- 2. Web Worker Mock ---
class MockWorker {
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    instanceId: number = -1;
    modelId: string = '';
    configCounter: number = -1;
    private listeners: Record<string, Set<Function>> = {};

    constructor(public url: string | URL, public options?: WorkerOptions) {}

    addEventListener(type: string, listener: Function) {
        if (!this.listeners[type]) this.listeners[type] = new Set();
        this.listeners[type].add(listener);
    }

    removeEventListener(type: string, listener: Function) {
        if (this.listeners[type]) this.listeners[type].delete(listener);
    }

    dispatchEvent(event: Event): boolean {
        if (event.type === 'error' && this.onerror) {
            this.onerror(event);
        }
        if (this.listeners[event.type]) {
            this.listeners[event.type].forEach(l => l(event));
        }
        return true;
    }

    // Callback module state (for testing worker-thread callbacks)
    private callbackLoaded = false;

    postMessage(msg: any) {
        if (msg.type === 'init') {
            this.instanceId = msg.config.instanceId;
            this.modelId = msg.config.modelId;
            this.configCounter = msg.configCounter;
            // Track if sovereign callback was enabled
            this.callbackLoaded = !!msg.config.useCallback;
            // Always respond to init to avoid deadlocks
            setTimeout(() => this.emit('message', { type: 'ready', instanceId: this.instanceId, configCounter: this.configCounter }), 10);
        }
        if (msg.type === 'load-callback') {
            // Handle explicit callback loading toggle
            this.callbackLoaded = !!msg.useCallback;
            this.configCounter = msg.configCounter;
            const resType = this.callbackLoaded ? 'callback-on' : 'callback-off';
            setTimeout(() => this.emit('message', { type: resType, instanceId: this.instanceId, configCounter: this.configCounter }), 10);
        }
        if (msg.type === 'synthesize') {
            // FIX: Correctly pass the instanceId so the orchestrator can free the worker
            // Include callbackResult if callback module was loaded
            const callbackResult = this.callbackLoaded ? {
                phonemeCount: 5,
                durationCount: 5,
                audioSampleCount: 100,
                success: true
            } : undefined;
            
            setTimeout(() => this.emit('message', { 
                type: 'success', 
                instanceId: this.instanceId,
                requestId: msg.requestId, 
                result: { 
                    audioData: new Float32Array(100), 
                    sampleRate: 22050, 
                    durationMs: 1000,
                    metadata: { 
                        modelId: this.modelId, 
                        speakerId: msg.speakerId ?? 0,
                        requestId: msg.requestId,
                        phonemes: ['h', 'e', 'l', 'l', 'o'],
                        durations: new Float32Array([50, 100, 50, 50, 100])
                    }
                },
                callbackResult
            }), 20);
        }
    }

    terminate() {}

    private emit(type: string, data: any) {
        const event = { data };
        if (type === 'message' && this.onmessage) this.onmessage(event as any);
        if (this.listeners[type]) {
            this.listeners[type].forEach(l => l(event));
        }
    }
}

vi.stubGlobal('Worker', MockWorker);

// --- 3. SHA-256 Mock ---
vi.mock('../src/utils/resolve-sha256', () => ({
    verifySha256: vi.fn().mockResolvedValue(true)
}));

// --- 4. Hugging Face Hub Mock ---
vi.mock('@huggingface/hub', () => ({
    downloadFile: vi.fn().mockResolvedValue({
        size: 100,
        stream: () => new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(100));
                controller.close();
            }
        })
    })
}));

// --- 6. Persistence Cleanup ---
beforeEach(() => {
    mockOpfsFiles.clear();
    vi.clearAllMocks();
});

// Suppress console.error during tests globally to keep output clean,
// since testing error states intentionally triggers expected errors.
// Note: We assign it directly because local test `errorSpy.mockRestore()` 
// would otherwise restore it to the loud original function.
console.error = vi.fn();
