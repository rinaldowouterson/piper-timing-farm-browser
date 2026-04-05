import { vi, beforeEach } from 'vitest';

/**
 * Vitest Global Setup & Mocks
 * 
 * Provides a simulation of the browser environment.
 */

// --- 1. OPFS Mock ---
const mockOpfsFiles = new Map<string, ArrayBuffer>();

const mockFileHandle = (name: string) => ({
    getFile: async () => ({
        arrayBuffer: async () => mockOpfsFiles.get(name) || new ArrayBuffer(0),
        text: async () => new TextDecoder().decode(mockOpfsFiles.get(name) || new Uint8Array())
    }),
    createWritable: async () => {
        let buffer: ArrayBuffer;
        return {
            write: async (data: ArrayBuffer) => { buffer = data; },
            close: async () => { mockOpfsFiles.set(name, buffer); }
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
            // Track if callback module was configured
            this.callbackLoaded = !!msg.config.callbackModule;
            // Always respond to init to avoid deadlocks
            setTimeout(() => this.emit('message', { type: 'ready', instanceId: this.instanceId }), 10);
        }
        if (msg.type === 'load-callback') {
            // Handle explicit callback loading message
            this.callbackLoaded = true;
            setTimeout(() => this.emit('message', { type: 'callback-loaded', instanceId: this.instanceId }), 10);
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

// --- 4. Persistence Cleanup ---
beforeEach(() => {
    mockOpfsFiles.clear();
    vi.clearAllMocks();
});
