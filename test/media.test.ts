import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scrimBands } from '../src/layout.ts';
import { bandLuma, clipSegments, darkenAlpha, musicLane, sampleRowLuma, stillMotion } from '../src/media.ts';
import { computeLayout } from '../src/render.ts';
import { buildTimeline } from '../src/timeline.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { loadVoiceConfig, type CachedAlignment } from '../src/voice.ts';
import type { VideoSpec } from '../src/types.ts';
import { errors, project } from './helpers.ts';

describe('clipSegments', () => {
  const base = { beatStart: 10, beatDuration: 3.2, trimStart: 0, playbackRate: 1 };

  it('plays once, cut at the beat end, when the clip is longer than the beat', () => {
    const segs = clipSegments({ ...base, sourceDuration: 8 });
    assert.deepEqual(segs, [{ start: 10, duration: 3.2, mediaStart: 0 }]);
  });

  it('loops back to trim_start_sec until the beat is full, cutting the last pass short', () => {
    const segs = clipSegments({ ...base, sourceDuration: 2, trimStart: 0.5 });
    // 1.5 s of usable clip per pass: 10 -> 11.5 -> 13.0 -> (13.2 end)
    assert.deepEqual(
      segs.map((s) => [s.start, s.mediaStart]),
      [
        [10, 0.5],
        [11.5, 0.5],
        [13, 0.5],
      ],
    );
    assert.ok(Math.abs(segs[2].duration - 0.2) < 1e-9);
    const total = segs.reduce((n, s) => n + s.duration, 0);
    assert.ok(Math.abs(total - 3.2) < 1e-9);
  });

  it('divides a pass by playback_rate (2x plays the same source in half the timeline)', () => {
    const segs = clipSegments({ ...base, sourceDuration: 2, playbackRate: 2 });
    assert.equal(segs[0].duration, 1);
    assert.equal(segs.length, 4); // 3.2 s / 1 s per pass
  });

  it('rejects a trim that leaves almost nothing to play', () => {
    assert.throws(() => clipSegments({ ...base, sourceDuration: 2, trimStart: 1.9 }), /need at least/);
    assert.throws(() => clipSegments({ ...base, sourceDuration: 2, trimStart: 5 }), /need at least/);
  });
});

describe('musicLane', () => {
  const { tokens } = project;
  const { music_duck_db: duckDb, music_duck_attack_sec: attack, music_duck_release_sec: release, tail_sec: tail } = tokens.audio;
  const bed = 10 ** (-22 / 20);
  const ducked = 10 ** ((-22 + duckDb) / 20);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
  const at = (lane: { t: number; v: number }[], t: number) => {
    for (let i = 1; i < lane.length; i++) {
      if (t <= lane[i].t) return lane[i - 1].v + ((lane[i].v - lane[i - 1].v) * (t - lane[i - 1].t)) / (lane[i].t - lane[i - 1].t);
    }
    return lane.at(-1)!.v;
  };
  const words = [
    { start: 0, end: 1 },
    { start: 1.2, end: 2 }, // gap 0.2 < attack + release -> merged with the first word
    { start: 5, end: 6 }, // a real pause
  ];
  const lane = musicLane(words, 6 + tail, { gain_db: -22, duck_under_vo: true }, tokens);

  it('has strictly increasing times and starts at t=0', () => {
    assert.equal(lane[0].t, 0);
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i].t > lane[i - 1].t, `not increasing at ${i}`);
  });

  it('sits ducked under speech, including across a short gap between words', () => {
    near(at(lane, 0), ducked);
    near(at(lane, 1.1), ducked); // inside the 0.2 s gap
    near(at(lane, 1.9), ducked);
  });

  it('releases to the bed level in a real pause, and ducks again by the next word', () => {
    near(at(lane, 2 + release), bed);
    near(at(lane, 4), bed);
    near(at(lane, 5 - attack), bed);
    near(at(lane, 5), ducked);
  });

  it('fades to silence over the last tail_sec', () => {
    near(lane.at(-1)!.v, 0);
    assert.equal(lane.at(-1)!.t, 6 + tail);
    near(at(lane, 6), ducked); // fade starts at the last word's end
  });

  it('holds the bed level (fade-out only) when duck_under_vo is off', () => {
    const flat = musicLane(words, 10, { gain_db: -22, duck_under_vo: false }, tokens);
    near(at(flat, 3), bed);
    near(at(flat, 10 - tail), bed);
    near(flat.at(-1)!.v, 0);
  });

  it('never goes above the bed level', () => {
    assert.ok(lane.every((p) => p.v <= bed + 1e-6)); // 6-decimal rounding in the lane
  });
});

describe('stillMotion', () => {
  const { tokens } = project;
  const [z0, z1] = tokens.motion.still_zoom;
  const pan = tokens.motion.still_pan_px;

  it('defaults to push_in over still_zoom', () => {
    assert.deepEqual(stillMotion(undefined, tokens), { from: { scale: z0, x: 0 }, to: { scale: z1, x: 0 } });
  });

  it('pull_out is push_in reversed', () => {
    const push = stillMotion('push_in', tokens);
    assert.deepEqual(stillMotion('pull_out', tokens), { from: push.to, to: push.from });
  });

  it('static does not move', () => {
    const m = stillMotion('static', tokens);
    assert.deepEqual(m.from, m.to);
    assert.equal(m.from.scale, 1);
  });

  it('pans travel still_pan_px in total, symmetric about rest, in opposite directions', () => {
    const left = stillMotion('pan_left', tokens);
    const right = stillMotion('pan_right', tokens);
    assert.equal(left.from.x - left.to.x, pan);
    assert.equal(left.from.x, -left.to.x);
    assert.deepEqual(right, { from: left.to, to: left.from });
    assert.ok(left.to.x < left.from.x, 'pan_left moves the picture leftward');
  });

  it('pans scale up just enough to cover the frame at both extremes', () => {
    const { from } = stillMotion('pan_left', tokens);
    const w = tokens.canvas.width;
    // The scaled image (w*scale wide, centered) must reach past the frame edge even shifted by pan/2.
    assert.ok((w * from.scale - w) / 2 >= pan / 2 - 1e-9);
  });
});

describe('scrimBands', () => {
  it('grows each box by the feather and clamps to the canvas', () => {
    assert.deepEqual(scrimBands([{ x: 0, y: 10, w: 1, h: 100 }], 120, 1920), [{ y: 0, h: 230 }]);
    assert.deepEqual(scrimBands([{ x: 0, y: 1800, w: 1, h: 100 }], 120, 1920), [{ y: 1680, h: 240 }]);
  });

  it('merges boxes whose grown extents touch, so fades never double-darken', () => {
    const bands = scrimBands(
      [
        { x: 0, y: 300, w: 1, h: 100 },
        { x: 0, y: 600, w: 1, h: 100 }, // grown: 180..520 and 480..820 overlap
        { x: 0, y: 1400, w: 1, h: 100 }, // far away: stays its own band
      ],
      120,
      1920,
    );
    assert.deepEqual(bands, [
      { y: 180, h: 640 },
      { y: 1280, h: 340 },
    ]);
  });
});

describe('media fixture (examples/w2-p6-media.json) through timeline + layout', () => {
  const alignment = JSON.parse(readFileSync(join(PROJECT_ROOT, 'test/fixtures/w2-p6/alignment.json'), 'utf8')) as CachedAlignment;
  const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'examples/w2-p6-media.json'), 'utf8')) as VideoSpec;
  const { timeline, issues } = buildTimeline(spec, alignment, loadVoiceConfig(project.root), 'cache/tts/x/audio.wav', project.tokens, project.measure);

  it('builds, with the music settings resolved onto the timeline', () => {
    assert.deepEqual(errors(issues), []);
    assert.ok(timeline);
    assert.deepEqual(timeline.audio.music, { file: 'assets/music/bed-01.mp3', gain_db: -22, duck_under_vo: true });
  });

  it('darkens behind the label, overlay and captions on still/clip beats only', () => {
    const layout = computeLayout(timeline!, project.tokens, project.measure);
    const ids = timeline!.beats.filter((b) => b.visual.type === 'still' || b.visual.type === 'clip').map((b) => b.id);
    assert.deepEqual(Object.keys(layout.scrims).sort(), [...ids].sort());
    for (const bands of Object.values(layout.scrims)) {
      for (const b of bands) assert.ok(b.y >= 0 && b.y + b.h <= project.tokens.canvas.height && b.h > 0);
    }
    // 'reframe' has captions and the persistent label but no overlay: a label band and a caption band.
    const f = project.tokens.grade.darken_feather_px;
    const cap = layout.captions!;
    const label = layout.label!.box;
    assert.deepEqual(
      layout.scrims['reframe'].map(({ y, h }) => ({ y, h })),
      [
        { y: Math.max(0, label.y - f), h: label.h + f + Math.min(f, label.y) },
        { y: cap.y - f, h: cap.h + 2 * f },
      ],
    );
  });
});

describe('luminance-scaled darkening', () => {
  const { tokens } = project;
  const g = tokens.grade;

  // Flat-color placeholder assets, generated so the test owns its pixels.
  const assets = mkdtempSync(join(tmpdir(), 'ttyng-luma-'));
  mkdirSync(join(assets, 'stills'));
  mkdirSync(join(assets, 'clips'));
  const solid = (out: string, hex: string, extra: string[]) =>
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hex}:s=1080x1920:d=1:r=30`, ...extra, join(assets, out)]);
  solid('stills/dark.png', '0x101010', ['-frames:v', '1']);
  solid('stills/bright.png', '0xE6E6E6', ['-frames:v', '1']);
  solid('clips/bright.mp4', '0xE6E6E6', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

  const alignment = JSON.parse(readFileSync(join(PROJECT_ROOT, 'test/fixtures/w2-p6/alignment.json'), 'utf8')) as CachedAlignment;
  const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'examples/w2-p6-media.json'), 'utf8')) as VideoSpec;
  const build = (visuals: Record<string, VideoSpec['beats'][number]['visual']>) => {
    const s = structuredClone(spec);
    for (const b of s.beats) if (visuals[b.id]) b.visual = visuals[b.id];
    return buildTimeline(s, alignment, loadVoiceConfig(project.root), 'cache/tts/x/audio.wav', tokens, project.measure).timeline!;
  };
  const timeline = build({
    hook: { type: 'still', asset: 'stills/dark.png' },
    point: { type: 'clip', asset: 'clips/bright.mp4' },
    reframe: { type: 'still', asset: 'stills/bright.png' },
    payoff: { type: 'still', asset: 'stills/dark.png' },
    tease: { type: 'still', asset: 'stills/bright.png' },
  });
  const layout = computeLayout(timeline, tokens, project.measure, sampleRowLuma(assets, timeline, tokens));

  // WCAG contrast of `fg` over a background of gray level `bg` (0-1) darkened by black at `alpha`
  // (CSS blends in sRGB space, so scale the encoded value).
  const chan = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex: string) => {
    const [r, g2, b] = [1, 3, 5].map((i) => chan(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
  };
  const contrast = (hex: string, bg: number, alpha: number) => (lum(hex) + 0.05) / (chan(bg * (1 - alpha)) + 0.05);

  it('maps luma to alpha: floor when dark, ceiling from darken_bright_luma up, linear between', () => {
    assert.equal(darkenAlpha(0, tokens), g.darken_behind_text);
    assert.equal(darkenAlpha(g.darken_bright_luma, tokens), g.darken_behind_text_max);
    assert.equal(darkenAlpha(1, tokens), g.darken_behind_text_max);
    const mid = darkenAlpha(g.darken_bright_luma / 2, tokens);
    assert.ok(Math.abs(mid - (g.darken_behind_text + g.darken_behind_text_max) / 2) < 1e-9);
  });

  it('samples the real pixels: dark still ~0.06, bright still and bright clip ~0.90', () => {
    const rows = sampleRowLuma(assets, timeline, tokens);
    const mean = (r: number[]) => r.reduce((a, b) => a + b, 0) / r.length;
    assert.ok(Math.abs(mean(rows['hook']) - 0x10 / 255) < 0.02, `dark: ${mean(rows['hook'])}`);
    assert.ok(Math.abs(mean(rows['reframe']) - 0xe6 / 255) < 0.02, `bright still: ${mean(rows['reframe'])}`);
    assert.ok(Math.abs(mean(rows['point']) - 0xe6 / 255) < 0.03, `bright clip: ${mean(rows['point'])}`);
    assert.equal(rows['series_intro'], undefined); // typography: not sampled
    assert.ok(bandLuma(rows['reframe'], { y: 100, h: 200 }, tokens.canvas.height) > 0.85);
  });

  it('uses the floor over the dark still and the ceiling over the bright still and clip', () => {
    for (const band of layout.scrims['hook']) assert.ok(Math.abs(band.alpha - darkenAlpha(0x10 / 255, tokens)) < 0.01);
    assert.ok(layout.scrims['hook'].every((b) => b.alpha < 0.5));
    for (const id of ['reframe', 'point', 'tease']) {
      for (const band of layout.scrims[id]) assert.equal(band.alpha, g.darken_behind_text_max);
    }
  });

  it('gives the series label >= 4.5:1 against a bright still (and the cream caption/overlay text too)', () => {
    const labelBox = layout.label!.box;
    const band = layout.scrims['reframe'].find((b) => b.y <= labelBox.y && labelBox.y + labelBox.h <= b.y + b.h);
    assert.ok(band, 'label sits inside a darkening band');
    const bg = 0xe6 / 255;
    const muted = contrast(tokens.colors.muted, bg, band.alpha);
    assert.ok(muted >= 4.5, `label contrast ${muted.toFixed(2)}:1`);
    assert.ok(contrast(tokens.colors.text, bg, band.alpha) >= 4.5);
    // ...and it would NOT have passed without the band (guards the test against a vacuous pass).
    assert.ok(contrast(tokens.colors.muted, bg, 0) < 3);
  });
});
