import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { kokoroProvider } from '../src/tts/kokoro.ts';
import type { TtsProvider } from '../src/tts/provider.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { synthesize, type CachedAlignment } from '../src/voice.ts';
import { makeSpec } from './helpers.ts';

// Runs the real Kokoro-82M model (CPU, ~10 s per process after the first-time model download).

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ttyng-kokoro-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(
    join(root, 'config/voice.json'),
    JSON.stringify({
      'james-default': { provider: 'kokoro', model_id: 'hexgrad/Kokoro-82M', voice_id: 'am_michael', speed: 1 },
    }),
  );
  return root;
}

/** The fixture's first two beats: enough speech to exercise contractions, a dash and a semicolon. */
function shortSpec() {
  const spec = makeSpec();
  spec.beats = spec.beats.slice(0, 2);
  delete spec.cta_pop;
  return spec;
}

function counting(provider: TtsProvider) {
  let calls = 0;
  return {
    providers: { kokoro: { ...provider, synthesize: (...a: Parameters<TtsProvider['synthesize']>) => (calls++, provider.synthesize(...a)) } },
    calls: () => calls,
  };
}

describe('Kokoro provider (real model)', () => {
  const kokoro = kokoroProvider(PROJECT_ROOT);
  let first: { dir: string; alignment: CachedAlignment } | undefined;

  it('times every script word from the model durations and trims the leading silence', async () => {
    const root = makeRoot();
    const c = counting(kokoro);
    const r = await synthesize(shortSpec(), { root, providers: c.providers });
    const a = JSON.parse(readFileSync(join(r.dir, 'alignment.json'), 'utf8')) as CachedAlignment;
    first = { dir: r.dir, alignment: a };

    assert.deepEqual(a.words.map((w) => w.text), r.text.split(' '));
    assert.deepEqual(a.words.filter((w) => !w.matched).map((w) => w.text), ['—']); // punctuation-only word
    assert.ok(a.words.every((w, i) => w.end >= w.start && (i === 0 || w.start >= a.words[i - 1].start)));
    assert.equal(a.voice.alignment, 'kokoro-durations');
    assert.ok(r.trimmedSec > 0.15, `Kokoro starts with ~0.37 s of silence; trimmed ${r.trimmedSec}`);
    assert.ok(a.words[0].start < 0.05);
    assert.ok(a.words.at(-1)!.end <= a.duration_sec + 0.01);

    const again = await synthesize(shortSpec(), { root, providers: c.providers });
    assert.equal(again.cached, true);
    assert.equal(c.calls(), 1);
  });

  it('renders byte-identical audio and timings in a fresh process', async () => {
    assert.ok(first, 'runs after the previous test');
    const r = await synthesize(shortSpec(), { root: makeRoot(), providers: { kokoro } });
    assert.equal(r.cached, false);
    assert.deepEqual(readFileSync(join(r.dir, 'audio.wav')), readFileSync(join(first.dir, 'audio.wav')));
    const a = JSON.parse(readFileSync(join(r.dir, 'alignment.json'), 'utf8')) as CachedAlignment;
    assert.deepEqual(a.words, first.alignment.words);
  });
});
