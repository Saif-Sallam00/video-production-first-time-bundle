import { RULES } from './select.ts';
import { getJson, type Candidate, type FetchFn, type StockProvider } from './provider.ts';

const LICENSE = 'Unsplash License';
const PER_PAGE = 30;

const words = (s: unknown) => String(s ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);

/**
 * The width to request from Unsplash's image CDN for a photo of the given original size: the smallest
 * that still covers 1080x1920 with `RULES.pushHeadroom` to spare for a push-in, keeping the photo's own
 * aspect ratio, and never more than the original (`fit=max`, so no upscaling). A photo whose original
 * is smaller than that comes back at its original size and is then rejected by the size rule.
 */
export function wantedWidth(origW: number, origH: number): number {
  const need = Math.max(RULES.minWidth, (RULES.minHeight * origW) / origH);
  return Math.min(origW, Math.ceil(need * RULES.pushHeadroom));
}

/**
 * Unsplash photos (photos only; no video), portrait via `orientation=portrait`. Auth is the app's Access
 * Key (`UNSPLASH_ACCESS_KEY`). Images come from the `raw` URL with an explicit width, so the returned
 * file is real pixels at the size we ask for, never an upscale.
 *
 * `trackDownload` implements Unsplash's API guideline that each real use pings the photo's
 * `links.download_location`; `--pick` calls it. Demo-tier apps are limited to 50 requests/hour.
 */
export function unsplash(accessKey: string, fetchFn: FetchFn = fetch): StockProvider {
  const headers = { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' };
  return {
    name: 'unsplash',
    kinds: ['photo'],
    async search(query) {
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=portrait&per_page=${PER_PAGE}`;
      const json = await getJson(fetchFn, url, { headers }, 'unsplash');
      const out: Candidate[] = [];
      for (const p of json.results ?? []) {
        const raw: string | undefined = p.urls?.raw;
        if (!raw || !p.width || !p.height) continue;
        const width = wantedWidth(p.width, p.height);
        const download = new URL(raw);
        download.searchParams.set('w', String(width));
        download.searchParams.set('fit', 'max'); // never upscale past the original
        download.searchParams.set('q', '85');
        download.searchParams.set('fm', 'jpg');
        out.push({
          provider: 'unsplash', id: String(p.id), kind: 'photo', pageUrl: p.links?.html, downloadUrl: download.toString(), ext: 'jpg',
          width, height: Math.round((width * p.height) / p.width), creator: p.user?.name ?? 'unknown', creatorUrl: p.user?.links?.html,
          license: LICENSE, trackUrl: p.links?.download_location,
          tags: [...(p.tags ?? []).flatMap((t: any) => words(t.title)), ...words(p.alt_description), ...words(p.description), ...words(p.slug)],
          query,
        });
      }
      return out;
    },
    async trackDownload(trackUrl) {
      await getJson(fetchFn, trackUrl, { headers }, 'unsplash');
    },
  };
}
