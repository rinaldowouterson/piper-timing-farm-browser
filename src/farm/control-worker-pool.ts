import type { 
  WorkerState, 
  FarmConfig, 
  PiperWorkerMessageIn, 
  PendingRequest 
} from '../types';

/**
 * Manages a pool of Web Workers for Piper synthesis.
 */
export function createWorkerPool(
  onMessage: (state: WorkerState, msg: any) => void
) {
  let workers: WorkerState[] = [];
  let queue: PendingRequest[] = [];

  const spawnWorker = (config: FarmConfig, device: "cpu" | "webgpu", id: number) => {
    // Relative to the index file in dev, or handled by bundler in production
    const worker = new Worker(new URL("../worker/process-piper-synthesis.worker.ts", import.meta.url), {
      type: "module"
    });

    const state: WorkerState = { id, worker, type: device, busy: true };
    workers.push(state);

    worker.onmessage = (e: MessageEvent<any>) => {
      onMessage(state, e.data);
    };

    const initMsg: PiperWorkerMessageIn = {
      type: "init",
      config: {
        voiceId: config.voiceId,
        modelId: config.modelId,
        wasmPaths: config.wasmPaths,
        device,
        instanceId: id,
        callbackModule: config.callbackModule
      }
    };
    worker.postMessage(initMsg);
  };

  const init = async (config: FarmConfig): Promise<void> => {
    // Spawn configured number of CPU and WebGPU instances
    for (let i = 0; i < config.cpuInstances; i++) {
      spawnWorker(config, "cpu", i);
    }

    for (let i = 0; i < config.webgpuInstances; i++) {
      spawnWorker(config, "webgpu", config.cpuInstances + i);
    }

    // Wait for all workers to signal "ready" or wait for a timeout
    return new Promise((resolve) => {
      const check = () => {
        if (workers.every((w) => !w.busy)) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  };

  const processQueue = () => {
    const idleWorkers = workers.filter((w) => !w.busy);
    if (idleWorkers.length === 0 || queue.length === 0) return;

    while (idleWorkers.length > 0 && queue.length > 0) {
      const worker = idleWorkers.pop()!;
      const req = queue.shift()!;

      worker.busy = true;

      const msg: PiperWorkerMessageIn = {
        type: "synthesize",
        text: req.text,
        requestId: req.requestId,
        speed: req.speed,
        pitch: req.pitch,
        volume: req.volume
      };

      worker.worker.postMessage(msg);
    }
  };

  const enqueue = (req: PendingRequest) => {
    queue.push(req);
    processQueue();
  };

  const terminate = () => {
    for (const state of workers) {
      state.worker.terminate();
    }
    workers = [];
    queue = [];
  };

  return {
    init,
    enqueue,
    terminate,
    processQueue,
    get metrics() {
      return {
        queueLength: queue.length,
        busyWorkers: workers.filter((w) => w.busy).length,
        totalWorkers: workers.length
      };
    }
  };
}
