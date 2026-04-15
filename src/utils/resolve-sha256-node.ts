import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Cryptographic utility for Node.js environments.
 * Protocol: Resolve / HC (SHA-256) / LC (Node).
 */

/**
 * Calculates the SHA-256 hash of a file on disk.
 * @param filePath Absolute or relative path to the file.
 * @returns Hex string of the SHA-256 hash.
 */
export function calculateFileSha256(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Sidecar Hash Structure for Piper Timing Farm.
 */
export interface SidecarHash {
  sha256: string;
  generatedAt: number;
}

/**
 * Generates or updates a sidecar .json hash file next to the target file.
 * @param filePath Path to the target file.
 * @returns The generated SidecarHash object.
 */
export function generateSidecarHash(filePath: string): SidecarHash {
  const hash = calculateFileSha256(filePath);
  const sidecar: SidecarHash = {
    sha256: hash,
    generatedAt: Date.now()
  };
  
  const sidecarPath = `${filePath}.json`;
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  
  return sidecar;
}
