import { wrap, type FontRole, type TextMeasure } from './text.ts';
import type { CtaPop, Overlay, Tokens, VideoSpec } from './types.ts';

// Where every text box sits on the canvas (SPEC section 6, "Layout"). The fit lint, the overlap lint
// and the templates all use these boxes, so they can't disagree.

/** What `frame()` needs from a spec. A `VideoSpec` satisfies this; so does a `Timeline` shim. */
export interface LayoutSpec {
  series?: { label?: string };
  captions?: { enabled?: boolean };
}

/** What `ctaBox`/`ctaStyle` need from a CTA pop. A `CtaPop` satisfies this; so does a `TimelineCta`. */
export type CtaLike = Pick<CtaPop, 'text' | 'style'>;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockStyle {
  role: FontRole;
  px: number;
  maxLines: number;
  /** [vertical, horizontal] px around the text */
  padding: [number, number];
  uppercase?: boolean;
}

export interface TextBlock {
  lines: string[];
  /** First word wider than the available text width on its own; `lines` is incomplete when set. */
  overflow?: string;
  /** Size including padding. */
  w: number;
  h: number;
}

export const plainStyle = (role: FontRole, px: number, maxLines: number): BlockStyle => ({
  role,
  px,
  maxLines,
  padding: [0, 0],
});

export function overlayStyle(overlay: Overlay, tokens: Tokens): BlockStyle {
  const size = tokens.type_scale;
  switch (overlay.style ?? 'card') {
    case 'hook_slam':
      return plainStyle('display', size.hook_slam, 4);
    case 'card':
      return { role: 'body', px: size.card, maxLines: 3, padding: tokens.padding.card };
    case 'kicker':
      return { ...plainStyle('body', size.kicker, 1), uppercase: true };
  }
}

export function ctaStyle(cta: CtaLike, tokens: Tokens): BlockStyle {
  const [padV, padH] = tokens.padding.pill;
  // The bar spans the full canvas width, so only its text has to stay inside the safe width.
  return { role: 'body', px: tokens.type_scale.cta, maxLines: 1, padding: cta.style === 'bar' ? [padV, 0] : [padV, padH] };
}

export function safeRect(tokens: Tokens): Box {
  const { canvas, safe_zone: s } = tokens;
  return { x: s.left, y: s.top, w: canvas.width - s.left - s.right, h: canvas.height - s.top - s.bottom };
}

/** Wraps `text` to the safe width minus horizontal padding, using the token line height. */
export function textBlock(text: string, style: BlockStyle, tokens: Tokens, measure: TextMeasure): TextBlock {
  const [padV, padH] = style.padding;
  const width = (s: string) => measure.width(s, style.role, style.px);
  const { lines, overflow } = wrap(
    style.uppercase ? text.toUpperCase() : text,
    safeRect(tokens).w - 2 * padH,
    width,
    style.maxLines,
  );
  return {
    lines,
    overflow,
    w: Math.max(0, ...lines.map(width)) + 2 * padH,
    h: lines.length * tokens.line_height[style.role] * style.px + 2 * padV,
  };
}

/** The bands every beat shares: the safe zone, the bottom of the series label, and the caption block. */
function frame(spec: LayoutSpec, tokens: Tokens) {
  const safe = safeRect(tokens);
  const labelBottom = spec.series?.label ? safe.y + tokens.line_height.body * tokens.type_scale.label : safe.y;
  const captionH = tokens.caption.max_lines * tokens.line_height.body * tokens.type_scale.caption;
  const captions: Box | null =
    spec.captions?.enabled === false
      ? null
      : { x: safe.x, y: tokens.caption.center_y - captionH / 2, w: safe.w, h: captionH };
  return { safe, labelBottom, captions };
}

/** The caption block: `max_lines` lines centered on `caption.center_y`, safe width. Null when captions are off. */
export const captionBox = (spec: LayoutSpec, tokens: Tokens) => frame(spec, tokens).captions;

/**
 * upper: directly under the label. center: centered between the label and the captions (so it stays
 * in the upper half), or on the canvas center when captions are off.
 */
export function overlayBox(spec: LayoutSpec, overlay: Overlay, tokens: Tokens, measure: TextMeasure): Box {
  const { safe, labelBottom, captions } = frame(spec, tokens);
  const { w, h } = textBlock(overlay.text, overlayStyle(overlay, tokens), tokens, measure);
  const x = safe.x + (safe.w - w) / 2;
  if ((overlay.position ?? 'upper') === 'upper') return { x, y: labelBottom, w, h };
  const y = captions
    ? (labelBottom + captions.y - h) / 2
    : Math.max(labelBottom, Math.min(tokens.canvas.height / 2 - h / 2, safe.y + safe.h - h));
  return { x, y, w, h };
}

/**
 * pill: centered, directly under the caption block (so it never covers the active caption line), or
 * on `caption.center_y` when captions are off. bar: full canvas width at the top of the safe zone.
 */
export function ctaBox(spec: LayoutSpec, cta: CtaLike, tokens: Tokens, measure: TextMeasure): Box {
  const { safe, captions } = frame(spec, tokens);
  const { w, h } = textBlock(cta.text, ctaStyle(cta, tokens), tokens, measure);
  if (cta.style === 'bar') return { x: 0, y: safe.y, w: tokens.canvas.width, h };
  const y = captions ? captions.y + captions.h : tokens.caption.center_y - h / 2;
  return { x: safe.x + (safe.w - w) / 2, y, w, h };
}

/** True when the boxes share area; touching edges don't count. */
export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Indexes of beats whose overlay box overlaps the CTA pop box while both are on screen. Takes the
 * timings as input so it runs on estimates at validate time and on TTS timings in the timeline.
 */
export function ctaOverlayConflicts(
  spec: VideoSpec,
  beats: { start: number; end: number }[],
  cta: { start: number; end: number },
  tokens: Tokens,
  measure: TextMeasure,
): number[] {
  if (!spec.cta_pop) return [];
  const box = ctaBox(spec, spec.cta_pop, tokens, measure);
  return spec.beats.flatMap((b, i) =>
    b.overlay &&
    beats[i].start < cta.end &&
    cta.start < beats[i].end &&
    overlaps(box, overlayBox(spec, b.overlay, tokens, measure))
      ? [i]
      : [],
  );
}
