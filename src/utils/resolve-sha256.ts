/**
 * Cryptographic checksum utility for browser environments.
 * Uses the Web Crypto API to calculate SHA-256 hashes for binary integrity verification.
 */

/**
 * Calculates the SHA-256 hash of an ArrayBuffer.
 * @param buffer The binary data to hash.
 * @returns A hex string representing the SHA-256 hash.
 */
export async function calculateSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies that the buffer matches the expected SHA-256 hash.
 * Throws an error if they do not match.
 */
export async function verifySha256(buffer: ArrayBuffer, expected: string, url: string): Promise<void> {
  const actual = await calculateSha256(buffer);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    console.error(`SHA-256 Mismatch: Expected ${expected}, Got ${actual} for ${url}`);
    throw new Error(`Binary Integrity Verification Failed for ${url}. SHA-256 Mismatch.`);
  }
}
