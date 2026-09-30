import { getJson, type Candidate, type FetchFn, type StockProvider } from './provider.ts';

const LICENSE = 'Unsplash License';
const PER_PAGE = 30;
/** Requested download width; Unsplash's image CDN serves `raw` at any size up to the original. */
const DOWNLOAD_WIDTH = 2160;

const words = (s: unknown) => String(s ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);

/**
 * Unsplash photos (photos only; no video), portrait via `orientation=portrait`. Auth is the app's
 * Access Key (`UNSPLASH_ACCESS_KEY`). Not wired into `studio assets` yet.
 *
 * Two Unsplash API guidelines this does NOT handle yet, to settle when wiring it in: (1) each real
 * download should ping the photo's `links.download_location` endpoint, and (2) demo-tier apps are
 * limited to 50 requests/hour, which a few beats x several queries can exceed.
 */
export function unsplash(accessKey: string, fetchFn: FetchFn = fetch): StockProvider {
  return {
    name: 'unsplash',
    async search(query) {
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=portrait&per_page=${PER_PAGE}`;
      const json = await getJson(fetchFn, url, { headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' } }, 'unsplash');
      const out: Candidate[] = [];
      for (const p of json.results ?? []) {
        const raw: string | undefined = p.urls?.raw;
        if (!raw || !p.width) continue;
        const download = new URL(raw);
        download.searchParams.set('w', String(DOWNLOAD_WIDTH));
        download.searchParams.set('fit', 'max'); // never upscale past the original
        download.searchParams.set('q', '85');
        download.searchParams.set('fm', 'jpg');
        // Report the size of the file we'd download, not the original upload's.
        const width = Math.min(DOWNLOAD_WIDTH, p.width);
        out.push({
          provider: 'unsplash', id: String(p.id), kind: 'photo', pageUrl: p.links?.html, downloadUrl: download.toString(), ext: 'jpg',
          width, height: Math.round((width * p.height) / p.width), creator: p.user?.name ?? 'unknown', creatorUrl: p.user?.links?.html,
          license: LICENSE,
          tags: [...(p.tags ?? []).flatMap((t: any) => words(t.title)), ...words(p.alt_description), ...words(p.description), ...words(p.slug)],
          query,
        });
      }
      return out;
    },
  };
}
