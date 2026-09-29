import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Timeline } from './timeline.ts';
import type { Tokens } from './types.ts';

const THUMB_WIDTH = 270; // px; tiles are scaled down from the full canvas

const MIN_GAP_SEC = 0.75; // extraction points closer than this show the same moment; keep the earlier one

/**
 * Every timestamp the contact sheet extracts a frame at (SPEC section 10, gate 7): t=0, the CTA pop
 * midpoint, and the midpoint of every beat and every caption page, in chronological order. A point
 * within `MIN_GAP_SEC` of the last kept point is dropped, so the earlier of a close pair wins.
 */
export function contactSheetTimes(timeline: Timeline): number[] {
  const all = [0];
  if (timeline.cta_pop) all.push((timeline.cta_pop.start + timeline.cta_pop.end) / 2);
  for (const beat of timeline.beats) all.push((beat.start + beat.end) / 2);
  for (const page of timeline.caption_pages) all.push((page.start + page.end) / 2);
  all.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const t of all) if (kept.length === 0 || t - kept[kept.length - 1]! > MIN_GAP_SEC) kept.push(t);
  return kept;
}

/**
 * SPEC `studio qa`, gate 7: extracts a frame at each `contactSheetTimes` timestamp from the already
 * -rendered MP4 (not the DOM, so it shows what actually rendered), tiles them with timestamp labels
 * burned in, and writes `out/<id>/contact-sheet.jpg`.
 */
export function buildContactSheet(root: string, mp4Path: string, timeline: Timeline, tokens: Tokens): string {
  const times = contactSheetTimes(timeline);
  const cols = Math.ceil(Math.sqrt(times.length));
  const rows = Math.ceil(times.length / cols);
  const thumbHeight = Math.round((THUMB_WIDTH * tokens.canvas.height) / tokens.canvas.width);
  const fontFile = join(root, tokens.fonts.body.file);

  const work = mkdtempSync(join(tmpdir(), 'ttyng-qa-'));
  try {
    times.forEach((t, i) => {
      const out = join(work, `frame-${String(i).padStart(3, '0')}.jpg`);
      execFileSync('ffmpeg', [
        '-v', 'error', '-y',
        '-ss', String(t),
        '-i', mp4Path,
        '-frames:v', '1', '-update', '1',
        '-vf', `scale=${THUMB_WIDTH}:${thumbHeight},drawtext=fontfile=${fontFile}:text='t=${t.toFixed(2)}s':fontcolor=white:fontsize=16:box=1:boxcolor=black@0.6:boxborderw=4:x=6:y=6`,
        out,
      ]);
    });
    // Pad to a full cols x rows grid so the tile filter gets exactly the frames it expects.
    for (let i = times.length; i < cols * rows; i++) {
      const out = join(work, `frame-${String(i).padStart(3, '0')}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${THUMB_WIDTH}x${thumbHeight}`, '-frames:v', '1', '-update', '1', out]);
    }

    const outDir = join(root, 'out', timeline.id);
    mkdirSync(outDir, { recursive: true });
    const sheetPath = join(outDir, 'contact-sheet.jpg');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-i', join(work, 'frame-%03d.jpg'),
      '-vf', `tile=${cols}x${rows}`,
      '-frames:v', '1',
      sheetPath,
    ]);
    return sheetPath;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
