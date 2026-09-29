import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { alignToScript, type WordTiming } from './align.ts';
import { fullVo } from './lint.ts';
import { elevenLabsProvider } from './tts/elevenlabs.ts';
import { KOKORO_AMERICAN_MALE_VOICES, KOKORO_MODEL, kokoroProvider, runKokoro } from './tts/kokoro.ts';
import type { ResolvedVoice, TtsProvider } from './tts/provider.ts';
import type { VideoSpec } from './types.ts';

const DEFAULT_PRESET = 'james-default'; // schema default for voice.preset
const LEADING_SILENCE_MAX_SEC = 0.15;
const SILENCE_THRESHOLD = '-50dB';

/** A preset in config/voice.json: provider, model_id, voice_id, speed, plus provider-specific settings. */
export interface VoicePreset {
  provider: string;
  model_id: string;
  voice_id: string;
  speed: number;
  /** Silence inserted at each beat boundary, seconds. Default 0 (SPEC section 5). */
  beat_gap_sec?: number;
  [setting: string]: unknown;
}

export interface VoiceConfig {
  presets: Record<string, VoicePreset>;
  pronunciations: Record<string, string>;
}

/** cache/tts/<key>/alignment.json: the one timing format every provider ends up in. */
export interface CachedAlignment {
  text: string;
  voice: ResolvedVoice;
  words: WordTiming[];
  duration_sec: number;
  leading_silence_trimmed_sec: number;
}

export type Providers = Record<string, TtsProvider>;

export const defaultProviders = (root: string): Providers => ({
  kokoro: kokoroProvider(root),
  elevenlabs: elevenLabsProvider(),
});

export function loadVoiceConfig(root: string): VoiceConfig {
  const { pronunciations = {}, ...presets } = JSON.parse(readFileSync(join(root, 'config/voice.json'), 'utf8'));
  return { presets, pronunciations };
}

export function resolveVoice(spec: VideoSpec, config: VoiceConfig, providers: Providers): ResolvedVoice {
  const name = spec.voice?.preset ?? DEFAULT_PRESET;
  const p = Object.hasOwn(config.presets, name) ? config.presets[name] : undefined;
  if (!p) throw new Error(`voice preset "${name}" is not in config/voice.json`);
  const provider = Object.hasOwn(providers, p.provider) ? providers[p.provider] : undefined;
  if (!provider) throw new Error(`voice preset "${name}" uses unknown provider "${p.provider}"`);
  const { provider: _, model_id, voice_id, speed, beat_gap_sec, ...settings } = p;
  return {
    preset: name,
    provider: p.provider,
    model_id,
    voice_id,
    speed: spec.voice?.speed ?? speed,
    beatGapSec: beat_gap_sec ?? 0,
    alignment: provider.alignment,
    settings,
  };
}

/** Whole-word, case-insensitive replacement; punctuation attached to the word is kept. */
export function spokenText(text: string, pronunciations: Record<string, string>): string {
  const map = new Map(Object.entries(pronunciations).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\S+/g, (token) => {
    const [, lead, core, trail] = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)!;
    const spoken = map.get(core.toLowerCase());
    return spoken === undefined ? token : lead + spoken + trail;
  });
}

export function ttsCacheKey(text: string, voice: ResolvedVoice): string {
  return createHash('sha256').update(text).update('\n').update(JSON.stringify(voice)).digest('hex');
}

/** The index of each beat's first spoken (post-pronunciation) word, so `applyBeatGaps` can find beat
 * boundaries in the same continuous take that `voice.ts`/`timeline.ts` align against. */
function spokenBeatStarts(spec: VideoSpec, pronunciations: Record<string, string>): number[] {
  const starts: number[] = [];
  let spokenIndex = 0;
  for (const beat of spec.beats) {
    starts.push(spokenIndex);
    for (const original of beat.vo.split(/\s+/).filter(Boolean)) {
      spokenIndex += Math.max(1, spokenText(original, pronunciations).split(/\s+/).filter(Boolean).length);
    }
  }
  return starts;
}

/**
 * Splices `gapSec` of silence into `input` at each time in `boundaries` (cut points in the ORIGINAL,
 * unshifted audio), writing the result to `output`.
 */
function spliceSilence(input: string, output: string, boundaries: number[], gapSec: number) {
  const probe = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', input],
    { encoding: 'utf8' },
  ).trim();
  const [sampleRate, channels] = probe.split(',');
  const channelLayout = channels === '1' ? 'mono' : 'stereo';

  const parts: string[] = [];
  const labels: string[] = [];
  let prev = 0;
  boundaries.forEach((t, i) => {
    parts.push(`[0:a]atrim=${prev}:${t},asetpts=PTS-STARTPTS[a${i}]`, `[1:a]atrim=0:${gapSec},asetpts=PTS-STARTPTS[g${i}]`);
    labels.push(`[a${i}]`, `[g${i}]`);
    prev = t;
  });
  parts.push(`[0:a]atrim=${prev},asetpts=PTS-STARTPTS[aEnd]`);
  labels.push('[aEnd]');
  const filter = `${parts.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`;

  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-i', input,
    '-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=${channelLayout}`,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    output,
  ]);
}

/**
 * Inserts `gapSec` of silence into `audioFile` at each beat boundary and shifts every word timing
 * after a boundary by the cumulative gap so far. Prosody stays continuous — only the pacing between
 * beats changes, since the TTS take itself was already produced over the whole (ungapped) VO
 * (SPEC section 5). A no-op when `gapSec` is 0 or there's only one beat.
 */
function applyBeatGaps(
  spec: VideoSpec,
  pronunciations: Record<string, string>,
  audioFile: string,
  words: WordTiming[],
  durationSecs: number,
  gapSec: number,
): { audioFile: string; words: WordTiming[]; durationSec: number } {
  if (gapSec <= 0 || spec.beats.length < 2) return { audioFile, words, durationSec: durationSecs };
  const boundaryTimes = spokenBeatStarts(spec, pronunciations)
    .slice(1)
    .map((i) => words[i].start);
  const gapped = join(dirname(audioFile), 'gapped.wav');
  spliceSilence(audioFile, gapped, boundaryTimes, gapSec);
  const shifted = words.map((w) => {
    const n = boundaryTimes.filter((t) => t <= w.start).length;
    return { ...w, start: +(w.start + n * gapSec).toFixed(6), end: +(w.end + n * gapSec).toFixed(6) };
  });
  return { audioFile: gapped, words: shifted, durationSec: durationSecs + gapSec * boundaryTimes.length };
}

export interface VoiceResult {
  key: string;
  dir: string;
  cached: boolean;
  text: string;
  voice: ResolvedVoice;
  trimmedSec: number;
}

/** SPEC `studio voice`: audio + word timings into cache/tts/<key>/, skipping the provider on a cache hit. */
export async function synthesize(
  spec: VideoSpec,
  opts: { root: string; providers?: Providers },
): Promise<VoiceResult> {
  const providers = opts.providers ?? defaultProviders(opts.root);
  const config = loadVoiceConfig(opts.root);
  const voice = resolveVoice(spec, config, providers);
  const text = spokenText(fullVo(spec), config.pronunciations);
  const key = ttsCacheKey(text, voice);
  const dir = join(opts.root, 'cache/tts', key);
  const alignmentFile = join(dir, 'alignment.json');

  if (existsSync(join(dir, 'audio.wav')) && existsSync(alignmentFile)) {
    const cached = JSON.parse(readFileSync(alignmentFile, 'utf8')) as CachedAlignment;
    return { key, dir, cached: true, text, voice, trimmedSec: cached.leading_silence_trimmed_sec };
  }

  // Build the entry in a temp dir and rename, so an interrupted or failed run never leaves a half
  // entry that looks like a hit.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const { audioFile, tokens } = await providers[voice.provider].synthesize(text, voice, tmp);
    const lead = leadingSilenceSec(audioFile);
    const trimmedSec = lead > LEADING_SILENCE_MAX_SEC ? lead : 0;
    const audio = join(tmp, 'audio.wav');
    toWav(audioFile, audio, trimmedSec);
    rmSync(audioFile);
    const duration = durationSec(audio);
    const shift = (t: number | null) => (t === null ? null : Math.max(0, +(t - trimmedSec).toFixed(6)));
    const words = alignToScript(
      text,
      tokens.map((t) => ({ text: t.text, start: shift(t.start), end: shift(t.end) })),
      duration,
    );
    const gapped = applyBeatGaps(spec, config.pronunciations, audio, words, duration, voice.beatGapSec);
    if (gapped.audioFile !== audio) {
      rmSync(audio);
      renameSync(gapped.audioFile, audio);
    }
    const entry: CachedAlignment = {
      text,
      voice,
      words: gapped.words,
      duration_sec: gapped.durationSec,
      leading_silence_trimmed_sec: trimmedSec,
    };
    writeFileSync(join(tmp, 'alignment.json'), JSON.stringify(entry, null, 2) + '\n');
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { key, dir, cached: false, text, voice, trimmedSec };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * `studio voice --audition`: the hook beat in every American male Kokoro voice, written to
 * out/audition/<voice_id>.wav so a person can pick the voice by ear. Not cached.
 */
export async function audition(spec: VideoSpec, opts: { root: string; providers?: Providers }): Promise<string[]> {
  const providers = opts.providers ?? defaultProviders(opts.root);
  const config = loadVoiceConfig(opts.root);
  const voice = resolveVoice(spec, config, providers);
  const hook = spec.beats.find((b) => b.role === 'hook') ?? spec.beats[0];
  const text = spokenText(hook.vo, config.pronunciations);
  const outDir = join(opts.root, 'out/audition');
  mkdirSync(outDir, { recursive: true });
  const jobs = KOKORO_AMERICAN_MALE_VOICES.map((v) => ({ text, voice: v, speed: voice.speed, out: join(outDir, `${v}.wav`) }));
  await runKokoro(opts.root, voice.provider === 'kokoro' ? voice.model_id : KOKORO_MODEL, jobs);
  return jobs.map((j) => j.out);
}

export const SPEED_AUDITION_VALUES = [0.8, 0.85, 0.9, 1.0];

export interface SpeedAuditionResult {
  speed: number;
  file: string;
  durationSec: number;
  wpm: number;
}

/**
 * `studio voice --audition-speed`: the full VO at a handful of candidate speeds, written to
 * out/audition/speed/<speed>.wav so a person can pick the pace by ear. Does not change the default
 * preset speed. Not cached.
 */
export async function speedAudition(
  spec: VideoSpec,
  opts: { root: string; providers?: Providers },
): Promise<SpeedAuditionResult[]> {
  const providers = opts.providers ?? defaultProviders(opts.root);
  const config = loadVoiceConfig(opts.root);
  const voice = resolveVoice(spec, config, providers);
  const text = spokenText(fullVo(spec), config.pronunciations);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const outDir = join(opts.root, 'out/audition/speed');
  mkdirSync(outDir, { recursive: true });
  const jobs = SPEED_AUDITION_VALUES.map((speed) => ({
    text,
    voice: voice.voice_id,
    speed,
    out: join(outDir, `${speed.toFixed(2)}.wav`),
  }));
  await runKokoro(opts.root, voice.provider === 'kokoro' ? voice.model_id : KOKORO_MODEL, jobs);
  return jobs.map((j) => {
    const durationSecs = durationSec(j.out);
    return { speed: j.speed, file: j.out, durationSec: durationSecs, wpm: (wordCount / durationSecs) * 60 };
  });
}

/**
 * Renders the full VO once at an arbitrary speed/`beat_gap_sec` combination, for a one-off
 * side-by-side comparison outside the normal preset system. Not cached.
 */
export async function comparisonTake(
  spec: VideoSpec,
  opts: { root: string; providers?: Providers },
  overrides: { speed: number; beatGapSec: number },
  out: string,
): Promise<{ durationSec: number; wpm: number }> {
  const providers = opts.providers ?? defaultProviders(opts.root);
  const config = loadVoiceConfig(opts.root);
  const voice = resolveVoice(spec, config, providers);
  const text = spokenText(fullVo(spec), config.pronunciations);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const tmp = mkdtempSync(join(tmpdir(), 'ttyng-cmp-'));
  try {
    const modelId = voice.provider === 'kokoro' ? voice.model_id : KOKORO_MODEL;
    const rawFile = join(tmp, 'raw.wav');
    const [result] = await runKokoro(opts.root, modelId, [{ text, voice: voice.voice_id, speed: overrides.speed, out: rawFile }]);
    const lead = leadingSilenceSec(rawFile);
    const trimmedSec = lead > LEADING_SILENCE_MAX_SEC ? lead : 0;
    const trimmed = join(tmp, 'trimmed.wav');
    toWav(rawFile, trimmed, trimmedSec);
    const dur = durationSec(trimmed);
    const shift = (t: number | null) => (t === null ? null : Math.max(0, +(t - trimmedSec).toFixed(6)));
    const words = alignToScript(
      text,
      result.tokens.map((t) => ({ text: t.text, start: shift(t.start), end: shift(t.end) })),
      dur,
    );
    const gapped = applyBeatGaps(spec, config.pronunciations, trimmed, words, dur, overrides.beatGapSec);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(gapped.audioFile, out);
    return { durationSec: gapped.durationSec, wpm: (wordCount / gapped.durationSec) * 60 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Decodes to 16-bit PCM WAV, cutting `trimSec` off the start. Bit-exact, so reruns produce identical files. */
function toWav(input: string, output: string, trimSec: number) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', input,
    ...(trimSec > 0 ? ['-af', `atrim=start=${trimSec},asetpts=PTS-STARTPTS`] : []),
    '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', output,
  ]);
}

export function durationSec(file: string): number {
  return Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }),
  );
}

/** Seconds of silence at the very start of the file, per FFmpeg silencedetect. */
export function leadingSilenceSec(file: string): number {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${SILENCE_THRESHOLD}:d=0.01`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (r.error) throw new Error(`could not run ffmpeg: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr.slice(-500)}`);
  const start = r.stderr.match(/silence_start: (-?[\d.]+)/);
  if (!start || Math.abs(Number(start[1])) > 0.01) return 0;
  // No silence_end means the whole file is silent; leave it alone rather than cut everything.
  const end = r.stderr.match(/silence_end: ([\d.]+)/);
  return end ? Number(end[1]) : 0;
}
