import { calculateSha256Custom } from "./resolve-sha256-custom";
import type { HashInput } from "../types";

/**
 * Cryptographic checksum utility for browser environments.
 * Orchestrates between native Web Crypto API and custom JS fallback.
 */

/**
 * Main SHA-256 entry point.
 * Uses native crypto.subtle if available (Secure Contexts),
 * otherwise falls back to calculateSha256Custom.
 * 
 * @param input - The data to hash (string, ArrayBuffer, or Uint8Array).
 * @returns A hex string representing the SHA-256 hash.
 */
export async function calculateSha256(input: HashInput): Promise<string> {
  if (globalThis.crypto?.subtle) {
    return calculateSha256CryptoSubtle(input);
  }
  return calculateSha256Custom(input);
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
 */
export async function verifySha256(input: HashInput, expected: string, url: string): Promise<void> {
  const actual = await calculateSha256(input);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    const method = globalThis.crypto?.subtle ? 'Native (Web Crypto)' : 'Custom (JS Fallback)';
    const errorMsg = `[Integrity] Mismatch for ${url}\n  Expected: ${expected}\n  Actual:   ${actual}\n  Method:   ${method}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
}
