import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Beat, Tokens, VideoSpec } from '../types.ts';
import { appendLibrary, readLibrary, type LibraryEntry } from './library.ts';
import type { Candidate, FetchFn, StockProvider } from './provider.ts';
import { buildCandidateSheet, type SheetTile } from './sheet.ts';
import { findCandidates, reuseMatches, RULES } from './select.ts';

/** What `assets/candidates/<beat_id>/candidates.json` holds for each numbered candidate; `--pick` reads it back. */
export interface StoredCandidate {
  n: number;
  kind: 'photo' | 'video';
  /** Path relative to `assets/`. For an existing library asset this is the library path itself. */
  file: string;
  /** Set when the candidate is an asset already in the library (nothing to move or index on pick). */
  existing?: boolean;
  provider: string;
  id?: string;
  source_url: string;
  creator: string;
  creator_url?: string;
  license: string;
}

export interface BeatResult {
  beat_id: string;
  candidates: StoredCandidate[];
  queried: string[];
  warnings: string[];
}

export interface SearchDeps {
  root: string;
  tokens: Tokens;
  providers: StockProvider[];
  fetchFn?: FetchFn;
  /** Overridable clock for tests. */
  now?: () => string;
}

export const candidatesDir = (root: string, beatId: string) => join(root, 'assets', 'candidates', beatId);

/** A beat still waiting for its visual: it names search_queries but isn't a still/clip yet. */
export const needsAsset = (b: Beat) => !!b.search_queries?.length && b.visual.type !== 'still' && b.visual.type !== 'clip';

async function download(fetchFn: FetchFn, url: string, dest: string): Promise<void> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * `studio assets <spec>`: for each beat that needs an asset, offers library matches plus up to
 * `RULES.perBeat` freshly downloaded candidates, and writes one contact sheet. It changes nothing but
 * `assets/candidates/` and the sheet: never the spec, the asset library or the index (a person picks).
 */
export async function searchAssets(spec: VideoSpec, deps: SearchDeps): Promise<{ beats: BeatResult[]; skipped: string[]; sheet: string | null }> {
  const { root, tokens, providers } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const library = readLibrary(root);
  const beats: BeatResult[] = [];
  const skipped: string[] = [];

  for (const beat of spec.beats) {
    if (!needsAsset(beat)) {
      if (beat.search_queries?.length) skipped.push(`${beat.id}: already has an asset`);
      continue;
    }
    const queries = beat.search_queries!;
    const stored: StoredCandidate[] = [];

    // Reuse first (SPEC: the library should be reused across videos, not grow unbounded).
    for (const m of reuseMatches(library, queries)) {
      if (!existsSync(join(root, 'assets', m.path))) continue;
      stored.push({
        n: stored.length + 1, kind: m.path.startsWith('clips/') ? 'video' : 'photo', file: m.path, existing: true,
        provider: m.entry.provider, source_url: m.entry.source_url, creator: m.entry.creator,
        creator_url: m.entry.creator_url, license: m.entry.license,
      });
    }

    const found = await findCandidates(queries, providers);
    const dir = candidatesDir(root, beat.id);
    rmSync(dir, { recursive: true, force: true }); // candidates are disposable; a re-run starts clean
    const warnings = [...found.warnings];
    let fresh = 0;
    for (const c of found.candidates) {
      if (fresh >= RULES.perBeat) break;
      const n = stored.length + 1;
      const file = `candidates/${beat.id}/${n}-${c.provider}-${c.id}.${c.ext}`;
      try {
        await download(fetchFn, c.downloadUrl, join(root, 'assets', file));
      } catch (e) {
        warnings.push((e as Error).message);
        continue;
      }
      fresh++;
      stored.push(toStored(n, c, file));
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'candidates.json'), JSON.stringify({ queries, candidates: stored }, null, 2) + '\n');
    beats.push({ beat_id: beat.id, candidates: stored, queried: found.queried, warnings });
  }

  let sheet: string | null = null;
  if (beats.length) {
    const rows: SheetTile[][] = beats.map((b) =>
      b.candidates.length
        ? b.candidates.map((c) => ({
            file: join(root, 'assets', c.file),
            kind: c.kind,
            label: `${b.beat_id} #${c.n} ${c.existing ? 'existing' : `${c.provider} ${c.kind}`}`,
          }))
        : [{ file: null, kind: 'photo' as const, label: `${b.beat_id} none found` }],
    );
    sheet = join(root, 'out', spec.id, 'asset-candidates.jpg');
    buildCandidateSheet(root, sheet, rows, tokens);
  }
  return { beats, skipped, sheet };
}

const toStored = (n: number, c: Candidate, file: string): StoredCandidate => ({
  n, kind: c.kind, file, provider: c.provider, id: c.id, source_url: c.pageUrl, creator: c.creator,
  creator_url: c.creatorUrl, license: c.license,
});

/**
 * `studio assets --pick <spec> <beat_id>=<n> ...`: for each named beat, moves candidate `n` into the
 * library (`assets/stills/` for photos, `assets/clips/` for videos), points the beat's `visual` at it
 * and appends an `assets/index.json` entry. Picking an existing library candidate just points the beat
 * at it. Everything is validated before anything is changed, so a bad pick changes nothing.
 */
export function pickAssets(
  root: string,
  specFile: string,
  picks: Record<string, number>,
  now: () => string = () => new Date().toISOString(),
): { beat_id: string; asset: string; moved: boolean }[] {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as VideoSpec;
  const plan = Object.entries(picks).map(([beatId, n]) => {
    const beat = spec.beats.find((b) => b.id === beatId);
    if (!beat) throw new Error(`no beat with id "${beatId}" in ${basename(specFile)}`);
    const metaFile = join(candidatesDir(root, beatId), 'candidates.json');
    if (!existsSync(metaFile)) throw new Error(`no candidates for "${beatId}"; run \`studio assets\` first`);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { queries: string[]; candidates: StoredCandidate[] };
    const cand = meta.candidates.find((c) => c.n === n);
    if (!cand) throw new Error(`"${beatId}" has no candidate #${n} (have ${meta.candidates.map((c) => c.n).join(', ') || 'none'})`);
    if (!existsSync(join(root, 'assets', cand.file))) throw new Error(`candidate file assets/${cand.file} is missing`);
    return { beat, cand, queries: meta.queries };
  });

  const results: { beat_id: string; asset: string; moved: boolean }[] = [];
  for (const { beat, cand, queries } of plan) {
    let asset = cand.file;
    let moved = false;
    if (!cand.existing) {
      const folder = cand.kind === 'video' ? 'clips' : 'stills';
      asset = `${folder}/${cand.provider}-${cand.id}.${cand.file.split('.').pop()}`;
      const dest = join(root, 'assets', asset);
      if (existsSync(dest)) {
        // Same stock item already in the library (picked for an earlier video): reuse, never duplicate or re-index.
        rmSync(join(root, 'assets', cand.file), { force: true });
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(join(root, 'assets', cand.file), dest);
        const entry: LibraryEntry = {
          provider: cand.provider, source_url: cand.source_url, creator: cand.creator,
          ...(cand.creator_url ? { creator_url: cand.creator_url } : {}), license: cand.license,
          search_queries: queries, picked_at: now(),
        };
        appendLibrary(root, asset, entry);
        moved = true;
      }
    }
    const prev = beat.visual;
    beat.visual =
      cand.kind === 'video'
        ? { type: 'clip', asset }
        : { type: 'still', asset, ...(prev.type === 'still' && prev.motion ? { motion: prev.motion } : {}) };
    results.push({ beat_id: beat.id, asset, moved });
  }
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
  return results;
}
