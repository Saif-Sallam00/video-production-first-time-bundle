import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { TimedToken } from '../align.ts';
import type { TtsProvider } from './provider.ts';

export const KOKORO_MODEL = 'hexgrad/Kokoro-82M';

/** American English male voices shipped with Kokoro-82M v1.0 (the model's VOICES.md). */
export const KOKORO_AMERICAN_MALE_VOICES = [
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
];

export interface KokoroJob {
  text: string;
  voice: string;
  speed: number;
  /** Absolute path of the WAV to write. */
  out: string;
}

/**
 * Runs tts/kokoro_tts.py in the uv-managed env under tts/ (`uv run` creates it from uv.lock on first
 * use). One process renders every job, so the model loads once.
 */
export function runKokoro(root: string, modelId: string, jobs: KokoroJob[]): Promise<{ tokens: TimedToken[] }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'uv',
      ['run', '--quiet', '--frozen', '--project', join(root, 'tts'), 'python', join(root, 'tts/kokoro_tts.py')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new Error(`could not run uv (needed for Kokoro): ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`kokoro exited with ${code}: ${stderr.trim().slice(-800)}`));
      resolve(JSON.parse(stdout).results);
    });
    child.stdin.end(JSON.stringify({ model_id: modelId, jobs }));
  });
}

/** Default provider: Kokoro-82M on the CPU, with word timings from the model's duration predictor. */
export function kokoroProvider(root: string): TtsProvider {
  return {
    alignment: 'kokoro-durations',
    async synthesize(text, voice, workDir) {
      const audioFile = join(workDir, 'kokoro.wav');
      const [result] = await runKokoro(root, voice.model_id, [
        { text, voice: voice.voice_id, speed: voice.speed, out: audioFile },
      ]);
      return { audioFile, tokens: result.tokens };
    },
  };
}
