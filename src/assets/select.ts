import type { Candidate, StockProvider } from './provider.ts';

// The tunable rules for what counts as an acceptable candidate (documented in SPEC section 11).
export const RULES = {
  /** A candidate file must be at least this big; the canvas is 1080x1920 and stills push in up to 1.08x. */
  minWidth: 1080,
  minHeight: 1920,
  /** height / width must be at least this (9:16 is 1.78, 2:3 is 1.5). */
  minAspect: 1.4,
  /** A clip shorter than this loops so often it reads as a glitch. */
  minVideoSec: 3,
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

/** Why a candidate is unacceptable, or null if it is fine. */
export function rejectReason(c: Candidate): string | null {
  if (c.width < RULES.minWidth || c.height < RULES.minHeight) return `too small (${c.width}x${c.height})`;
  if (c.height / c.width < RULES.minAspect) return 'not portrait';
  if (c.kind === 'video' && (c.durationSec ?? 0) < RULES.minVideoSec) return 'clip too short';
  if (mentionsCloseUpFace(c.tags)) return 'close-up face tags';
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
 * Runs every query against the providers in priority order. A later provider is only queried when the
 * ones before it left fewer than `RULES.weakBelow` acceptable candidates. Returns every acceptable
 * candidate, earlier providers first (the caller downloads the first `RULES.perBeat` that succeed). A
 * provider that errors is skipped with a warning.
 */
export async function findCandidates(queries: string[], providers: StockProvider[]): Promise<Found> {
  const acceptable: Candidate[] = [];
  const queried: string[] = [];
  const warnings: string[] = [];
  for (const provider of providers) {
    if (acceptable.length >= RULES.weakBelow) break;
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
    for (const c of interleave(perQuery)) if (!rejectReason(c)) acceptable.push(c);
  }
  return { candidates: acceptable, queried, warnings };
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
