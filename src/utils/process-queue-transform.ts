import type { PendingRequest, SynthesizeOptions } from "../types";

/**
 * Constraints for queue transformation, primarily focused on 
 * model-specific limits like the number of supported speakers.
 */
export interface TransformationConstraints {
  numSpeakers: number;
}

/**
 * Unified engine for transforming the pending request queue.
 * Handles both manual parameter updates (speed, volume, speakerId) 
 * and automatic constraint enforcement (speakerId validation) 
 * during model transitions.
 * 
 * Logic:
 * 1. Iterates over the provided requests.
 * 2. Merges speed and volume from options if provided.
 * 3. Updates speakerId if provided, then validates it against constraints.
 * 4. Requests currently being processed (active) should be excluded 
 *    before calling this function to prevent state desync.
 * 
 * @param requests - The subset of the queue to transform (usually inactive items).
 * @param options - Partial options to apply (speed, volume, speakerId).
 * @param constraints - Environmental constraints (e.g., speaker limits of the active model).
 */
export function transformPendingQueue(
  requests: PendingRequest[],
  options: Partial<SynthesizeOptions>,
  constraints: TransformationConstraints
): void {
  const { numSpeakers } = constraints;

  for (const req of requests) {
    // 1. Apply manual parameter updates
    if (options.speed !== undefined) {
      req.speed = options.speed;
    }
    
    if (options.volume !== undefined) {
      req.volume = options.volume;
    }

    if (options.speakerId !== undefined) {
      req.speakerId = options.speakerId;
    }

    // 2. Enforce Double-Gated Validation (Speaker ID)
    // If a request's speakerId (whether just updated or pre-existing) 
    // is out of bounds for the current model, it is reset to 0.
    if (req.speakerId < 0 || req.speakerId >= numSpeakers) {
      req.speakerId = 0;
    }
  }
}
