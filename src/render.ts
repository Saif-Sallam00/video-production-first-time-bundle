import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  captionBox,
  ctaBox,
  ctaStyle,
  overlayBox,
  overlayStyle,
  plainStyle,
  safeRect,
  scrimBands,
  textBlock,
  type Box,
  type LayoutSpec,
} from './layout.ts';
import { bandLuma, buildMediaHtml, darkenAlpha, sampleRowLuma, stillMotion, type StillPose } from './media.ts';
import type { TextMeasure } from './text.ts';
import type { Timeline } from './timeline.ts';
import type { Tokens } from './types.ts';

// Pinned so the same repo always renders with the same HyperFrames build (SPEC principle 4:
// deterministic). Bump deliberately, not implicitly via `@latest`.
const HYPERFRAMES_VERSION = '0.8.88';

// How far the browser's actual caption line width may drift from layout.ts's fontkit-based prediction
// before the render is refused (SPEC section 6/7) — catches future measure/render drift (e.g. a CSS
// change that reintroduces flex gap instead of real space characters).
const CAPTION_WIDTH_TOLERANCE = 0.03;

export interface TextBox {
  box: Box;
  lines: string[];
}

export interface RenderLayout {
  safe: Box;
  label: TextBox | null;
  overlays: Record<string, TextBox>;
  typography: Record<string, TextBox>;
  captions: Box | null;
  /** Predicted pixel width of every caption line, indexed like `timeline.caption_pages[i].lines[j]` — the render-time DOM-width guard compares these to what the browser actually lays out (see `validateCaptionLineWidths`). */
  captionLineWidths: number[][];
  /** Per still/clip beat id: the bands to darken behind its series label, overlay and captions (see `scrimBands`), each with the alpha its picture calls for (see `darkenAlpha`). */
  scrims: Record<string, { y: number; h: number; alpha: number }[]>;
  /** Per still beat id: the start and end pose of its (linear, full-beat) move. */
  stills: Record<string, { from: StillPose; to: StillPose }>;
  cta: TextBox | null;
  end_card: TextBox | null;
}

/**
 * Every text box the composition needs, computed once in Node (where `measure` reads the real font
 * files) so the lint, the render and the QA gates all agree on where text sits (SPEC section 6).
 */
export function computeLayout(
  timeline: Timeline,
  tokens: Tokens,
  measure: TextMeasure,
  /** Per still/clip beat id: mean luma of each row of its background (`sampleRowLuma`). Absent = treated as dark. */
  rowLuma: Record<string, number[]> = {},
): RenderLayout {
  const shim: LayoutSpec = {
    series: timeline.label ? { label: timeline.label } : undefined,
    captions: { enabled: timeline.caption_style !== null },
  };
  const safe = safeRect(tokens);
  const centered = (w: number, h: number): Box => ({ x: safe.x + (safe.w - w) / 2, y: safe.y + (safe.h - h) / 2, w, h });

  const label: TextBox | null = timeline.label
    ? (() => {
        const { lines, w, h } = textBlock(timeline.label!, plainStyle('body', tokens.type_scale.label, 1), tokens, measure);
        return { lines, box: { x: safe.x + (safe.w - w) / 2, y: safe.y, w, h } };
      })()
    : null;

  const overlays: Record<string, TextBox> = {};
  for (const beat of timeline.beats) {
    if (!beat.overlay) continue;
    const { lines } = textBlock(beat.overlay.text, overlayStyle(beat.overlay, tokens), tokens, measure);
    overlays[beat.id] = { lines, box: overlayBox(shim, beat.overlay, tokens, measure) };
  }

  const typography: Record<string, TextBox> = {};
  for (const beat of timeline.beats) {
    if (beat.visual.type !== 'typography') continue;
    const isNumber = beat.visual.style === 'number';
    const size = isNumber ? tokens.type_scale.typography_number : tokens.type_scale.typography_statement;
    const { lines, w, h } = textBlock(beat.visual.text, plainStyle('display', size, isNumber ? 1 : 3), tokens, measure);
    typography[beat.id] = { lines, box: centered(w, h) };
  }

  const captions = captionBox(shim, tokens);
  const captionLineWidths = timeline.caption_pages.map((page) =>
    page.lines.map((line) => measure.width(line.join(' '), 'body', tokens.type_scale.caption)),
  );

  const cta: TextBox | null = timeline.cta_pop
    ? (() => {
        const c = timeline.cta_pop!;
        const { lines } = textBlock(c.text, ctaStyle(c, tokens), tokens, measure);
        return { lines, box: ctaBox(shim, c, tokens, measure) };
      })()
    : null;

  const end_card: TextBox | null = timeline.end_card
    ? (() => {
        const { lines, w, h } = textBlock(timeline.end_card!.text, plainStyle('display', tokens.type_scale.typography_statement, 2), tokens, measure);
        return { lines, box: centered(w, h) };
      })()
    : null;

  // Grade layer (SPEC section 6): extra darkening only where text sits on a still/clip. The series label
  // is on screen for the whole video; captions count for a beat only if some caption page is on screen
  // during it (captions_hidden beats have none). Each band's strength follows the average luma of the
  // picture behind it.
  const scrims: Record<string, { y: number; h: number; alpha: number }[]> = {};
  for (const beat of timeline.beats) {
    if (beat.visual.type !== 'still' && beat.visual.type !== 'clip') continue;
    const boxes: Box[] = [];
    if (label) boxes.push(label.box);
    if (overlays[beat.id]) boxes.push(overlays[beat.id].box);
    if (captions && timeline.caption_pages.some((p) => p.start < beat.end && p.end > beat.start)) boxes.push(captions);
    if (!boxes.length) continue;
    const rows = rowLuma[beat.id];
    scrims[beat.id] = scrimBands(boxes, tokens.grade.darken_feather_px, tokens.canvas.height).map((band) => ({
      ...band,
      alpha: darkenAlpha(rows ? bandLuma(rows, band, tokens.canvas.height) : 0, tokens),
    }));
  }

  const stills: Record<string, { from: StillPose; to: StillPose }> = {};
  for (const beat of timeline.beats) if (beat.visual.type === 'still') stills[beat.id] = stillMotion(beat.visual.motion, tokens);

  return { safe, label, overlays, typography, captions, captionLineWidths, scrims, stills, cta, end_card };
}

/**
 * Render-time guard (SPEC section 6/7): loads the composition in a real browser and compares each
 * caption line's actual DOM width to `layout.captionLineWidths`' fontkit-based prediction, refusing the
 * render if any line drifts by more than `CAPTION_WIDTH_TOLERANCE`. Catches any future divergence
 * between what `text.ts`/`breaker.ts` measure and what the browser actually lays out (e.g. a CSS change
 * back to flex gap instead of real space characters between word spans).
 */
async function validateCaptionLineWidths(indexFile: string, variables: object, predicted: number[][]): Promise<void> {
  const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    // A string, not a function reference: esbuild/tsx can wrap a closure passed here in a `__name(...)`
    // helper call (to preserve `Function.prototype.name`) that doesn't exist once Puppeteer serializes
    // the function into the page's own context, so the shim silently failed to install. Building the
    // script text ourselves sidesteps that function-serialization path entirely.
    await page.evaluateOnNewDocument(
      `window.__hyperframes = { getVariables: function () { return ${JSON.stringify(variables)}; } };` +
        `window.__timelines = {};`,
    );
    await page.goto(`file://${indexFile}`, { waitUntil: 'load' });
    // 'load' doesn't wait for @font-face downloads; measuring before Inter is ready would compare
    // against a fallback font's (narrower) metrics instead of the one `breaker.ts` measured with.
    await page.evaluate(() => document.fonts.ready);
    const actual = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.caption-box')).map((box) =>
        Array.from(box.querySelectorAll('.line')).map((line) => line.getBoundingClientRect().width),
      ),
    );

    const mismatches: string[] = [];
    predicted.forEach((pageWidths, pi) => {
      pageWidths.forEach((expected, li) => {
        const got = actual[pi]?.[li];
        if (got === undefined) {
          mismatches.push(`page ${pi} line ${li}: no matching DOM line`);
          return;
        }
        const diff = Math.abs(got - expected) / expected;
        if (diff > CAPTION_WIDTH_TOLERANCE) {
          mismatches.push(`page ${pi} line ${li}: predicted ${expected.toFixed(1)}px, DOM measured ${got.toFixed(1)}px (${(diff * 100).toFixed(1)}% off)`);
        }
      });
    });
    if (mismatches.length) {
      throw new Error(`caption line width drifted from the layout.ts prediction by more than ${CAPTION_WIDTH_TOLERANCE * 100}%:\n  ${mismatches.join('\n  ')}`);
    }
  } finally {
    await browser.close();
  }
}

/** Every still/clip asset and the music file the timeline references, as paths relative to `assets/`. */
function referencedAssets(timeline: Timeline): string[] {
  const files = new Set<string>();
  for (const beat of timeline.beats) if (beat.visual.type === 'still' || beat.visual.type === 'clip') files.add(beat.visual.asset);
  if (timeline.audio.music) files.add(timeline.audio.music.file.replace(/^assets\//, ''));
  return [...files];
}

/**
 * Builds the per-render working copy of `templates/` that HyperFrames renders: the root and audio
 * elements' data-duration are resolved statically from the source text before any script runs, so
 * the real duration has to be templated in rather than set from JS. The VO audio (in cache/tts/) and
 * every referenced asset also have to be physically inside the composition's project root to be
 * servable, so they are copied in too. The caller owns (and must delete) `work`.
 */
export function prepareWork(root: string, timeline: Timeline, tokens: Tokens, measure: TextMeasure) {
  const layout = computeLayout(timeline, tokens, measure, sampleRowLuma(join(root, 'assets'), timeline, tokens));
  const variables = { timeline, tokens, layout, voAudioSrc: 'render-audio.wav' };
  const work = mkdtempSync(join(tmpdir(), 'ttyng-render-'));
  cpSync(join(root, 'templates'), work, { recursive: true });
  const indexFile = join(work, 'index.html');
  const html = readFileSync(indexFile, 'utf8')
    .replaceAll('{{DURATION_SEC}}', String(timeline.duration_sec))
    .replace('{{MEDIA_ELEMENTS}}', () => buildMediaHtml(timeline, tokens, join(root, 'assets')));
  writeFileSync(indexFile, html);
  copyFileSync(join(root, timeline.audio.vo), join(work, 'render-audio.wav'));
  for (const file of referencedAssets(timeline)) {
    const dest = join(work, 'assets', file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, 'assets', file), dest);
  }
  const varsFile = join(work, 'render-vars.json');
  writeFileSync(varsFile, JSON.stringify(variables));
  return { work, indexFile, varsFile, variables, layout };
}

/**
 * SPEC `studio render`: renders `templates/` (the one HyperFrames composition) against `timeline.json`
 * + `tokens.json` + the computed layout, to `out/<id>/<id>.mp4`.
 */
export async function render(root: string, timeline: Timeline, tokens: Tokens, measure: TextMeasure): Promise<string> {
  const outDir = join(root, 'out', timeline.id);
  mkdirSync(outDir, { recursive: true });

  const { work, indexFile, varsFile, variables, layout } = prepareWork(root, timeline, tokens, measure);
  try {
    await validateCaptionLineWidths(indexFile, variables, layout.captionLineWidths);

    const output = join(outDir, `${timeline.id}.mp4`);
    execFileSync(
      'npx',
      [
        '--yes',
        `hyperframes@${HYPERFRAMES_VERSION}`,
        'render',
        work,
        '--variables-file',
        varsFile,
        '--output',
        output,
        '--fps',
        String(tokens.canvas.fps),
      ],
      { stdio: 'inherit' },
    );
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
