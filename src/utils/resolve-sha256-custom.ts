import { HashInput } from '../types';

/**
 * Strictly SHA-256 implementation refactored for modern TypeScript.
 * Uses functional closures for state management (Stateless Logic Mandate).
 * 
 * Based on js-sha256 by Chen, Yi-Cyuan.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const EXTRA = new Int32Array([-2147483648, 8388608, 32768, 128]);
const SHIFT = new Uint8Array([24, 16, 8, 0]);
const HEX_CHARS = '0123456789abcdef'.split('');

/**
 * Calculates SHA-256 hash using the JS fallback implementation.
 */
export function calculateSha256Custom(message: HashInput): string {
  const hasher = createSha256();
  hasher.update(message);
  return hasher.hex();
}

/**
 * Internal SHA-256 state closure.
 */
function createSha256() {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  const blocks = new Uint32Array(64);
  let blockState = 0;
  let startOffset = 0;
  let totalBytes = 0;
  let hBytes = 0;
  let finalized = false;
  let hashed = false;
  let firstRun = true;
  let lastByteIdx = 0;

  function hashBlock() {
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], h_v = h[7];
    let s0: number, s1: number, maj: number, t1: number, t2: number, ch: number, ab: number, da: number, cd: number, bc: number;

    for (let j = 16; j < 64; ++j) {
      t1 = blocks[j - 15];
      s0 = ((t1 >>> 7) | (t1 << 25)) ^ ((t1 >>> 18) | (t1 << 14)) ^ (t1 >>> 3);
      t1 = blocks[j - 2];
      s1 = ((t1 >>> 17) | (t1 << 15)) ^ ((t1 >>> 19) | (t1 << 13)) ^ (t1 >>> 10);
      blocks[j] = (blocks[j - 16] + s0 + blocks[j - 7] + s1) | 0;
    }

    bc = b & c;
    for (let j = 0; j < 64; j += 4) {
      if (firstRun) {
        ab = 704751109;
        t1 = (blocks[0] - 210244248) | 0;
        h_v = (t1 - 1521486534) | 0;
        d = (t1 + 143694565) | 0;
        firstRun = false;
      } else {
        s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        ab = a & b;
        maj = ab ^ (a & c) ^ bc;
        ch = (e & f) ^ (~e & g);
        t1 = (h_v + s1 + ch + K[j] + blocks[j]) | 0;
        t2 = (s0 + maj) | 0;
        h_v = (d + t1) | 0;
        d = (t1 + t2) | 0;
      }
      s0 = ((d >>> 2) | (d << 30)) ^ ((d >>> 13) | (d << 19)) ^ ((d >>> 22) | (d << 10));
      s1 = ((h_v >>> 6) | (h_v << 26)) ^ ((h_v >>> 11) | (h_v << 21)) ^ ((h_v >>> 25) | (h_v << 7));
      da = d & a;
      maj = da ^ (d & b) ^ ab;
      ch = (h_v & e) ^ (~h_v & f);
      t1 = (g + s1 + ch + K[j + 1] + blocks[j + 1]) | 0;
      t2 = (s0 + maj) | 0;
      g = (c + t1) | 0;
      c = (t1 + t2) | 0;
      s0 = ((c >>> 2) | (c << 30)) ^ ((c >>> 13) | (c << 19)) ^ ((c >>> 22) | (c << 10));
      s1 = ((g >>> 6) | (g << 26)) ^ ((g >>> 11) | (g << 21)) ^ ((g >>> 25) | (g << 7));
      cd = c & d;
      maj = cd ^ (c & a) ^ da;
      ch = (g & h_v) ^ (~g & e);
      t1 = (f + s1 + ch + K[j + 2] + blocks[j + 2]) | 0;
      t2 = (s0 + maj) | 0;
      f = (b + t1) | 0;
      b = (t1 + t2) | 0;
      s0 = ((b >>> 2) | (b << 30)) ^ ((b >>> 13) | (b << 19)) ^ ((b >>> 22) | (b << 10));
      s1 = ((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7));
      bc = b & c;
      maj = bc ^ (b & d) ^ cd;
      ch = (f & g) ^ (~f & h_v);
      t1 = (e + s1 + ch + K[j + 3] + blocks[j + 3]) | 0;
      t2 = (s0 + maj) | 0;
      e = (a + t1) | 0;
      a = (t1 + t2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + h_v) | 0;
  }

  function update(message: HashInput) {
    if (finalized) return;
    
    let processedMessage: Uint8Array | string;
    if (message instanceof Uint8Array) {
      processedMessage = message;
    } else if (message instanceof ArrayBuffer || (typeof message === 'object' && message !== null && 'byteLength' in message)) {
      processedMessage = new Uint8Array(message as ArrayBuffer);
    } else {
      processedMessage = message as string;
    }

    const isString = typeof processedMessage === 'string';
    let index = 0;
    const length = processedMessage.length;

    while (index < length) {
      if (hashed) {
        hashed = false;
        blocks[0] = blockState;
        for (let i = 1; i < 64; i++) blocks[i] = 0;
      }

      let i = startOffset;
      if (!isString) {
        const msgArr = processedMessage as Uint8Array;
        for (; index < length && i < 64; ++index) {
          blocks[i >>> 2] |= msgArr[index] << SHIFT[i++ & 3];
        }
      } else {
        const msgStr = processedMessage as string;
        for (; index < length && i < 64; ++index) {
          let code = msgStr.charCodeAt(index);
          if (code < 0x80) {
            blocks[i >>> 2] |= code << SHIFT[i++ & 3];
          } else if (code < 0x800) {
            blocks[i >>> 2] |= (0xc0 | (code >>> 6)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
          } else if (code < 0xd800 || code >= 0xe000) {
            blocks[i >>> 2] |= (0xe0 | (code >>> 12)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | ((code >>> 6) & 0x3f)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
          } else {
            code = 0x10000 + (((code & 0x3ff) << 10) | (msgStr.charCodeAt(++index) & 0x3ff));
            blocks[i >>> 2] |= (0xf0 | (code >>> 18)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | ((code >>> 12) & 0x3f)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | ((code >>> 6) & 0x3f)) << SHIFT[i++ & 3];
            blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
          }
        }
      }

      lastByteIdx = i;
      totalBytes += i - startOffset;
      if (i >= 64) {
        blockState = blocks[16];
        startOffset = i - 64;
        hashBlock();
        hashed = true;
      } else {
        startOffset = i;
      }
    }

    if (totalBytes > 4294967295) {
      hBytes += (totalBytes / 4294967296) | 0;
      totalBytes = totalBytes % 4294967296;
    }
  }

  function finalize() {
    if (finalized) return;
    finalized = true;

    const i = lastByteIdx;
    blocks[16] = blockState;
    blocks[i >>> 2] |= EXTRA[i & 3] as number;
    blockState = blocks[16];

    if (i >= 56) {
      if (!hashed) hashBlock();
      blocks[0] = blockState;
      for (let j = 1; j < 64; j++) blocks[j] = 0;
    }

    blocks[14] = (hBytes << 3) | (totalBytes >>> 29);
    blocks[15] = (totalBytes << 3);
    hashBlock();
  }

  function hex() {
    finalize();
    let res = '';
    for (let i = 0; i < 8; i++) {
        const val = h[i];
        res += HEX_CHARS[(val >>> 28) & 0x0F] + HEX_CHARS[(val >>> 24) & 0x0F] +
               HEX_CHARS[(val >>> 20) & 0x0F] + HEX_CHARS[(val >>> 16) & 0x0F] +
               HEX_CHARS[(val >>> 12) & 0x0F] + HEX_CHARS[(val >>> 8)  & 0x0F] +
               HEX_CHARS[(val >>> 4)  & 0x0F] + HEX_CHARS[val        & 0x0F];
    }
    return res;
  }

  return { update, hex };
}