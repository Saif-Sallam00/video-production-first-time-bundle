import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsProvider } from './provider.ts';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const OUTPUT_FORMAT = 'mp3_44100_128';

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Optional paid provider: ElevenLabs text-to-speech with timestamps. Timings are per character,
 * which the aligner turns into words (first character's start, last character's end).
 */
export function elevenLabsProvider(opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): TtsProvider {
  return {
    alignment: 'elevenlabs-characters',
    async synthesize(text, voice, workDir) {
      const env = opts.env ?? process.env;
      const apiKey = env.ELEVENLABS_API_KEY;
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set (put it in .env)');
      const base = env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL;
      const url = `${base}/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
      const res = await (opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: voice.model_id,
          voice_settings: { ...voice.settings, speed: voice.speed },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ElevenLabs returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { audio_base64: string; alignment: Alignment | null };
      if (!body.alignment) throw new Error('ElevenLabs returned no alignment');
      const audioFile = join(workDir, 'elevenlabs.mp3');
      writeFileSync(audioFile, Buffer.from(body.audio_base64, 'base64'));
      const a = body.alignment;
      return {
        audioFile,
        tokens: a.characters.map((c, i) => ({
          text: c,
          start: a.character_start_times_seconds[i],
          end: a.character_end_times_seconds[i],
        })),
      };
    },
  };
}
