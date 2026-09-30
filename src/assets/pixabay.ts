import { extOf, getJson, type Candidate, type FetchFn, type StockProvider } from './provider.ts';

const LICENSE = 'Pixabay Content License';
const PER_PAGE = 20;

const tagList = (tags: unknown) => String(tags ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean);
const creatorUrl = (h: any) => (h.user && h.user_id ? `https://pixabay.com/users/${h.user}-${h.user_id}/` : undefined);

/** Pixabay photos + videos. Free tier: 100 requests/minute. Photos are portrait-filtered API-side; videos have no orientation filter, so select.ts drops landscape hits. */
export function pixabay(apiKey: string, fetchFn: FetchFn = fetch): StockProvider {
  return {
    name: 'pixabay',
    async search(query) {
      const base = `key=${apiKey}&q=${encodeURIComponent(query)}&safesearch=true&per_page=${PER_PAGE}`;
      const [photos, videos] = await Promise.all([
        getJson(fetchFn, `https://pixabay.com/api/?${base}&image_type=photo&orientation=vertical&min_width=1080&min_height=1080`, {}, 'pixabay'),
        getJson(fetchFn, `https://pixabay.com/api/videos/?${base}`, {}, 'pixabay'),
      ]);
      const out: Candidate[] = [];
      for (const h of photos.hits ?? []) {
        const url: string = h.largeImageURL;
        if (!url || !h.imageWidth) continue;
        // largeImageURL is capped at 1280 px wide; report the size of the file we'd actually download.
        const width = Math.min(1280, h.imageWidth);
        out.push({
          provider: 'pixabay', id: String(h.id), kind: 'photo', pageUrl: h.pageURL, downloadUrl: url, ext: extOf(url, 'jpg'),
          width, height: Math.round((width * h.imageHeight) / h.imageWidth), creator: h.user, creatorUrl: creatorUrl(h),
          license: LICENSE, tags: tagList(h.tags), query,
        });
      }
      for (const h of videos.hits ?? []) {
        const sizes = ['large', 'medium', 'small'].map((k) => h.videos?.[k]).filter((s: any) => s?.url);
        const big = sizes.filter((s: any) => s.width >= 1080 && s.height >= 1920).sort((a: any, b: any) => a.width * a.height - b.width * b.height);
        const file = big[0] ?? sizes[0];
        if (!file) continue;
        out.push({
          provider: 'pixabay', id: String(h.id), kind: 'video', pageUrl: h.pageURL, downloadUrl: file.url, ext: 'mp4',
          width: file.width, height: file.height, durationSec: h.duration, creator: h.user, creatorUrl: creatorUrl(h),
          license: LICENSE, tags: tagList(h.tags), query,
        });
      }
      return out;
    },
  };
}
