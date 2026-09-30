import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Timeline } from './timeline.ts';
import type { Tokens } from './types.ts';

// Media for the HyperFrames composition (SPEC sections 7-8): clip looping, music ducking, and the
// static <video>/<audio> markup. Pure functions here so they're unit-testable without a renderer.

// A clip whose usable length is below this would need dozens of back-to-back <video> elements to fill
// a beat; almost certainly a wrong trim_start_sec, so fail loudly instead.
const MIN_CLIP_SEGMENT_SEC = 0.25;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export type StillMotion = 'static' | 'push_in' | 'pull_out' | 'pan_left' | 'pan_right';

/** One end of a still's move: a uniform scale about the frame center plus a horizontal shift in px. */
export interface StillPose {
  scale: number;
  x: number;
}

/**
 * Where a still starts and ends (SPEC section 7). `push_in`/`pull_out` sweep `motion.still_zoom`
 * (pull_out is the same range reversed). Pans travel `motion.still_pan_px` in total, centered on the
 * frame (half either side of rest), and hold a fixed scale just big enough that the image still covers
 * the frame at both extremes: scale = (canvas width + pan) / canvas width. `pan_left` moves the image
 * leftward across the frame (the picture slides left; the view drifts right), `pan_right` the reverse.
 * Cover-fit itself is CSS (`object-fit: cover`); these poses are applied on top of it.
 */
export function stillMotion(motion: StillMotion = 'push_in', tokens: Tokens): { from: StillPose; to: StillPose } {
  const [z0, z1] = tokens.motion.still_zoom;
  const pan = tokens.motion.still_pan_px;
  const panScale = (tokens.canvas.width + pan) / tokens.canvas.width;
  switch (motion) {
    case 'static':
      return { from: { scale: 1, x: 0 }, to: { scale: 1, x: 0 } };
    case 'push_in':
      return { from: { scale: z0, x: 0 }, to: { scale: z1, x: 0 } };
    case 'pull_out':
      return { from: { scale: z1, x: 0 }, to: { scale: z0, x: 0 } };
    case 'pan_left':
      return { from: { scale: panScale, x: pan / 2 }, to: { scale: panScale, x: -pan / 2 } };
    case 'pan_right':
      return { from: { scale: panScale, x: -pan / 2 }, to: { scale: panScale, x: pan / 2 } };
  }
}

export interface ClipSegment {
  /** Composition time this segment starts at. */
  start: number;
  /** How long it plays on the timeline. */
  duration: number;
  /** Offset into the source file it starts from (always the clip's `trim_start_sec`). */
  mediaStart: number;
}

/**
 * A beat's clip background as back-to-back segments: the clip plays from `trimStart` to its end
 * (at `playbackRate`), then restarts from `trimStart` until the beat is full (SPEC section 7: "loops
 * if shorter than the beat"). One media element per segment is HyperFrames' own model for cuts and
 * repeats (creator-editing-recipes: "one media element per kept range"); the last segment is cut off
 * at the beat's end.
 */
export function clipSegments(o: {
  beatStart: number;
  beatDuration: number;
  sourceDuration: number;
  trimStart: number;
  playbackRate: number;
}): ClipSegment[] {
  const usable = (o.sourceDuration - o.trimStart) / o.playbackRate;
  if (usable < MIN_CLIP_SEGMENT_SEC) {
    throw new Error(
      `clip has ${Math.max(0, usable).toFixed(2)} s left after trim_start_sec=${o.trimStart} (source is ${o.sourceDuration.toFixed(2)} s at ${o.playbackRate}x); need at least ${MIN_CLIP_SEGMENT_SEC} s`,
    );
  }
  const segments: ClipSegment[] = [];
  const end = o.beatStart + o.beatDuration;
  for (let start = o.beatStart; start < end - 1e-6; start += usable) {
    segments.push({ start: round6(start), duration: round6(Math.min(usable, end - start)), mediaStart: o.trimStart });
  }
  return segments;
}

export interface LanePoint {
  t: number;
  v: number;
}

/**
 * Music volume envelope for `data-automation` (linear gain, `t` in seconds from the music element's
 * start, which is composition time 0). `v` already includes `gain_db`, so the element's own
 * `data-volume` stays 1 and the lane is the whole story.
 *
 * With `duck` on, the bed sits at `gain_db + duck_db` while the VO speaks and rises to `gain_db`
 * in the pauses. Words closer together than attack+release are merged into one spoken stretch so the
 * bed doesn't pump between words; releases are slower than attacks on purpose (music that snaps back
 * the instant a word ends sounds mechanical). Either way the bed fades to silence over the last
 * `audio.tail_sec` so it never cuts off at the end of the file.
 */
export function musicLane(
  words: { start: number; end: number }[],
  durationSec: number,
  music: { gain_db: number; duck_under_vo: boolean },
  tokens: Tokens,
): LanePoint[] {
  const { music_duck_db, music_duck_attack_sec: attack, music_duck_release_sec: release, tail_sec } = tokens.audio;
  const bed = 10 ** (music.gain_db / 20);
  const ducked = 10 ** ((music.gain_db + music_duck_db) / 20);

  const raw: LanePoint[] = [];
  if (music.duck_under_vo && words.length) {
    const spans: { start: number; end: number }[] = [];
    for (const w of words) {
      const last = spans.at(-1);
      if (last && w.start - last.end < attack + release) last.end = Math.max(last.end, w.end);
      else spans.push({ start: w.start, end: w.end });
    }
    spans.forEach((s, i) => {
      if (i === 0 && s.start - attack > 0) raw.push({ t: 0, v: bed });
      if (s.start - attack > 0) raw.push({ t: s.start - attack, v: bed });
      raw.push({ t: Math.max(0, s.start), v: ducked }, { t: s.end, v: ducked });
      const next = spans[i + 1];
      if (next) raw.push({ t: s.end + release, v: bed });
    });
  } else {
    raw.push({ t: 0, v: bed });
  }

  // Keep only strictly increasing times (equal-time points from touching ramps collapse to the first),
  // then cut the lane at the fade-out start and finish it with the fade.
  const points: LanePoint[] = [];
  for (const p of raw) if (!points.length || p.t > points.at(-1)!.t) points.push(p);
  const fadeStart = Math.max(0, durationSec - tail_sec);
  const valueAt = (t: number): number => {
    if (t <= points[0].t) return points[0].v;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        const a = points[i - 1];
        const b = points[i];
        return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
      }
    }
    return points.at(-1)!.v;
  };
  const lane = points.filter((p) => p.t < fadeStart);
  lane.push({ t: fadeStart, v: valueAt(fadeStart) }, { t: durationSec, v: 0 });
  return lane.map((p) => ({ t: round6(p.t), v: round6(p.v) }));
}

/** Duration of a media file in seconds, via ffprobe. */
export function probeDuration(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const sec = Number.parseFloat(out);
  if (!Number.isFinite(sec)) throw new Error(`could not read the duration of ${file}`);
  return sec;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

/**
 * The static `<video>` (clip beats) and `<audio>` (music) elements for the composition. They have to be
 * in the HTML text, not built by the page script: the renderer extracts media from the authored markup
 * before any script runs (a runtime-set `src` plays in preview but can diverge from what is muxed).
 * `assetsDir` is the folder the referenced files live in (the repo's `assets/`, or the per-render copy).
 */
export function buildMediaHtml(timeline: Timeline, tokens: Tokens, assetsDir: string): string {
  const parts: string[] = [];
  let n = 0;
  for (const beat of timeline.beats) {
    if (beat.visual.type !== 'clip') continue;
    const v = beat.visual;
    const rate = v.playback_rate ?? 1;
    const segments = clipSegments({
      beatStart: beat.start,
      beatDuration: beat.end - beat.start,
      sourceDuration: probeDuration(join(assetsDir, v.asset)),
      trimStart: v.trim_start_sec ?? 0,
      playbackRate: rate,
    });
    for (const seg of segments) {
      // Cover-fit + muted; the audio (if any) of a clip never plays. No timed wrapper around the
      // <video>: timing lives on the media element itself (core rule video_nested_in_timed_element).
      parts.push(
        `<video id="clip-${n++}" class="cover-video" src="assets/${esc(encodeURI(v.asset))}" muted playsinline` +
          ` data-start="${seg.start}" data-duration="${seg.duration}" data-track-index="0"` +
          ` data-media-start="${seg.mediaStart}" data-playback-rate="${rate}"></video>`,
      );
    }
  }
  const music = timeline.audio.music;
  if (music) {
    const file = music.file.replace(/^assets\//, '');
    const length = probeDuration(join(assetsDir, file));
    if (length < timeline.duration_sec) {
      throw new Error(
        `music file ${music.file} is ${length.toFixed(1)} s but the video is ${timeline.duration_sec.toFixed(1)} s; the bed must cover the whole video`,
      );
    }
    const lane = musicLane(timeline.words, timeline.duration_sec, music, tokens);
    const automation = JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: lane }] });
    parts.push(
      `<audio id="music" src="assets/${esc(encodeURI(file))}" data-start="0" data-duration="${timeline.duration_sec}"` +
        ` data-track-index="8" data-volume="1" data-automation='${automation}'></audio>`,
    );
  }
  return parts.join('\n      ');
}

/**
 * Alpha of the darkening band behind text, from the average luma (0-1, gamma-encoded) of the picture
 * behind it: `darken_behind_text` over black, ramping linearly to `darken_behind_text_max` at
 * `darken_bright_luma` and above. The ramp saturates before white on purpose: the muted series label
 * needs about 0.8 black over a bright frame to reach 4.5:1, so a ramp that only reaches the ceiling
 * at pure white would leave it short across most bright photos.
 */
export function darkenAlpha(luma: number, tokens: Tokens): number {
  const { darken_behind_text: lo, darken_behind_text_max: hi, darken_bright_luma: bright } = tokens.grade;
  return lo + (hi - lo) * Math.min(1, Math.max(0, luma) / bright);
}

/** Mean luma of one grayscale row profile over the rows a band covers (`rows` spans the full canvas height). */
export function bandLuma(rows: number[], band: { y: number; h: number }, canvasHeight: number): number {
  const i0 = Math.max(0, Math.floor((band.y / canvasHeight) * rows.length));
  const i1 = Math.min(rows.length, Math.max(i0 + 1, Math.ceil(((band.y + band.h) / canvasHeight) * rows.length)));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += rows[i];
  return sum / (i1 - i0);
}

const SAMPLE_W = 270; // sampled at a quarter of the canvas; a row average doesn't need more
const CLIP_SAMPLES = 3;

/**
 * Per still/clip beat, the mean luma (0-1) of each row of its cover-fitted background, sampled from the
 * real pixels with ffmpeg: a still once, a clip at a few points across its usable length (averaged).
 * Sampled at rest, so a push/pan's few percent of drift isn't modeled. Solid/typography beats have no
 * entry (darkening only applies on still/clip, SPEC section 6).
 */
export function sampleRowLuma(assetsDir: string, timeline: Timeline, tokens: Tokens): Record<string, number[]> {
  const h = Math.round((SAMPLE_W * tokens.canvas.height) / tokens.canvas.width);
  const frame = (file: string, at: number): number[] => {
    const raw = execFileSync(
      'ffmpeg',
      ['-v', 'error', ...(at > 0 ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1',
       '-vf', `scale=${SAMPLE_W}:${h}:force_original_aspect_ratio=increase,crop=${SAMPLE_W}:${h},format=gray`,
       '-f', 'rawvideo', '-'],
      { maxBuffer: SAMPLE_W * h * 2 },
    );
    if (raw.length !== SAMPLE_W * h) throw new Error(`could not sample ${file} at ${at}s`);
    const rows: number[] = [];
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = 0; x < SAMPLE_W; x++) sum += raw[y * SAMPLE_W + x];
      rows.push(sum / SAMPLE_W / 255);
    }
    return rows;
  };
  const out: Record<string, number[]> = {};
  for (const beat of timeline.beats) {
    const v = beat.visual;
    if (v.type === 'still') out[beat.id] = frame(join(assetsDir, v.asset), 0);
    else if (v.type === 'clip') {
      const file = join(assetsDir, v.asset);
      const trim = v.trim_start_sec ?? 0;
      const usable = probeDuration(file) - trim;
      const frames = Array.from({ length: CLIP_SAMPLES }, (_, k) => frame(file, trim + (usable * (k + 0.5)) / CLIP_SAMPLES));
      out[beat.id] = frames[0].map((_, i) => frames.reduce((n, f) => n + f[i], 0) / frames.length);
    }
  }
  return out;
}
