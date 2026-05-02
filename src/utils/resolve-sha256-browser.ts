import type { HashInput } from "../types";

/**
 * Cryptographic checksum utility for browser environments.
 */

/**
 * Main SHA-256 entry point.
 * Uses native crypto.subtle (always available in Secure Contexts).
 * 
 * @param input - The data to hash (string, ArrayBuffer, or Uint8Array).
 * @returns A hex string representing the SHA-256 hash.
 */
export async function calculateSha256(input: HashInput): Promise<string> {
  return calculateSha256CryptoSubtle(input);
}

/**
 * Calculates SHA-256 hash using the Web Crypto API.
 * Requires a Secure Context (HTTPS or localhost).
 */
export async function calculateSha256CryptoSubtle(input: HashInput): Promise<string> {
  let buffer: BufferSource;
  if (typeof input === 'string') {
    buffer = new TextEncoder().encode(input);
  } else {
    buffer = input as any;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies that the input matches the expected SHA-256 hash.
 * Throws an error if they do not match.
 * 
 * @param input - The data to verify.
 * @param expected - The expected SHA-256 hash (hex string).
 * @param url - Optional URL for error message context.
 */
export async function verifySha256(input: HashInput, expected: string, url?: string): Promise<void> {
  const actual = await calculateSha256(input);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    const errorMsg = `[Integrity] Mismatch for ${url || 'unknown'}\n  Expected: ${expected}\n  Actual:   ${actual}\n  Method:   Native (Web Crypto)`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
}
