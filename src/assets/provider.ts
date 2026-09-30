// The one interface every stock source implements (SPEC section 11, M5b). The selection code in
// select.ts only ever sees `StockProvider` and `Candidate`, so adding a third source means writing one
// more file like pexels.ts and adding it to the provider list in run.ts; nothing in the picker changes.

export interface Candidate {
  provider: string;
  /** The provider's own id; (provider, id) is unique. */
  id: string;
  kind: 'photo' | 'video';
  /** Human-facing page for the asset (what to cite / open to review). */
  pageUrl: string;
  /** The file we would download. Its `width`/`height` are that file's, not the original upload's. */
  downloadUrl: string;
  /** File extension without the dot, e.g. jpg, mp4. */
  ext: string;
  width: number;
  height: number;
  durationSec?: number;
  creator: string;
  creatorUrl?: string;
  license: string;
  /** Free-text keywords the provider gave us (tags, alt text, URL slug words), lowercased; input for the face filter. */
  tags: string[];
  /** The search query that produced this hit. */
  query: string;
}

export interface StockProvider {
  name: string;
  /** Portrait-oriented photos and videos for one query. Throws on HTTP/auth errors. */
  search(query: string): Promise<Candidate[]>;
}

export type FetchFn = typeof fetch;

export async function getJson(fetchFn: FetchFn, url: string, init: RequestInit, who: string): Promise<any> {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${who}: HTTP ${res.status} ${res.statusText} for ${url.replace(/key=[^&]+/, 'key=***')}`);
  return res.json();
}

/** Extension of a URL's path, defaulting when it has none we recognise. */
export function extOf(url: string, fallback: string): string {
  const m = /\.(jpe?g|png|webp|mp4|mov|webm)(?:$|\?)/i.exec(new URL(url).pathname + new URL(url).search);
  return (m?.[1] ?? fallback).toLowerCase();
}

/** Words of a URL slug like /video/woman-walking-on-street-12345/ (drops the numeric id). */
export function slugWords(url: string): string[] {
  const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  return last.split('-').filter((w) => w && !/^\d+$/.test(w)).map((w) => w.toLowerCase());
}
