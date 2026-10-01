import { scrimBands, type Box } from './layout.ts';
import type { Timeline, TimelineBeat } from './timeline.ts';
import type { MotionPreset, Tokens } from './types.ts';

// Preset-driven motion (brand/tokens.json motion_presets). Everything here is a pure function of the
// timeline + tokens + a string seed, so the same inputs always render the same pixels (SPEC principle 4).
// The template only executes the plan; it computes nothing random.

/** FNV-1a hash of a string, for seeding. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface Ember {
  x: number;
  /** Start and end top in px; embers rise. */
  y0: number;
  y1: number;
  size: number;
  /** Peak opacity. */
  opacity: number;
  /** Horizontal sway amplitude (px) and half-period (s). */
  sway: number;
  swaySec: number;
  /** Half-period of the opacity twinkle (s). */
  twinkleSec: number;
}

export interface MotionPlan {
  preset: string;
  /** Still beats: eased push-in plus slow drift. `base` is raised just enough that drift never shows an edge. */
  camera: {
    base: number;
    end: number;
    ease: string;
    driftX: { amp: number; sign: 1 | -1; halfSec: number };
    driftY: { amp: number; sign: 1 | -1; halfSec: number };
  } | null;
  /** Hard cut to `scale`x at time `at` (composition seconds). */
  punch: { at: number; scale: number } | null;
  glow: { amount: number; halfSec: number } | null;
  embers: { items: Ember[]; mask: string } | null;
  /** Number cards: slam-in, pulse, and the previous still dimmed behind. */
  numberCard: {
    slamFrom: number;
    slamSec: number;
    pulse: number;
    pulseHalfSec: number;
    prev: { asset: string; scale: number; dim: number } | null;
  } | null;
}

/**
 * The caption-page start nearest the beat's midpoint (at least 1 s from either edge), or the midpoint
 * itself when the beat has no such page start. Null when the beat is not longer than `minBeatSec`.
 */
export function punchTime(beat: { start: number; end: number }, pageStarts: number[], minBeatSec: number): number | null {
  const dur = beat.end - beat.start;
  if (dur <= minBeatSec) return null;
  const mid = beat.start + dur / 2;
  const inside = pageStarts.filter((t) => t > beat.start + 1 && t < beat.end - 1);
  return inside.length ? inside.reduce((best, t) => (Math.abs(t - mid) < Math.abs(best - mid) ? t : best)) : mid;
}

/**
 * CSS mask for the ember layer: opaque everywhere except the bands behind the label, overlay and
 * captions (the same bands `scrimBands` darkens), where it drops to `cap` so embers never sit behind
 * text at high opacity.
 */
export function emberMask(boxes: Box[], cap: number, feather: number, canvasHeight: number): string {
  const stops = ['#000 0px'];
  for (const band of scrimBands(boxes, feather, canvasHeight)) {
    const a = `rgba(0,0,0,${cap})`;
    stops.push(`#000 ${r3(band.y)}px`, `${a} ${r3(Math.min(band.y + feather, band.y + band.h / 2))}px`);
    stops.push(`${a} ${r3(Math.max(band.y + band.h - feather, band.y + band.h / 2))}px`, `#000 ${r3(band.y + band.h)}px`);
  }
  return `linear-gradient(to bottom, ${stops.join(', ')}, #000 ${canvasHeight}px)`;
}

function embers(seed: string, preset: NonNullable<MotionPreset['particles']>, dur: number, tokens: Tokens, mask: string): MotionPlan['embers'] {
  const rnd = seededRandom(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const { width, height } = tokens.canvas;
  const items: Ember[] = Array.from({ length: preset.count }, () => {
    const size = between(...preset.size_px);
    const y0 = between(0.15 * height, 1.05 * height);
    return {
      x: r3(between(0, width)),
      y0: r3(y0),
      y1: r3(y0 - between(...preset.speed_px_s) * dur),
      size: r3(size),
      opacity: r3(preset.opacity * between(0.5, 1)),
      sway: r3(between(15, 50)),
      swaySec: r3(between(1.5, 3.5)),
      twinkleSec: r3(between(0.6, 1.6)),
    };
  });
  return { items, mask };
}

/**
 * The motion plan for every beat that has a preset, keyed by beat id. Beats without one are absent and
 * keep the plain Ken Burns path. Boxes are the label, captions and per-beat overlay boxes from the layout.
 */
export function motionPlans(
  timeline: Timeline,
  tokens: Tokens,
  boxes: { label: Box | null; captions: Box | null; overlays: Record<string, Box> },
): Record<string, MotionPlan> {
  const plans: Record<string, MotionPlan> = {};
  const { width, height } = tokens.canvas;
  const pageStarts = timeline.caption_pages.map((p) => p.start);
  timeline.beats.forEach((beat: TimelineBeat, i) => {
    if (!beat.motion) return;
    const preset = tokens.motion_presets[beat.motion];
    const dur = beat.end - beat.start;
    const seed = `${timeline.id}:${beat.id}`;
    const rnd = seededRandom(`${seed}:camera`);
    const sign = (): 1 | -1 => (rnd() < 0.5 ? -1 : 1);
    const v = beat.visual;

    let camera: MotionPlan['camera'] = null;
    let punch: MotionPlan['punch'] = null;
    let glow: MotionPlan['glow'] = null;
    if (v.type === 'still' && v.motion !== 'static') {
      const { x_px, y_px, period_sec } = preset.drift;
      // Raise the starting scale so the largest drift offset still stays inside the image at t=0.
      const base = Math.ceil(Math.max(1, 1 + (2 * x_px) / width, 1 + (2 * y_px) / height) * 1000) / 1000; // rounded up, never down
      camera = {
        base,
        end: r3(base * (1 + preset.push)),
        ease: preset.ease,
        driftX: { amp: x_px, sign: sign(), halfSec: period_sec / 2 },
        driftY: { amp: y_px, sign: sign(), halfSec: (period_sec * 1.37) / 2 },
      };
      if (preset.punch_in) {
        const at = punchTime(beat, pageStarts, preset.punch_in.min_beat_sec);
        if (at !== null) punch = { at: r3(at), scale: preset.punch_in.scale };
      }
      if (preset.glow_pulse) glow = { amount: preset.glow_pulse.amount, halfSec: preset.glow_pulse.period_sec / 2 };
    }

    let emberPlan: MotionPlan['embers'] = null;
    if (preset.particles && v.type !== 'clip') {
      const textBoxes = [boxes.label, boxes.overlays[beat.id] ?? null, boxes.captions].filter((b): b is Box => !!b);
      emberPlan = embers(`${seed}:embers`, preset.particles, dur, tokens, emberMask(textBoxes, preset.particles.caption_opacity, tokens.grade.darken_feather_px, height));
    }

    let numberCard: MotionPlan['numberCard'] = null;
    if (v.type === 'typography' && v.style === 'number' && preset.number_card) {
      const n = preset.number_card;
      const prev = timeline.beats[i - 1];
      let prevStill: NonNullable<MotionPlan['numberCard']>['prev'] = null;
      if (prev?.visual.type === 'still') {
        // The dimmed picture rests at where the previous beat's camera ended (drift offset ignored).
        const pp = plans[prev.id];
        const scale = pp?.camera ? pp.camera.end * (pp.punch?.scale ?? 1) : tokens.motion.still_zoom[1];
        prevStill = { asset: prev.visual.asset, scale: r3(scale), dim: n.dim_prev };
      }
      numberCard = { slamFrom: n.slam_from, slamSec: n.slam_sec, pulse: n.pulse, pulseHalfSec: n.pulse_sec / 2, prev: prevStill };
    }

    plans[beat.id] = { preset: beat.motion, camera, punch, glow, embers: emberPlan, numberCard };
  });
  return plans;
}
