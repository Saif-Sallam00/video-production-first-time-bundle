import type { Candidate, Kind, StockProvider } from './provider.ts';

// The tunable rules for what counts as an acceptable candidate (documented in SPEC section 11).
export const RULES = {
  /** A candidate file must be at least this big; the canvas is 1080x1920 and stills push in up to 1.08x. */
  minWidth: 1080,
  minHeight: 1920,
  /** Extra resolution requested beyond 1080x1920 so an 8% push-in (motion.still_zoom) still isn't an upscale. */
  pushHeadroom: 1.1,
  /** height / width must be at least this (9:16 is 1.78, 2:3 is 1.5). */
  minAspect: 1.4,
  /** A clip shorter than this loops so often it reads as a glitch. */
  minVideoSec: 3,
  /** Skip (and warn about) any video larger than this before downloading it: a picked clip lands in the repo. */
  maxVideoBytes: 15_000_000,
  /** Absolute ceiling on a video's length. */
  maxVideoSec: 10,
  /** ...and it is also capped at the beat's own length plus this, so a 4 s beat never pulls a 20 s clip. */
  videoSlackSec: 4,
  /** If a provider leaves fewer than this many acceptable candidates for a beat, the next provider is queried too. */
  weakBelow: 3,
  /** New candidates downloaded per beat. */
  perBeat: 4,
  /** Library assets surfaced as "existing" per beat, on top of the new candidates. */
  maxExisting: 2,
  /** Minimum word-set overlap (Jaccard) between two search queries for a library asset to count as a reuse match. */
  reuseOverlap: 0.5,
};

/**
 * Best-effort niche guardrail: the series wants silhouettes, hands and places, not headshots. A
 * candidate whose provider tags / alt text / URL slug mention any of these words is dropped. This is
 * keyword matching on whatever text the provider gives us, so it misses untagged faces and can drop
 * harmless hits; a person still reviews every candidate.
 */
export const CLOSE_UP_FACE_WORDS = [
  'portrait', 'headshot', 'face', 'faces', 'selfie', 'closeup', 'close-up', 'smile', 'smiling', 'smiles', 'eyes', 'eye',
  'beard', 'lips', 'makeup', 'model', 'posing', 'handsome', 'attractive', 'looking-at-camera',
];
const FACE = new Set(CLOSE_UP_FACE_WORDS);

export function mentionsCloseUpFace(tags: string[]): boolean {
  const words = tags.flatMap((t) => [t, ...t.split(/[^a-z-]+/)]);
  const joined = tags.join(' ');
  return words.some((w) => FACE.has(w)) || /close[\s-]?up|looking at camera/.test(joined);
}

/** Why a file of this pixel size is unusable, or null. Used on what a provider *claims* and again on the real downloaded file. */
export function sizeReject(width: number, height: number): string | null {
  if (width < RULES.minWidth || height < RULES.minHeight) return `too small (${width}x${height})`;
  if (height / width < RULES.minAspect) return 'not portrait';
  return null;
}

/** The longest video worth downloading for a beat of `beatSec` seconds (unknown: just the absolute ceiling). */
export function maxVideoDuration(beatSec?: number): number {
  if (beatSec === undefined) return RULES.maxVideoSec;
  return Math.min(RULES.maxVideoSec, Math.max(RULES.minVideoSec, beatSec + RULES.videoSlackSec));
}

/** Reasons that mean "fine in principle, but too heavy to bother downloading"; these are warned about, not silently dropped. */
export const CAP_REASON = /^video too (large|long)/;

/** Why a candidate is unacceptable, or null if it is fine. `beatSec` is the length of the beat it is for, when known. */
export function rejectReason(c: Candidate, beatSec?: number): string | null {
  const size = sizeReject(c.width, c.height);
  if (size) return size;
  if (c.kind === 'video' && (c.durationSec ?? 0) < RULES.minVideoSec) return 'clip too short';
  if (mentionsCloseUpFace(c.tags)) return 'close-up face tags';
  if (c.kind === 'video') {
    if (c.sizeBytes !== undefined && c.sizeBytes > RULES.maxVideoBytes) {
      return `video too large (${(c.sizeBytes / 1e6).toFixed(1)} MB > ${RULES.maxVideoBytes / 1e6} MB)`;
    }
    const maxSec = maxVideoDuration(beatSec);
    if ((c.durationSec ?? 0) > maxSec) {
      return `video too long (${c.durationSec} s > ${maxSec.toFixed(1)} s${beatSec !== undefined ? ` for a ${beatSec.toFixed(1)} s beat` : ''})`;
    }
  }
  return null;
}

/** Results of several queries interleaved (best of each query first), photos and videos alternating within a query, deduped. */
export function interleave(perQuery: Candidate[][]): Candidate[] {
  const lanes = perQuery.map((list) => {
    const photos = list.filter((c) => c.kind === 'photo');
    const videos = list.filter((c) => c.kind === 'video');
    const merged: Candidate[] = [];
    for (let i = 0; i < Math.max(photos.length, videos.length); i++) {
      if (photos[i]) merged.push(photos[i]);
      if (videos[i]) merged.push(videos[i]);
    }
    return merged;
  });
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (let i = 0; i < Math.max(0, ...lanes.map((l) => l.length)); i++) {
    for (const lane of lanes) {
      const c = lane[i];
      if (c && !seen.has(`${c.provider}:${c.id}`)) {
        seen.add(`${c.provider}:${c.id}`);
        out.push(c);
      }
    }
  }
  return out;
}

export interface Found {
  candidates: Candidate[];
  /** Providers actually queried, in order (the fallback shows up here). */
  queried: string[];
  warnings: string[];
}

/**
 * Runs every query against the providers in priority order, per kind of media. A provider is only asked
 * when it supplies a kind for which earlier providers left fewer than `RULES.weakBelow` acceptable
 * candidates, and only that kind's results are kept from it. So Unsplash can be the photo source and
 * Pixabay the video source, and Pexels (if enabled) backs up whichever is short. Returns every acceptable
 * candidate with photos and videos alternating (photo first), so a beat's first few downloads mix both
 * kinds when both exist; the caller downloads the first `RULES.perBeat` that succeed. A provider that
 * errors is skipped with a warning.
 */
export async function findCandidates(queries: string[], providers: StockProvider[], beatSec?: number): Promise<Found> {
  const acceptable: Record<Kind, Candidate[]> = { photo: [], video: [] };
  const queried: string[] = [];
  const warnings: string[] = [];
  const capped: string[] = [];
  for (const provider of providers) {
    const wanted = (['photo', 'video'] as Kind[]).filter((k) => provider.kinds.includes(k) && acceptable[k].length < RULES.weakBelow);
    if (!wanted.length) continue;
    queried.push(provider.name);
    const perQuery: Candidate[][] = [];
    for (const q of queries) {
      try {
        perQuery.push(await provider.search(q));
      } catch (e) {
        warnings.push((e as Error).message);
        perQuery.push([]);
      }
    }
    for (const c of interleave(perQuery)) {
      if (!wanted.includes(c.kind)) continue;
      const why = rejectReason(c, beatSec);
      if (!why) acceptable[c.kind].push(c);
      else if (CAP_REASON.test(why)) capped.push(`${c.provider} ${c.id}: ${why}`);
    }
  }
  if (capped.length) {
    const shown = capped.slice(0, 4).join('; ');
    warnings.push(`skipped ${capped.length} video${capped.length === 1 ? '' : 's'} over the size/duration cap (${shown}${capped.length > 4 ? `; +${capped.length - 4} more` : ''})`);
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < Math.max(acceptable.photo.length, acceptable.video.length); i++) {
    if (acceptable.photo[i]) candidates.push(acceptable.photo[i]);
    if (acceptable.video[i]) candidates.push(acceptable.video[i]);
  }
  return { candidates, queried, warnings };
}

const words = (q: string) => new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
export function queryOverlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / (x.size + y.size - inter || 1);
}

/** Library entries (by best pairwise query overlap) worth offering again for a beat with these queries. */
export function reuseMatches<E extends { search_queries?: string[] }>(
  library: Record<string, E>,
  queries: string[],
): { path: string; entry: E; score: number }[] {
  return Object.entries(library)
    .map(([path, entry]) => ({
      path,
      entry,
      score: Math.max(0, ...(entry.search_queries ?? []).flatMap((eq) => queries.map((q) => queryOverlap(eq, q)))),
    }))
    .filter((m) => m.score >= RULES.reuseOverlap)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, RULES.maxExisting);
}
