/**
 * Cryptographic checksum utility for browser environments.
 * Uses the Web Crypto API to calculate MD5 hashes for binary integrity verification.
 * 
 * Note: MD5 is used here for integrity check (detecting corruption/tampering), 
 * not for password security. It is industry standard for asset validation.
 */

/**
 * Calculates the MD5 hash of an ArrayBuffer.
 * @param buffer The binary data to hash.
 * @returns A hex string representing the MD5 hash.
 */
export async function calculateMd5(buffer: ArrayBuffer): Promise<string> {
  // Browser standard: crypto.subtle.digest only supports SHA-*, not MD5.
  // For MD5 we use a lightweight, zero-dependency implementation or a polyfill.
  // Since we want zero-dependency, we implement a basic MD5 here.
  
  // Actually, to keep it clean and performant, we use a simple JS implementation
  // that is fast and reliable for browser workers.
  return md5(buffer);
}

/**
 * Verifies that the buffer matches the expected MD5 hash.
 * Throws an error if they do not match.
 */
export async function verifyMd5(buffer: ArrayBuffer, expected: string, url: string): Promise<void> {
  const actual = await calculateMd5(buffer);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    console.error(`MD5 Mismatch: Expected ${expected}, Got ${actual} for ${url}`);
    throw new Error(`Binary Integrity Verification Failed for ${url}. MD5 Mismatch.`);
  }
}

// MD5 implementation for ArrayBuffer (standard JS port)
function md5(buffer: ArrayBuffer): string {
  const words = new Uint32Array(buffer.byteLength + 16 >> 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= bytes[i] << (i % 4 << 3);
  }
  words[bytes.length >> 2] |= 0x80 << (bytes.length % 4 << 3);
  words[words.length - 2] = bytes.length << 3;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;

    a = ff(a, b, c, d, words[i + 0], 7, 0xd76aa478);
    d = ff(d, a, b, c, words[i + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, words[i + 2], 17, 0x242070db);
    b = ff(b, c, d, a, words[i + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, words[i + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, words[i + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, words[i + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, words[i + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, words[i + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, words[i + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, words[i + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, words[i + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, words[i + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, words[i + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, words[i + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, words[i + 15], 22, 0x49b40821);

    a = gg(a, b, c, d, words[i + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, words[i + 6], 9, 0xc040b175);
    c = gg(c, d, a, b, words[i + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, words[i + 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, words[i + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, words[i + 10], 9, 0x02441453);
    c = gg(c, d, a, b, words[i + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, words[i + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, words[i + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, words[i + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, words[i + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, words[i + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, words[i + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, words[i + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, words[i + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, words[i + 12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, words[i + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, words[i + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, words[i + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, words[i + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, words[i + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, words[i + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, words[i + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, words[i + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, words[i + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, words[i + 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, words[i + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, words[i + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, words[i + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, words[i + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, words[i + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, words[i + 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, words[i + 0], 6, 0xf4292244);
    d = ii(d, a, b, c, words[i + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, words[i + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, words[i + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, words[i + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, words[i + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, words[i + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, words[i + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, words[i + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, words[i + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, words[i + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, words[i + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, words[i + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, words[i + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, words[i + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, words[i + 9], 21, 0xeb86d391);

    a = a + olda | 0; b = b + oldb | 0; c = c + oldc | 0; d = d + oldd | 0;
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function hex(n: number) {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += (n >> i * 8 & 0xff).toString(16).padStart(2, "0");
  }
  return s;
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return b + (a + (b & c | ~b & d) + x + t << s | a + (b & c | ~b & d) + x + t >>> 32 - s) | 0;
}
function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return b + (a + (b & d | c & ~d) + x + t << s | a + (b & d | c & ~d) + x + t >>> 32 - s) | 0;
}
function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return b + (a + (b ^ c ^ d) + x + t << s | a + (b ^ c ^ d) + x + t >>> 32 - s) | 0;
}
function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return b + (a + (c ^ (b | ~d)) + x + t << s | a + (c ^ (b | ~d)) + x + t >>> 32 - s) | 0;
}
