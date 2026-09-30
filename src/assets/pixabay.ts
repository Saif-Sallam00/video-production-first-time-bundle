import { extOf, getJson, type Candidate, type FetchFn, type Kind, type StockProvider } from './provider.ts';

const LICENSE = 'Pixabay Content License';
const PER_PAGE = 20;

const tagList = (tags: unknown) => String(tags ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean);
const creatorUrl = (h: any) => (h.user && h.user_id ? `https://pixabay.com/users/${h.user}-${h.user_id}/` : undefined);

/** `largeImageURL` is scaled so its LONGEST side is at most this (Pixabay's documented cap for non-approved API keys). */
export const PIXABAY_LARGE_CAP = 1280;

/**
 * Pixabay photos + videos. Free tier: 100 requests/minute. Photos are portrait-filtered API-side; videos have no orientation filter, so select.ts drops landscape hits.
 * `kinds` limits which it asks for (the CLI uses videos only: Pixabay photos never reach 1080x1920).
 */
export function pixabay(apiKey: string, fetchFn: FetchFn = fetch, kinds: Kind[] = ['photo', 'video']): StockProvider {
  return {
    name: 'pixabay',
    kinds,
    async search(query) {
      const base = `key=${apiKey}&q=${encodeURIComponent(query)}&safesearch=true&per_page=${PER_PAGE}`;
      const [photos, videos] = await Promise.all([
        kinds.includes('photo') ? getJson(fetchFn, `https://pixabay.com/api/?${base}&image_type=photo&orientation=vertical&min_width=1080&min_height=1080`, {}, 'pixabay') : { hits: [] },
        kinds.includes('video') ? getJson(fetchFn, `https://pixabay.com/api/videos/?${base}`, {}, 'pixabay') : { hits: [] },
      ]);
      const out: Candidate[] = [];
      for (const h of photos.hits ?? []) {
        const url: string = h.largeImageURL;
        if (!url || !h.imageWidth) continue;
        // largeImageURL is capped at 1280 px on its longest side (not its width). Report the size of the
        // file we'd actually download, so a portrait photo is ~853x1280 and honestly fails the 1080x1920 rule.
        const scale = Math.min(1, PIXABAY_LARGE_CAP / Math.max(h.imageWidth, h.imageHeight));
        const width = Math.round(h.imageWidth * scale);
        out.push({
          provider: 'pixabay', id: String(h.id), kind: 'photo', pageUrl: h.pageURL, downloadUrl: url, ext: extOf(url, 'jpg'),
          width, height: Math.round(h.imageHeight * scale), creator: h.user, creatorUrl: creatorUrl(h),
          license: LICENSE, tags: tagList(h.tags), query,
        });
      }
      for (const h of videos.hits ?? []) {
        // Of the variants that meet 1080x1920, take the one with the fewest BYTES (Pixabay's `large` can be
        // 100+ MB for the same picture a `medium` delivers in a fifth of that); resolution only breaks ties.
        // A variant that reports no size sorts last. If none qualifies, the first is returned and rejected by select.ts.
        const sizes = ['large', 'medium', 'small'].map((k) => h.videos?.[k]).filter((s: any) => s?.url);
        const bytes = (s: any) => (s.size > 0 ? s.size : Number.POSITIVE_INFINITY);
        const big = sizes
          .filter((s: any) => s.width >= 1080 && s.height >= 1920)
          .sort((a: any, b: any) => bytes(a) - bytes(b) || a.width * a.height - b.width * b.height);
        const file = big[0] ?? sizes[0];
        if (!file) continue;
        out.push({
          provider: 'pixabay', id: String(h.id), kind: 'video', pageUrl: h.pageURL, downloadUrl: file.url, ext: 'mp4',
          width: file.width, height: file.height, durationSec: h.duration, ...(file.size > 0 ? { sizeBytes: file.size } : {}), creator: h.user, creatorUrl: creatorUrl(h),
          license: LICENSE, tags: tagList(h.tags), query,
        });
      }
      return out;
    },
  };
}
