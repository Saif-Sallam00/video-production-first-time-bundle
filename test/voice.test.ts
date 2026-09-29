import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { elevenLabsProvider } from '../src/tts/elevenlabs.ts';
import type { ResolvedVoice, TtsProvider } from '../src/tts/provider.ts';
import {
  durationSec,
  leadingSilenceSec,
  resolveVoice,
  spokenText,
  synthesize,
  ttsCacheKey,
  type CachedAlignment,
  type VoiceConfig,
} from '../src/voice.ts';
import { makeSpec } from './helpers.ts';

const KOKORO_PRESET = { provider: 'kokoro', model_id: 'hexgrad/Kokoro-82M', voice_id: 'am_michael', speed: 1 };
const ELEVEN_PRESET = {
  provider: 'elevenlabs',
  model_id: 'eleven_multilingual_v2',
  voice_id: 'voice-123',
  speed: 1,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
};
const CONFIG: VoiceConfig = { presets: { 'james-default': KOKORO_PRESET, eleven: ELEVEN_PRESET }, pronunciations: {} };

/** A project root holding just config/voice.json; cache/ is created under it. */
function makeRoot(pronunciations: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ttyng-voice-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(
    join(root, 'config/voice.json'),
    JSON.stringify({ 'james-default': KOKORO_PRESET, eleven: ELEVEN_PRESET, pronunciations }),
  );
  return root;
}

/** Writes `leadSec` of digital silence, then `toneSec` of tone. */
function writeTone(file: string, leadSec: number, toneSec = 1) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono:d=${leadSec}`,
    '-f', 'lavfi', '-i', `sine=f=440:d=${toneSec}:r=24000`,
    '-filter_complex', '[0][1]concat=n=2:v=0:a=1', file,
  ]);
}

/** A local provider: speech starts at `leadSec`, one word every 0.1 s. Records every call. */
function fakeProvider(leadSec = 0, opts: { garbleWords?: boolean } = {}) {
  const calls: { text: string; voice: ResolvedVoice }[] = [];
  const provider: TtsProvider = {
    alignment: 'fake-words',
    async synthesize(text, voice, workDir) {
      calls.push({ text, voice });
      const words = text.split(' ');
      const audioFile = join(workDir, 'fake.wav');
      writeTone(audioFile, leadSec, words.length * 0.1 + 0.2);
      return {
        audioFile,
        tokens: words.map((w, i) => ({
          text: opts.garbleWords && i % 3 === 0 ? 'zzz' : w,
          start: +(leadSec + i * 0.1).toFixed(3),
          end: +(leadSec + i * 0.1 + 0.08).toFixed(3),
        })),
      };
    },
  };
  return { provider, calls, providers: { kokoro: provider } };
}

const readAlignment = (dir: string) => JSON.parse(readFileSync(join(dir, 'alignment.json'), 'utf8')) as CachedAlignment;

describe('pronunciations', () => {
  const map = { TTYNG: 'the talk you never got', gif: 'jif' };
  it('replaces whole words, case-insensitively, keeping attached punctuation', () => {
    assert.equal(spokenText('Welcome to TTYNG, a GIF-free "gif".', map), 'Welcome to the talk you never got, a GIF-free "jif".');
  });
  it('leaves partial matches alone', () => {
    assert.equal(spokenText('gifted ttyngs', map), 'gifted ttyngs');
  });
  it('is applied to the text sent to the provider', async () => {
    const fake = fakeProvider();
    const r = await synthesize(makeSpec(), { root: makeRoot({ six: 'sechs' }), providers: fake.providers });
    assert.match(fake.calls[0].text, /Sechs: there'll be pauses/i);
    assert.equal(r.text, fake.calls[0].text);
  });
});

describe('voice presets', () => {
  const providers = { kokoro: fakeProvider().provider, elevenlabs: elevenLabsProvider() };
  it('resolves provider, model, voice, speed and the provider alignment method', () => {
    assert.deepEqual(resolveVoice(makeSpec(), CONFIG, providers), {
      preset: 'james-default',
      provider: 'kokoro',
      model_id: 'hexgrad/Kokoro-82M',
      voice_id: 'am_michael',
      speed: 1,
      beatGapSec: 0,
      alignment: 'fake-words',
      settings: {},
    });
  });
  it('lets the spec speed override the preset speed', () => {
    const spec = makeSpec();
    spec.voice = { speed: 1.1 };
    assert.equal(resolveVoice(spec, CONFIG, providers).speed, 1.1);
  });
  it('keeps provider-specific settings', () => {
    const spec = makeSpec();
    spec.voice = { preset: 'eleven' };
    const v = resolveVoice(spec, CONFIG, providers);
    assert.equal(v.alignment, 'elevenlabs-characters');
    assert.deepEqual(v.settings, { stability: 0.5, similarity_boost: 0.75, style: 0 });
  });
  it('rejects an unknown preset (including the pronunciations key) and an unknown provider', () => {
    const spec = makeSpec();
    spec.voice = { preset: 'nope' };
    assert.throws(() => resolveVoice(spec, CONFIG, providers), /"nope" is not in config\/voice.json/);
    spec.voice = { preset: 'pronunciations' };
    assert.throws(() => resolveVoice(spec, CONFIG, providers), /not in config/);
    spec.voice = { preset: 'james-default' };
    assert.throws(() => resolveVoice(spec, CONFIG, { elevenlabs: elevenLabsProvider() }), /unknown provider "kokoro"/);
  });
});

describe('cache key', () => {
  const voice = resolveVoice(makeSpec(), CONFIG, { kokoro: fakeProvider().provider });
  const key = (v: Partial<ResolvedVoice>, text = 'Hello there.') => ttsCacheKey(text, { ...voice, ...v });
  it('is stable for the same text and voice', () => {
    assert.equal(key({}), ttsCacheKey('Hello there.', structuredClone(voice)));
    assert.match(key({}), /^[0-9a-f]{64}$/);
  });
  it('changes with the text, provider, model, voice, speed and alignment method', () => {
    const base = key({});
    for (const change of [
      { provider: 'elevenlabs' },
      { model_id: 'other-model' },
      { voice_id: 'am_adam' },
      { speed: 1.1 },
      { alignment: 'whisper-words' },
    ]) {
      assert.notEqual(key(change), base, JSON.stringify(change));
    }
    assert.notEqual(key({}, 'Hello there!'), base);
  });
});

describe('studio voice cache', () => {
  it('calls the provider once, then serves the second run from the cache', async () => {
    const root = makeRoot();
    const fake = fakeProvider();
    const first = await synthesize(makeSpec(), { root, providers: fake.providers });
    assert.equal(first.cached, false);
    assert.equal(fake.calls.length, 1);
    assert.ok(existsSync(join(first.dir, 'audio.wav')));
    assert.ok(existsSync(join(first.dir, 'alignment.json')));

    const second = await synthesize(makeSpec(), { root, providers: fake.providers });
    assert.equal(second.cached, true);
    assert.equal(second.key, first.key);
    assert.equal(fake.calls.length, 1, 'second run must not call the provider');
  });
  it('makes a new entry when the spec speed changes', async () => {
    const root = makeRoot();
    const fake = fakeProvider();
    await synthesize(makeSpec(), { root, providers: fake.providers });
    const spec = makeSpec();
    spec.voice = { speed: 1.1 };
    const r = await synthesize(spec, { root, providers: fake.providers });
    assert.equal(r.cached, false);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].voice.speed, 1.1);
    assert.equal(readdirSync(join(root, 'cache/tts')).length, 2);
  });
  it('writes one word per script word, in the shared alignment format', async () => {
    const r = await synthesize(makeSpec(), { root: makeRoot(), providers: fakeProvider().providers });
    const a = readAlignment(r.dir);
    const script = makeSpec().beats.map((b) => b.vo).join(' ').split(' ');
    assert.deepEqual(a.words.map((w) => w.text), script);
    assert.equal(a.voice.provider, 'kokoro');
    assert.ok(a.duration_sec > 0);
    assert.ok(a.words.every((w, i) => i === 0 || w.start >= a.words[i - 1].start));
  });
  it('caches nothing when more than 10% of words cannot be matched', async () => {
    const root = makeRoot();
    await assert.rejects(
      synthesize(makeSpec(), { root, providers: fakeProvider(0, { garbleWords: true }).providers }),
      /could not be matched to audio timings; max is 10%/,
    );
    assert.deepEqual(readdirSync(join(root, 'cache/tts')), []);
  });
});

describe('leading silence', () => {
  it('trims more than 0.15 s and shifts the word timings by the same amount', async () => {
    const r = await synthesize(makeSpec(), { root: makeRoot(), providers: fakeProvider(0.5).providers });
    assert.ok(Math.abs(r.trimmedSec - 0.5) < 0.03, `trimmed ${r.trimmedSec}`);
    const a = readAlignment(r.dir);
    assert.equal(a.leading_silence_trimmed_sec, r.trimmedSec);
    const shifted = (t: number) => Math.max(0, t - r.trimmedSec); // times never go below 0
    assert.ok(Math.abs(a.words[0].start - shifted(0.5)) < 1e-6);
    assert.ok(Math.abs(a.words[10].start - shifted(1.5)) < 1e-6);
    assert.ok(leadingSilenceSec(join(r.dir, 'audio.wav')) <= 0.15);
    assert.equal(a.duration_sec, durationSec(join(r.dir, 'audio.wav')));
  });
  it('leaves 0.15 s or less alone', async () => {
    const r = await synthesize(makeSpec(), { root: makeRoot(), providers: fakeProvider(0.1).providers });
    assert.equal(r.trimmedSec, 0);
    assert.equal(readAlignment(r.dir).words[0].start, 0.1);
  });
  it('produces byte-identical audio on a re-render', async () => {
    const a = await synthesize(makeSpec(), { root: makeRoot(), providers: fakeProvider(0.5).providers });
    const b = await synthesize(makeSpec(), { root: makeRoot(), providers: fakeProvider(0.5).providers });
    assert.deepEqual(readFileSync(join(a.dir, 'audio.wav')), readFileSync(join(b.dir, 'audio.wav')));
  });
});

describe('ElevenLabs provider (optional)', () => {
  const voice = resolveVoice({ ...makeSpec(), voice: { preset: 'eleven' } }, CONFIG, { elevenlabs: elevenLabsProvider(), kokoro: fakeProvider().provider });
  function fakeFetch() {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      const chars = [...(body.text as string)];
      const dir = mkdtempSync(join(tmpdir(), 'ttyng-11-'));
      writeTone(join(dir, 'a.mp3'), 0, 1);
      return Response.json({
        audio_base64: readFileSync(join(dir, 'a.mp3')).toString('base64'),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i * 0.01),
          character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.01),
        },
      });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }
  it('sends the with-timestamps request and returns character tokens', async () => {
    const f = fakeFetch();
    const out = await elevenLabsProvider({ fetch: f.fetch, env: { ELEVENLABS_API_KEY: 'k' } }).synthesize(
      'Hi you',
      voice,
      mkdtempSync(join(tmpdir(), 'ttyng-11w-')),
    );
    const [call] = f.calls;
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-123/with-timestamps?output_format=mp3_44100_128');
    assert.equal(call.headers['xi-api-key'], 'k');
    assert.deepEqual(call.body, {
      text: 'Hi you',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1 },
    });
    assert.deepEqual(out.tokens.map((t) => t.text), [...'Hi you']);
    assert.ok(existsSync(out.audioFile));
  });
  it('fails without an API key', async () => {
    await assert.rejects(
      elevenLabsProvider({ fetch: fakeFetch().fetch, env: {} }).synthesize('Hi', voice, tmpdir()),
      /ELEVENLABS_API_KEY/,
    );
  });
});
