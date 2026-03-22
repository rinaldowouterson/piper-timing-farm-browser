/**
 * Recursively collects all ArrayBuffers from an object.
 * Used for zero-copy transfer of Float32Arrays between worker and main thread.
 */
export function collectTransferables(obj: unknown): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];

  if (obj instanceof ArrayBuffer) {
    buffers.push(obj);
  } else if (ArrayBuffer.isView(obj)) {
    buffers.push(obj.buffer);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      buffers.push(...collectTransferables(item));
    }
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      buffers.push(...collectTransferables(value));
    }
  }

  return buffers;
}
