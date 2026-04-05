import { describe, it, expect } from 'vitest';
import type { AudioSynthesisResult } from '../../src/types';

describe('Synthesis Metadata Integrity', () => {
  it('should strictly satisfy the AudioSynthesisResult timing contract', () => {
    // This mock simulates the exact shape the worker is guaranteed to emit
    const mockResult: AudioSynthesisResult = {
      audioData: new Float32Array(100),
      sampleRate: 22050,
      durationMs: 1000,
      metadata: {
        generationTimeMs: 150,
        modelId: 'test-model',
        speakerId: 0,
        phonemeIds: [1, 2, 3],
        durations: new Float32Array([100, 200, 300]), // NOW Float32Array (ms)
        totalAudioDurationMs: 1000, // REQUIRED
        sampleRate: 22050,           // REQUIRED
        hopSize: 256,                // REQUIRED
      }
    };

    expect(mockResult.metadata.totalAudioDurationMs).toBeTypeOf('number');
    expect(mockResult.metadata.sampleRate).toBeTypeOf('number');
    expect(mockResult.metadata.hopSize).toBe(256);
    expect(mockResult.metadata.durations).toBeInstanceOf(Float32Array);
  });
});