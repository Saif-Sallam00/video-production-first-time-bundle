import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One picked asset (SPEC section 11): where it came from and under what terms. Keyed by its path under `assets/`. */
export interface LibraryEntry {
  provider: string;
  source_url: string;
  creator: string;
  creator_url?: string;
  license: string;
  /** The search queries of the beat it was picked for; what later beats are matched against for reuse. */
  search_queries: string[];
  picked_at: string;
}

export type Library = Record<string, LibraryEntry>;

export const libraryFile = (root: string) => join(root, 'assets', 'index.json');

export function readLibrary(root: string): Library {
  const f = libraryFile(root);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Library) : {};
}

/**
 * Adds `entry` under `path`. Append-only: an existing key is never replaced (throws instead), and the
 * file is written atomically (temp + rename) so a crash can't leave a half-written index.
 */
export function appendLibrary(root: string, path: string, entry: LibraryEntry): void {
  const lib = readLibrary(root);
  if (path in lib) throw new Error(`assets/index.json already has an entry for ${path}; refusing to overwrite it`);
  lib[path] = entry;
  const f = libraryFile(root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(lib, null, 2) + '\n');
  renameSync(f + '.tmp', f);
}
