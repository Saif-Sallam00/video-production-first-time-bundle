import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { emberMask, motionPlans, punchTime, seededRandom } from '../src/motion.ts';
import { computeLayout } from '../src/render.ts';
import { buildTimeline, type Timeline } from '../src/timeline.ts';
import type { MotionPresetName, VideoSpec } from '../src/types.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { loadVoiceConfig, type CachedAlignment } from '../src/voice.ts';
import { errors, makeSpec, project } from './helpers.ts';

const { tokens } = project;
const preset = (n: MotionPresetName) => tokens.motion_presets[n];
const boxes = { label: { x: 60, y: 220, w: 800, h: 50 }, captions: { x: 60, y: 1100, w: 880, h: 160 }, overlays: {} };

/** hook (still, 7 s) -> number card (typography) -> body (still, 3 s) -> clip -> static still. */
const timeline = (motion?: MotionPresetName): Timeline => {
  const m = motion ? { motion } : {};
  return {
    id: 't', duration_sec: 20, audio: { vo: 'x', music: null }, label: 'L', words: [], caption_style: 'word_highlight',
    cta_pop: null, end_card: null,
    caption_pages: [0, 2, 3.6, 5, 6.5, 9].map((s) => ({ start: s, end: s + 1, lines: [['a', 'b']], word_indexes: [0, 1] as [number, number] })),
    beats: [
      { id: 'hook', start: 0, end: 7, visual: { type: 'still', asset: 'stills/a.jpg' }, ...m },
      { id: 'num', start: 7, end: 12, visual: { type: 'typography', text: '5', style: 'number' }, ...m },
      { id: 'body', start: 12, end: 15, visual: { type: 'still', asset: 'stills/b.jpg' }, ...m },
      { id: 'vid', start: 15, end: 18, visual: { type: 'clip', asset: 'clips/c.mp4' }, ...m },
      { id: 'still', start: 18, end: 20, visual: { type: 'still', asset: 'stills/d.jpg', motion: 'static' }, ...m },
    ],
  };
};

describe('seededRandom', () => {
  it('repeats for the same seed and differs for another', () => {
    const a = seededRandom('x'), b = seededRandom('x'), c = seededRandom('y');
    const xs = [a(), a(), a()];
    assert.deepEqual(xs, [b(), b(), b()]);
    assert.notDeepEqual(xs, [c(), c(), c()]);
    assert.ok(xs.every((v) => v >= 0 && v < 1));
  });
});

describe('punchTime', () => {
  it('is null for a beat not longer than the minimum', () => {
    assert.equal(punchTime({ start: 0, end: 3.5 }, [1, 2], 3.5), null);
  });
  it('picks the caption-page start nearest the beat midpoint, ignoring starts within 1 s of the edges', () => {
    assert.equal(punchTime({ start: 0, end: 7 }, [0, 0.5, 2, 3.6, 5, 6.8], 3.5), 3.6);
  });
  it('falls back to the midpoint when no page starts inside the beat', () => {
    assert.equal(punchTime({ start: 10, end: 14 }, [0, 20], 3.5), 12);
  });
});

describe('emberMask', () => {
  it('is opaque outside the text bands and capped inside them', () => {
    const m = emberMask([boxes.captions], 0.2, 120, 1920);
    assert.match(m, /^linear-gradient\(to bottom, #000 0px, #000 980px, rgba\(0,0,0,0\.2\) 1100px, rgba\(0,0,0,0\.2\) 1260px, #000 1380px, #000 1920px\)$/);
  });
});

describe('motionPlans', () => {
  it('gives beats without a preset no plan (default behavior unchanged)', () => {
    assert.deepEqual(motionPlans(timeline(), tokens, boxes), {});
  });
  it('is deterministic: same inputs, same plan', () => {
    assert.deepEqual(motionPlans(timeline('punch'), tokens, boxes), motionPlans(timeline('punch'), tokens, boxes));
  });
  it('punch: push-in of 12-18% from a base that covers the drift, punch-in only on long stills', () => {
    const plans = motionPlans(timeline('punch'), tokens, boxes);
    const cam = plans.hook.camera!;
    assert.ok(cam.end / cam.base >= 1.12 && cam.end / cam.base <= 1.18, `push ${cam.end / cam.base}`);
    assert.ok(cam.base >= 1 + (2 * preset('punch').drift.x_px) / tokens.canvas.width);
    assert.ok(cam.base >= 1 + (2 * preset('punch').drift.y_px) / tokens.canvas.height);
    assert.deepEqual(plans.hook.punch, { at: 3.6, scale: 1.35 });
    assert.equal(plans.body.punch, null, '3 s beat is under the 3.5 s minimum');
    assert.ok(plans.hook.punch!.scale >= 1.3 && plans.hook.punch!.scale <= 1.4);
    assert.deepEqual(plans.hook.glow, { amount: 0.08, halfSec: 1.25 });
  });
  it('clips get no camera; a static still gets no camera or punch; embers skip clips only', () => {
    const plans = motionPlans(timeline('punch'), tokens, boxes);
    assert.equal(plans.vid.camera, null);
    assert.equal(plans.vid.embers, null);
    assert.equal(plans.still.camera, null);
    assert.equal(plans.still.punch, null);
    assert.ok(plans.still.embers && plans.num.embers);
  });
  it('embers: seeded, sparse, rising, capped behind text', () => {
    const e = motionPlans(timeline('punch'), tokens, boxes).hook.embers!;
    assert.equal(e.items.length, preset('punch').particles!.count);
    assert.ok(e.items.every((i) => i.y1 < i.y0 && i.opacity <= preset('punch').particles!.opacity));
    assert.match(e.mask, /rgba\(0,0,0,0\.2\)/);
    const other = motionPlans({ ...timeline('punch'), id: 'u' }, tokens, boxes).hook.embers!;
    assert.notDeepEqual(other.items, e.items, 'seed includes the video id');
  });
  it('number card: slam, pulse, and the previous still dimmed at its camera end incl. punch', () => {
    const plans = motionPlans(timeline('punch'), tokens, boxes);
    const n = plans.num.numberCard!;
    assert.equal(n.slamFrom, preset('punch').number_card!.slam_from);
    const hook = plans.hook;
    assert.deepEqual(n.prev, { asset: 'stills/a.jpg', scale: Math.round(hook.camera!.end * 1.35 * 1000) / 1000, dim: preset('punch').number_card!.dim_prev });
    assert.equal(plans.hook.numberCard, null);
  });
  it('calm has no punch, glow or embers', () => {
    const p = motionPlans(timeline('calm'), tokens, boxes).hook;
    assert.deepEqual([p.punch, p.glow, p.embers], [null, null, null]);
    assert.ok(p.camera);
  });
});

describe('timeline + layout wiring', () => {
  const alignment = JSON.parse(readFileSync(join(PROJECT_ROOT, 'test/fixtures/w2-p6/alignment.json'), 'utf8')) as CachedAlignment;
  const config = loadVoiceConfig(project.root);
  const build = (spec: VideoSpec) => {
    const { timeline: tl, issues } = buildTimeline(spec, alignment, config, 'cache/tts/x/audio.wav', tokens, project.measure);
    assert.deepEqual(errors(issues), []);
    return tl!;
  };
  it('existing specs: no motion on the timeline, empty layout.motion', () => {
    const tl = build(makeSpec());
    assert.ok(tl.beats.every((b) => !('motion' in b)));
    assert.deepEqual(computeLayout(tl, tokens, project.measure).motion, {});
  });
  it('spec motion_preset applies to every beat; a beat motion overrides it', () => {
    const spec = makeSpec();
    spec.motion_preset = 'drift';
    spec.beats[1].motion = 'calm';
    const tl = build(spec);
    assert.deepEqual(tl.beats.map((b) => b.motion), tl.beats.map((_, i) => (i === 1 ? 'calm' : 'drift')));
  });
  it('schema accepts the fields and rejects an unknown preset', () => {
    const spec = makeSpec();
    spec.motion_preset = 'punch';
    spec.beats[0].motion = 'calm';
    assert.deepEqual(project.checkSchema(spec), []);
    (spec as unknown as Record<string, unknown>).motion_preset = 'wild';
    assert.equal(project.checkSchema(spec).length, 1);
  });
});
