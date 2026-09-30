import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Beat, Tokens, VideoSpec } from '../types.ts';
import { appendLibrary, readLibrary, type LibraryEntry } from './library.ts';
import type { Candidate, FetchFn, StockProvider } from './provider.ts';
import { buildCandidateSheet, type SheetTile } from './sheet.ts';
import { EST_CHARS_PER_SEC } from '../lint.ts';
import { findCandidates, reuseMatches, RULES, sizeReject } from './select.ts';
import type { Timeline } from '../timeline.ts';

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
  /** Set when the provider wants a ping on use (see `StockProvider.trackDownload`). */
  track_url?: string;
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
  /** Seconds each beat lasts, by id (caps the length of video worth downloading). Default: `beatSecondsFor`. */
  beatSeconds?: Record<string, number>;
  /** Search only these beat ids (an unknown id throws). The other beats' candidates are left as they are. */
  only?: string[];
}

export const candidatesDir = (root: string, beatId: string) => join(root, 'assets', 'candidates', beatId);

/** A beat still waiting for its visual: it names search_queries but isn't a still/clip yet. */
export const needsAsset = (b: Beat) => !!b.search_queries?.length && b.visual.type !== 'still' && b.visual.type !== 'clip';

/** Pixel size of the first video/image stream of a file, read from the file itself. */
export function probeSize(file: string): { width: number; height: number } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [width, height] = out.trim().split(',').map(Number);
  if (!width || !height) throw new Error(`could not read the size of ${file}`);
  return { width, height };
}

/**
 * Seconds each beat lasts. The real figure from `out/<id>/timeline.json` when a timeline has been built
 * (so the cap follows the actual voiceover); otherwise the same characters-per-second estimate the lint uses.
 */
export function beatSecondsFor(root: string, spec: VideoSpec): Record<string, number> {
  const file = join(root, 'out', spec.id, 'timeline.json');
  if (existsSync(file)) {
    const tl = JSON.parse(readFileSync(file, 'utf8')) as Timeline;
    return Object.fromEntries(tl.beats.map((b) => [b.id, b.end - b.start]));
  }
  const cps = EST_CHARS_PER_SEC * (spec.voice?.speed ?? 1);
  return Object.fromEntries(spec.beats.map((b) => [b.id, b.vo.length / cps]));
}

/** Downloads `url` to `dest`. With `maxBytes`, refuses a body larger than that: by Content-Length before reading it, else by the size actually received. */
async function download(fetchFn: FetchFn, url: string, dest: string, maxBytes?: number): Promise<void> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const tooBig = (n: number) => `too large (${(n / 1e6).toFixed(1)} MB > ${(maxBytes! / 1e6).toFixed(0)} MB); not saved`;
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes !== undefined && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`${url}: ${tooBig(declared)}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (maxBytes !== undefined && body.length > maxBytes) throw new Error(`${url}: ${tooBig(body.length)}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
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
  const beatSeconds = deps.beatSeconds ?? beatSecondsFor(root, spec);
  const beats: BeatResult[] = [];
  const skipped: string[] = [];
  for (const id of deps.only ?? []) {
    const beat = spec.beats.find((b) => b.id === id);
    if (!beat) throw new Error(`no beat with id "${id}"`);
    if (!needsAsset(beat)) throw new Error(`beat "${id}" has no search_queries to search, or already has a still/clip`);
  }

  for (const beat of spec.beats) {
    if (deps.only && !deps.only.includes(beat.id)) continue;
    if (!needsAsset(beat)) {
      if (beat.search_queries?.length) skipped.push(`${beat.id}: already has an asset`);
      continue;
    }
    const queries = beat.search_queries!;
    const stored: StoredCandidate[] = [];

    // Reuse first (SPEC: the library should be reused across videos, not grow unbounded).
    for (const m of reuseMatches(library, queries)) {
      const abs = join(root, 'assets', m.path);
      if (!existsSync(abs)) continue;
      // A library asset picked before the size rule was enforced for real may be an upscale; don't re-offer it.
      const real = probeSize(abs);
      const tooSmall = sizeReject(real.width, real.height);
      if (tooSmall) {
        skipped.push(`${beat.id}: library asset ${m.path} not offered again (${tooSmall})`);
        continue;
      }
      stored.push({
        n: stored.length + 1, kind: m.path.startsWith('clips/') ? 'video' : 'photo', file: m.path, existing: true,
        provider: m.entry.provider, source_url: m.entry.source_url, creator: m.entry.creator,
        creator_url: m.entry.creator_url, license: m.entry.license,
      });
    }

    const found = await findCandidates(queries, providers, beatSeconds[beat.id]);
    const dir = candidatesDir(root, beat.id);
    rmSync(dir, { recursive: true, force: true }); // candidates are disposable; a re-run starts clean
    const warnings = [...found.warnings];
    let fresh = 0;
    for (const c of found.candidates) {
      if (fresh >= RULES.perBeat) break;
      const n = stored.length + 1;
      const file = `candidates/${beat.id}/${n}-${c.provider}-${c.id}.${c.ext}`;
      try {
        await download(fetchFn, c.downloadUrl, join(root, 'assets', file), c.kind === 'video' ? RULES.maxVideoBytes : undefined);
      } catch (e) {
        warnings.push((e as Error).message);
        continue;
      }
      // Trust the file, not the provider's claim: a provider that misreports sizes must not slip an upscale through.
      const real = probeSize(join(root, 'assets', file));
      const tooSmall = sizeReject(real.width, real.height);
      if (tooSmall) {
        rmSync(join(root, 'assets', file), { force: true });
        warnings.push(`${c.provider} ${c.id}: the real file is ${real.width}x${real.height} (${tooSmall}); dropped`);
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
    // A partial run gets its own sheet so it never overwrites the whole-spec one.
    sheet = join(root, 'out', spec.id, deps.only ? `asset-candidates-${deps.only.join('+')}.jpg` : 'asset-candidates.jpg');
    buildCandidateSheet(root, sheet, rows, tokens);
  }
  return { beats, skipped, sheet };
}

const toStored = (n: number, c: Candidate, file: string): StoredCandidate => ({
  n, kind: c.kind, file, provider: c.provider, id: c.id, source_url: c.pageUrl, creator: c.creator,
  creator_url: c.creatorUrl, license: c.license, ...(c.trackUrl ? { track_url: c.trackUrl } : {}),
});

/**
 * `studio assets --pick <spec> <beat_id>=<n> ...`: for each named beat, moves candidate `n` into the
 * library (`assets/stills/` for photos, `assets/clips/` for videos), points the beat's `visual` at it
 * and appends an `assets/index.json` entry. Picking an existing library candidate just points the beat
 * at it. Everything is validated before anything is changed, so a bad pick changes nothing.
 */
export async function pickAssets(
  root: string,
  specFile: string,
  picks: Record<string, number>,
  opts: { now?: () => string; providers?: StockProvider[] } = {},
): Promise<{ beat_id: string; asset: string; moved: boolean; tracked?: boolean; warning?: string }[]> {
  const now = opts.now ?? (() => new Date().toISOString());
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

  const results: { beat_id: string; asset: string; moved: boolean; tracked?: boolean; warning?: string }[] = [];
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
    // Provider download tracking (Unsplash asks for a ping on every real use). Only for a fresh pick, and a
    // failed ping warns rather than undoing the pick: the file and index entry are already in place.
    let tracked: boolean | undefined;
    let warning: string | undefined;
    const provider = opts.providers?.find((p) => p.name === cand.provider);
    if (moved && cand.track_url && provider?.trackDownload) {
      try {
        await provider.trackDownload(cand.track_url);
        tracked = true;
      } catch (e) {
        tracked = false;
        warning = `download tracking for ${cand.provider} failed: ${(e as Error).message}`;
      }
    } else if (moved && cand.track_url) {
      tracked = false;
      warning = `${cand.provider} asks for a download ping but no ${cand.provider} provider is configured (set its key in .env); not sent`;
    }
    const prev = beat.visual;
    beat.visual =
      cand.kind === 'video'
        ? { type: 'clip', asset }
        : { type: 'still', asset, ...(prev.type === 'still' && prev.motion ? { motion: prev.motion } : {}) };
    results.push({ beat_id: beat.id, asset, moved, ...(tracked !== undefined ? { tracked } : {}), ...(warning ? { warning } : {}) });
  }
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
  return results;
}
