import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendLibrary, readLibrary } from './assets/library.ts';
import { probeSize } from './assets/run.ts';
import type { Beat, VideoSpec } from './types.ts';

const STYLE_START = '<!-- STYLE-BLOCK-START -->';
const STYLE_END = '<!-- STYLE-BLOCK-END -->';
const BANNED_START = '<!-- BANNED-WORDS-START -->';
const BANNED_END = '<!-- BANNED-WORDS-END -->';
const SUBJECT_LINE =
  'The subject must be exactly one of: a single figure, a brain, a heart, hands, an object, or a symbol.';
const INPUT_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const MIN_WIDTH = 1024;
const ASPECT_TOLERANCE = 0.03; // relative, around 2:3 and 9:16

/** Beats that get a generated image: the ones with an image_prompt. */
export const generatedBeats = (spec: VideoSpec): (Beat & { image_prompt: string })[] =>
  spec.beats.filter((b): b is Beat & { image_prompt: string } => !!b.image_prompt);

/** Where the image for a beat is saved before ingest, relative to the project root. */
export const generatedPath = (spec: VideoSpec, beatId: string) => `assets/generated/${spec.id}/${beatId}.png`;
/** The file the user actually saved for a beat: .png first, then .jpg, .jpeg, .webp. */
const findInput = (root: string, spec: VideoSpec, beatId: string) =>
  INPUT_EXTS.map((e) => generatedPath(spec, beatId).replace(/\.png$/, `.${e}`)).find((f) => existsSync(join(root, f)));
const stillPath = (spec: VideoSpec, beatId: string) => `stills/gen-${spec.id}-${beatId}.jpg`;

/** The style block from brand/image-style.md; throws if it is missing or still the TODO placeholder. */
export function readStyleBlock(root: string): string {
  const text = readFileSync(join(root, 'brand', 'image-style.md'), 'utf8');
  const start = text.indexOf(STYLE_START);
  const end = text.indexOf(STYLE_END);
  if (start < 0 || end < start) throw new Error(`brand/image-style.md needs ${STYLE_START} ... ${STYLE_END} around the style block`);
  const block = text.slice(start + STYLE_START.length, end).trim();
  if (!block || /^TODO\b/.test(block)) throw new Error('brand/image-style.md: the style block is still empty/TODO; paste it in first');
  return block;
}

/** The banned words from brand/image-style.md (comma- or line-separated between the markers). */
export function readBannedWords(root: string): string[] {
  const text = readFileSync(join(root, 'brand', 'image-style.md'), 'utf8');
  const start = text.indexOf(BANNED_START);
  const end = text.indexOf(BANNED_END);
  if (start < 0 || end < start) throw new Error(`brand/image-style.md needs ${BANNED_START} ... ${BANNED_END} around the banned words`);
  return text.slice(start + BANNED_START.length, end).split(/[\s,]+/).filter(Boolean).map((w) => w.toLowerCase());
}

/** `studio prompts`: writes out/<id>/image-prompts.md and returns its path. */
export function writePrompts(root: string, spec: VideoSpec): string {
  if (spec.image_mode !== 'generated') throw new Error(`${spec.id} has no image_mode: "generated"`);
  const beats = generatedBeats(spec);
  if (!beats.length) throw new Error(`${spec.id} has no beat with an image_prompt`);
  const style = readStyleBlock(root);
  const sections = beats.map(
    (b) => `## ${b.id}\n\nSave as: \`${generatedPath(spec, b.id)}\`\n\n\`\`\`\n${style}\n${SUBJECT_LINE}\n\n${b.image_prompt}\n\`\`\``,
  );
  const file = join(root, 'out', spec.id, 'image-prompts.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Image prompts: ${spec.id}\n\n${sections.join('\n\n')}\n`);
  return file;
}

export interface IngestResult {
  /** Beats whose file is absent. */
  missing: { beat_id: string; file: string }[];
  /** Beats whose file exists but is too small or the wrong shape. */
  rejected: { beat_id: string; file: string; reason: string }[];
  /** Set only when nothing was missing or rejected and the spec was updated. */
  converted: { beat_id: string; asset: string }[];
}

const nearRatio = (w: number, h: number, target: number) => Math.abs(w / h - target) / target <= ASPECT_TOLERANCE;

/**
 * `studio ingest`: checks every expected PNG, then (only if all pass) converts each to
 * assets/stills/gen-<id>-<beat_id>.jpg, points the beat's visual at it and indexes it. Changes nothing otherwise.
 */
export function ingestGenerated(root: string, specFile: string, now: () => string = () => new Date().toISOString()): IngestResult {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as VideoSpec;
  if (spec.image_mode !== 'generated') throw new Error(`${spec.id} has no image_mode: "generated"`);
  const beats = generatedBeats(spec);
  if (!beats.length) throw new Error(`${spec.id} has no beat with an image_prompt`);
  const result: IngestResult = { missing: [], rejected: [], converted: [] };
  for (const b of beats) {
    const found = findInput(root, spec, b.id);
    const file = found ?? generatedPath(spec, b.id);
    if (!found) {
      result.missing.push({ beat_id: b.id, file: `${file} (or .jpg/.jpeg/.webp)` });
      continue;
    }
    const { width, height } = probeSize(join(root, file));
    if (width < MIN_WIDTH) result.rejected.push({ beat_id: b.id, file, reason: `width ${width} < ${MIN_WIDTH}` });
    else if (!nearRatio(width, height, 2 / 3) && !nearRatio(width, height, 9 / 16)) {
      result.rejected.push({ beat_id: b.id, file, reason: `${width}x${height} is not close to 2:3 or 9:16` });
    }
  }
  if (result.missing.length || result.rejected.length) return result;

  const lib = readLibrary(root);
  for (const b of beats) {
    const asset = stillPath(spec, b.id);
    const dest = join(root, 'assets', asset);
    mkdirSync(dirname(dest), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(root, findInput(root, spec, b.id)!), '-q:v', '2', dest]);
    const prev = b.visual;
    b.visual = { type: 'still', asset, ...(prev.type === 'still' && prev.motion ? { motion: prev.motion } : {}) };
    if (!(asset in lib)) {
      appendLibrary(root, asset, {
        provider: 'chatgpt-generated',
        source_url: findInput(root, spec, b.id)!,
        creator: 'ChatGPT image generation',
        license: 'Generated for this project',
        search_queries: [],
        picked_at: now(),
      });
    }
    result.converted.push({ beat_id: b.id, asset });
  }
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
  return result;
}
