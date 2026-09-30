import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Tokens } from '../types.ts';

const THUMB_W = 270;

export interface SheetTile {
  /** Absolute path of the image/video to thumbnail; null draws an empty "none found" tile. */
  file: string | null;
  kind: 'photo' | 'video';
  label: string;
}

/**
 * One contact sheet for a whole spec: a row per beat, a tile per candidate, each tile labeled with its
 * beat id and candidate number (and "existing" for library assets). Videos are shown by a frame from
 * half a second in. Rows are padded with black to the widest row.
 */
export function buildCandidateSheet(root: string, outFile: string, rows: SheetTile[][], tokens: Tokens): void {
  const thumbH = Math.round((THUMB_W * tokens.canvas.height) / tokens.canvas.width);
  const font = join(root, tokens.fonts.body.file);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const work = mkdtempSync(join(tmpdir(), 'ttyng-sheet-'));
  try {
    const draw = `drawtext=fontfile=${font}:text='LABEL':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.7:boxborderw=5:x=6:y=6`;
    let n = 0;
    for (const row of rows) {
      for (let c = 0; c < cols; c++) {
        const tile = row[c];
        const out = join(work, `t-${String(n++).padStart(4, '0')}.png`);
        const scale = `scale=${THUMB_W}:${thumbH}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${thumbH}`;
        if (!tile) {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${THUMB_W}x${thumbH}`, '-frames:v', '1', '-pix_fmt', 'rgb24', out]);
        } else if (!tile.file) {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x222222:s=${THUMB_W}x${thumbH}`, '-vf', draw.replace('LABEL', tile.label), '-frames:v', '1', '-pix_fmt', 'rgb24', out]);
        } else {
          execFileSync('ffmpeg', [
            '-v', 'error', '-y', ...(tile.kind === 'video' ? ['-ss', '0.5'] : []), '-i', tile.file,
            '-frames:v', '1', '-vf', `${scale},${draw.replace('LABEL', tile.label)}`, '-pix_fmt', 'rgb24', out,
          ]);
        }
      }
    }
    mkdirSync(dirname(outFile), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(work, 't-%04d.png'), '-vf', `tile=${cols}x${rows.length}`, '-frames:v', '1', '-update', '1', outFile]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
