import { basename, join } from 'node:path';

/** What decides where a video's files go: its id, or the spec's optional `output_dir` (relative to out/). */
export interface OutTarget {
  id: string;
  output_dir?: string | null;
}

/** `out/<output_dir>` when the spec sets one, else `out/<id>`. */
export const outDirOf = (root: string, t: OutTarget) => join(root, 'out', t.output_dir ?? t.id);

/** Base name of the final video (no extension): the last folder of `output_dir`, else the id. */
export const outputName = (t: OutTarget) => (t.output_dir ? basename(t.output_dir) : t.id);
