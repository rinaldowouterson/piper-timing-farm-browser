import type { PendingRequest } from '../types';

/**
 * Creates a FIFO sequencer to ensure synthesis results are resolved 
 * in the same order they were requested, regardless of completion order.
 */
export function createSequencer() {
  let buffer: PendingRequest[] = [];

  const push = (req: PendingRequest) => {
    buffer.push(req);
  };

  const drain = () => {
    while (buffer.length > 0) {
      const head = buffer[0];

      // If the head has a result, resolve it and move to next
      if (head.result) {
        head.resolve(head.result);
        buffer.shift();
      } else {
        // Head is still pending execution/completion, stop draining
        break;
      }
    }
  };

  const find = (requestId: string) => {
    return buffer.find((r) => r.requestId === requestId);
  };

  const remove = (requestId: string) => {
    const idx = buffer.findIndex((r) => r.requestId === requestId);
    if (idx !== -1) {
      buffer.splice(idx, 1);
      // If we removed the head, we might be able to drain others
      if (idx === 0) {
        drain();
      }
    }
  };

  const clear = () => {
    buffer = [];
  };

  return {
    push,
    drain,
    find,
    remove,
    clear,
    get length() {
      return buffer.length;
    }
  };
}
