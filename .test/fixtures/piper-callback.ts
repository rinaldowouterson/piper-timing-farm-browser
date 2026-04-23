/**
 * Test fixture: Worker-thread callback module
 * 
 * This simulates a user-defined callback that runs inside the worker
 * after synthesis completes. Used to test the callbackModule feature.
 */
export function onSynthesisComplete(result: {
  audioData: Float32Array;
  sampleRate: number;
  durationMs: number;
  metadata?: {
    phonemes?: string[];
    durations?: Float32Array;
    speakerId?: number;
    modelId?: string;
  };
}): {
  phonemeCount: number;
  durationCount: number;
  audioSampleCount: number;
  success: boolean;
} {
  const { audioData, sampleRate, metadata } = result;
  
  // Return metadata back to main thread
  // TypedArrays in the return object will be automatically transferred
  return {
    phonemeCount: metadata?.phonemes?.length || 0,
    durationCount: metadata?.durations?.length || 0,
    audioSampleCount: audioData.length,
    success: true
  };
}