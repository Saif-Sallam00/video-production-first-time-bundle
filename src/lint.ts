import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  ctaOverlayConflicts,
  ctaStyle,
  overlayStyle,
  plainStyle,
  safeRect,
  textBlock,
  type BlockStyle,
} from './layout.ts';
import { findPhrase, normalizeWord, type TextMeasure } from './text.ts';
import type { Issue, Tokens, VideoSpec } from './types.ts';

export interface LintContext {
  tokens: Tokens;
  /** Absolute path of the assets/ folder. */
  assetsDir: string;
  measure: TextMeasure;
}

const CTA_LATE_SEC = 5.0;
const CTA_DEFAULT_DURATION_SEC = 2.5; // schema default for cta_pop.duration_sec
const VO_LONG_CHARS = 1100;
// Section 9: ~1,100 characters is roughly 70 s. Places beats and the CTA in time until real TTS
// timings exist (they come from the timeline step).
export const EST_CHARS_PER_SEC = VO_LONG_CHARS / 70;
const BATCH_REPEAT_LIMIT = 3;
const CAPTIONS_HIDDEN_OVERLAP_MIN = 0.5;

export const fullVo = (spec: VideoSpec) => spec.beats.map((b) => b.vo).join(' ');

/** Lint rules from SPEC section 9 for one spec. Assumes the spec already passed the schema. */
export function lintSpec(spec: VideoSpec, ctx: LintContext): Issue[] {
  const issues: Issue[] = [];
  const error = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  // Beat ids unique, at most one hook beat.
  const seen = new Set<string>();
  spec.beats.forEach((b, i) => {
    if (seen.has(b.id)) error(`/beats/${i}/id`, `duplicate beat id "${b.id}"`);
    seen.add(b.id);
  });
  const hooks = spec.beats.flatMap((b, i) => (b.role === 'hook' ? [i] : []));
  for (const i of hooks.slice(1)) {
    error(`/beats/${i}/role`, `more than one hook beat (beats ${hooks.join(', ')})`);
  }

  // Estimated timing: each beat starts at its character offset in the full VO.
  const cps = EST_CHARS_PER_SEC * (spec.voice?.speed ?? 1);
  const beatStarts: number[] = [];
  spec.beats.reduce((offset, b) => (beatStarts.push(offset / cps), offset + b.vo.length + 1), 0);
  const beatTimes = beatStarts.map((start, i) => ({
    start,
    end: beatStarts[i + 1] ?? fullVo(spec).length / cps + ctx.tokens.audio.tail_sec,
  }));

  // CTA pop anchor, when it lands, and what it collides with.
  if (spec.cta_pop) {
    const start = spec.cta_pop.start;
    let ctaStart: number | undefined;
    if ('at_sec' in start) {
      ctaStart = start.at_sec;
      if (ctaStart > CTA_LATE_SEC) {
        warn('/cta_pop/start/at_sec', `CTA pop starts at ${ctaStart} s, later than ${CTA_LATE_SEC.toFixed(1)} s`);
      }
    } else {
      const k = spec.beats.findIndex((b) => b.id === start.beat_id);
      const match = k >= 0 ? findPhrase(spec.beats[k].vo, start.phrase) : null;
      if (k < 0) {
        error('/cta_pop/start/beat_id', `no beat with id "${start.beat_id}"`);
      } else if (!match) {
        error('/cta_pop/start/phrase', `"${start.phrase}" not found in the vo of beat "${start.beat_id}"`);
      } else {
        ctaStart = beatStarts[k] + match.charOffset / cps;
        if (ctaStart > CTA_LATE_SEC) {
          warn(
            '/cta_pop/start',
            `CTA pop starts at ~${ctaStart.toFixed(1)} s (estimated from its position in the VO), later than ${CTA_LATE_SEC.toFixed(1)} s`,
          );
        }
      }
    }
    if (ctaStart !== undefined) {
      const cta = { start: ctaStart, end: ctaStart + (spec.cta_pop.duration_sec ?? CTA_DEFAULT_DURATION_SEC) };
      for (const i of ctaOverlayConflicts(spec, beatTimes, cta, ctx.tokens, ctx.measure)) {
        error(`/beats/${i}/overlay`, `overlay box overlaps the CTA pop box while both are on screen`);
      }
    }
  }

  // Assets and color tokens.
  const checkAsset = (path: string, file: string) => {
    const abs = resolve(ctx.assetsDir, file);
    if (!abs.startsWith(ctx.assetsDir + sep)) error(path, `"${file}" points outside assets/`);
    else if (!existsSync(abs) || !statSync(abs).isFile()) error(path, `asset not found: assets/${file}`);
  };
  spec.beats.forEach((b, i) => {
    const v = b.visual;
    if (v.type === 'still' || v.type === 'clip') checkAsset(`/beats/${i}/visual/asset`, v.asset);
    if ((v.type === 'solid' || v.type === 'typography') && v.color !== undefined) {
      if (!Object.hasOwn(ctx.tokens.colors, v.color)) {
        error(`/beats/${i}/visual/color`, `"${v.color}" is not a color in tokens.colors`);
      }
    }
  });
  if (spec.music) checkAsset('/music/file', spec.music.file);

  // captions_hidden assumes the beat's own on-screen text already carries the VO's words. Warn when
  // it mostly doesn't — the beat would then just go unspoken-and-uncaptioned instead.
  spec.beats.forEach((b, i) => {
    if (!b.captions_hidden) return;
    const onScreenText = [b.visual.type === 'typography' ? b.visual.text : null, b.overlay?.text ?? null]
      .filter((t): t is string => t !== null)
      .join(' ');
    const onScreenWords = new Set(onScreenText.split(/\s+/).map(normalizeWord).filter(Boolean));
    if (onScreenWords.size === 0) return;
    const voWords = new Set(b.vo.split(/\s+/).map(normalizeWord).filter(Boolean));
    const shared = [...onScreenWords].filter((w) => voWords.has(w)).length;
    const overlap = shared / onScreenWords.size;
    if (overlap < CAPTIONS_HIDDEN_OVERLAP_MIN) {
      warn(
        `/beats/${i}/captions_hidden`,
        `captions are hidden, but its on-screen text shares only ${Math.round(overlap * 100)}% of its words with the beat's vo`,
      );
    }
  });

  lintTextBoxes(spec, ctx, error);

  const voChars = fullVo(spec).length;
  if (voChars > VO_LONG_CHARS) {
    warn('/beats', `full VO is ${voChars} characters (over ~${VO_LONG_CHARS}, roughly 70 s)`);
  }

  // Every voice preset is a TTS provider, so every voiceover is AI-generated.
  if (spec.disclosure?.ai_generated_label === false) {
    warn('/disclosure/ai_generated_label', 'is false, but the voiceover is AI-generated (TTS)');
  }

  return issues;
}

/** Every text box, padding included, must fit inside the safe zone at its token size, measured with the real font. */
function lintTextBoxes(spec: VideoSpec, ctx: LintContext, error: (path: string, message: string) => void) {
  const { tokens, measure } = ctx;
  const size = tokens.type_scale;
  const safe = safeRect(tokens);

  const fit = (path: string, text: string, style: BlockStyle) => {
    const block = textBlock(text, style, tokens, measure);
    const width = (s: string) => Math.round(measure.width(s, style.role, style.px));
    const padH = style.padding[1];
    const limit = padH ? `${safe.w - 2 * padH} px (safe width minus padding)` : `${safe.w} px (safe width)`;
    if (block.overflow) {
      error(path, `"${block.overflow}" is ${width(block.overflow)} px wide at ${style.px} px; max is ${limit}`);
    } else if (block.lines.length > style.maxLines) {
      const shown = style.uppercase ? text.toUpperCase() : text;
      error(
        path,
        style.maxLines === 1
          ? `doesn't fit on one line at ${style.px} px (${width(shown)} px; max is ${limit})`
          : `wraps to ${block.lines.length} lines at ${style.px} px; max is ${style.maxLines}`,
      );
    } else if (block.h > safe.h) {
      error(path, `is ${Math.round(block.h)} px tall at ${style.px} px; safe height is ${safe.h} px`);
    }
  };

  if (spec.series?.label) fit('/series/label', spec.series.label, plainStyle('body', size.label, 1));

  const captionsOn = spec.captions?.enabled !== false;
  spec.beats.forEach((b, i) => {
    if (b.overlay) fit(`/beats/${i}/overlay/text`, b.overlay.text, overlayStyle(b.overlay, tokens));

    const v = b.visual;
    if (v.type === 'typography') {
      fit(
        `/beats/${i}/visual/text`,
        v.text,
        v.style === 'number'
          ? plainStyle('display', size.typography_number, 1)
          : plainStyle('display', size.typography_statement, 3),
      );
    }

    // Captions never split a word, so every spoken word must fit on a line by itself.
    if (captionsOn) {
      for (const word of b.vo.split(/\s+/).filter(Boolean)) {
        fit(`/beats/${i}/vo`, word, plainStyle('body', size.caption, 1));
      }
    }
  });

  if (spec.cta_pop) fit('/cta_pop/text', spec.cta_pop.text, ctaStyle(spec.cta_pop, tokens));
  if (spec.end_card?.enabled && spec.end_card.text) {
    fit('/end_card/text', spec.end_card.text, plainStyle('display', size.typography_statement, 2));
  }
}

/**
 * Dir-mode check: 3+ consecutive specs sharing the same first-beat overlay style and first-beat
 * visual type. `entries` must be in run order.
 */
export function lintBatch(entries: { file: string; spec: VideoSpec }[]): Issue[] {
  const signature = ({ spec }: { spec: VideoSpec }) => {
    const first = spec.beats[0];
    const overlay = first.overlay ? `${first.overlay.style ?? 'card'} overlay` : 'no overlay';
    return `${overlay} on ${first.visual.type}`;
  };
  const issues: Issue[] = [];
  let runStart = 0;
  for (let i = 1; i <= entries.length; i++) {
    if (i < entries.length && signature(entries[i]) === signature(entries[runStart])) continue;
    if (i - runStart >= BATCH_REPEAT_LIMIT) {
      const files = entries.slice(runStart, i).map((e) => e.file);
      issues.push({
        level: 'warning',
        path: '',
        message: `${files.length} consecutive specs open the same way (${signature(entries[runStart])}): ${files.join(', ')}`,
      });
    }
    runStart = i;
  }
  return issues;
}
