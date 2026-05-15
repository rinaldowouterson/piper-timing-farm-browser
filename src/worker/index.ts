export { setupPiperWorker, processPiperSynthesis } from "./process-piper-synthesis.worker";

/**
 * Helper to collect all Transferable objects from a result.
 * Supports ArrayBuffer, Uint8Array, Float32Array, and nested objects.
 */
export function collectTransferables(val: unknown): Transferable[] {
  const result: Transferable[] = [];
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(obj: any) {
    if (!obj) return;
    if (obj instanceof ArrayBuffer) {
      result.push(obj);
    } else if (ArrayBuffer.isView(obj)) {
      result.push(obj.buffer);
    } else if (typeof obj === 'object') {
      for (const key in obj) {
        walk(obj[key]);
      }
    }
  }
  
  walk(val);
  return result;
}
