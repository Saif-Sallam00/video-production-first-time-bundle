import type { TimedToken } from '../align.ts';

/** Everything that decides the audio and its timings. Hashed into the TTS cache key. */
export interface ResolvedVoice {
  preset: string;
  provider: string;
  model_id: string;
  voice_id: string;
  speed: number;
  /** Silence inserted at each beat boundary, seconds (SPEC voice preset `beat_gap_sec`). 0 = none. */
  beatGapSec: number;
  /** How word timings are obtained, e.g. kokoro-durations. */
  alignment: string;
  /** Provider-specific preset settings, e.g. ElevenLabs stability. */
  settings: Record<string, unknown>;
}

export interface TtsProvider {
  /** How this provider's timings are obtained; part of the cache key. */
  alignment: string;
  /**
   * Speaks `text` into a file inside `workDir` (any format FFmpeg reads) and returns timed tokens:
   * characters, words or recognized words. The caller aligns them to the script text.
   */
  synthesize(text: string, voice: ResolvedVoice, workDir: string): Promise<{ audioFile: string; tokens: TimedToken[] }>;
}
