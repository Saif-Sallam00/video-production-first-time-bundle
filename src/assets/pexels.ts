import { extOf, getJson, slugWords, type Candidate, type FetchFn, type StockProvider } from './provider.ts';

const API = 'https://api.pexels.com';
const LICENSE = 'Pexels License';
const PER_PAGE = 15;

/** Pexels photos + videos, portrait only (API-side `orientation=portrait`). Free tier: 200 requests/hour. */
export function pexels(apiKey: string, fetchFn: FetchFn = fetch): StockProvider {
  const init = { headers: { Authorization: apiKey } };
  const q = (query: string, extra = '') =>
    `query=${encodeURIComponent(query)}&orientation=portrait&per_page=${PER_PAGE}${extra}`;
  return {
    name: 'pexels',
    async search(query) {
      const [photos, videos] = await Promise.all([
        getJson(fetchFn, `${API}/v1/search?${q(query, '&size=large')}`, init, 'pexels'),
        getJson(fetchFn, `${API}/videos/search?${q(query)}`, init, 'pexels'),
      ]);
      const out: Candidate[] = [];
      for (const p of photos.photos ?? []) {
        const url: string = p.src?.original;
        if (!url) continue;
        out.push({
          provider: 'pexels', id: String(p.id), kind: 'photo', pageUrl: p.url, downloadUrl: url, ext: extOf(url, 'jpg'),
          width: p.width, height: p.height, creator: p.photographer, creatorUrl: p.photographer_url, license: LICENSE,
          tags: [...String(p.alt ?? '').toLowerCase().split(/\W+/).filter(Boolean), ...slugWords(p.url)], query,
        });
      }
      for (const v of videos.videos ?? []) {
        // Smallest mp4 that meets 1080x1920, else the largest we have (select.ts then rejects it).
        const files = (v.video_files ?? []).filter((f: any) => f.file_type === 'video/mp4' && f.link);
        const big = files.filter((f: any) => f.width >= 1080 && f.height >= 1920).sort((a: any, b: any) => a.width * a.height - b.width * b.height);
        const file = big[0] ?? files.sort((a: any, b: any) => b.width * b.height - a.width * a.height)[0];
        if (!file) continue;
        out.push({
          provider: 'pexels', id: String(v.id), kind: 'video', pageUrl: v.url, downloadUrl: file.link, ext: 'mp4',
          width: file.width, height: file.height, durationSec: v.duration, creator: v.user?.name ?? 'unknown',
          creatorUrl: v.user?.url, license: LICENSE, tags: slugWords(v.url), query,
        });
      }
      return out;
    },
  };
}
