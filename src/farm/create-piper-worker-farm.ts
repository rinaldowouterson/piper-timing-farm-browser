import type { 
  PiperWorkerFarm, 
  AudioSynthesisResult, 
  FarmConfig, 
  PendingRequest, 
  WorkerState 
} from '../types';
import { createSequencer } from './resolve-sequencer';
import { createWorkerPool } from './control-worker-pool';

/**
 * Creates the high-level Piper worker farm.
 */
export function createPiperWorkerFarm(): PiperWorkerFarm {
  const sequencer = createSequencer();
  let initErrors: string[] = [];

  const handleWorkerMessage = (state: WorkerState, msg: any) => {
    switch (msg.type) {
      case "ready":
        state.busy = false;
        pool.processQueue();
        break;

      case "success":
        state.busy = false;
        handleSuccess(msg.requestId, msg.result, msg.callbackResult);
        pool.processQueue();
        break;

      case "error":
        state.busy = false;
        const reqId = msg.requestId;
        handleError(reqId, msg.error);
        pool.processQueue();
        break;
    }
  };

  const pool = createWorkerPool(handleWorkerMessage);

  const handleSuccess = (requestId: string, result: AudioSynthesisResult, callbackResult: any) => {
    const req = sequencer.find(requestId);
    if (!req) return;

    req.result = { ...result, callbackResult };
    sequencer.drain();
  };

  const handleError = (requestId: string | undefined, error: string) => {
    if (!requestId) {
      initErrors.push(error);
      return;
    }

    const req = sequencer.find(requestId);
    if (req) {
      req.reject(new Error(error));
      sequencer.remove(requestId);
    }
  };

  const init = async (config: FarmConfig) => {
    initErrors = [];
    await pool.init(config);
    if (initErrors.length > 0) {
      throw new Error(`Worker initialization failed: ${initErrors.join(", ")}`);
    }
  };

  const synthesize = (
    text: string,
    options: { speed?: number; pitch?: number; volume?: number } = {}
  ): Promise<AudioSynthesisResult & { callbackResult?: any }> => {
    const requestId = `req-${Math.random().toString(36).slice(2, 11)}`;
    const speed = options.speed ?? 1.0;
    const pitch = options.pitch ?? 1.0;
    const volume = options.volume ?? 1.0;

    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        requestId,
        text,
        speed,
        pitch,
        volume,
        resolve,
        reject
      };

      sequencer.push(request);
      pool.enqueue(request);
    });
  };

  const terminate = () => {
    pool.terminate();
    sequencer.clear();
  };

  return {
    init,
    synthesize,
    terminate,
    get metrics() {
      return pool.metrics;
    }
  };
}
