import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { pexels } from '../src/assets/pexels.ts';
import { pixabay } from '../src/assets/pixabay.ts';
import { unsplash } from '../src/assets/unsplash.ts';
import type { Candidate, StockProvider } from '../src/assets/provider.ts';
import { appendLibrary, readLibrary, type LibraryEntry } from '../src/assets/library.ts';
import { needsAsset, pickAssets, searchAssets } from '../src/assets/run.ts';
import { buildCandidateSheet } from '../src/assets/sheet.ts';
import { findCandidates, mentionsCloseUpFace, queryOverlap, rejectReason, reuseMatches, RULES } from '../src/assets/select.ts';
import type { VideoSpec } from '../src/types.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { project } from './helpers.ts';

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  provider: 'pexels', id: '1', kind: 'photo', pageUrl: 'https://p/1', downloadUrl: 'https://cdn/1.jpg', ext: 'jpg',
  width: 1080, height: 1920, creator: 'A', license: 'L', tags: ['window', 'night'], query: 'q', ...o,
});
/** A provider whose answer per query is fixed. */
const fake = (name: string, hits: Candidate[], calls: string[] = []): StockProvider => ({
  name,
  async search(q) {
    calls.push(`${name}:${q}`);
    return hits.map((h) => ({ ...h, provider: name, query: q }));
  },
});
const many = (n: number, prefix: string, o: Partial<Candidate> = {}) =>
  Array.from({ length: n }, (_, i) => cand({ id: `${prefix}${i}`, downloadUrl: `https://cdn/${prefix}${i}.jpg`, ...o }));

describe('providers (mocked APIs)', () => {
  it('pexels: asks for portrait, sends the key, and picks the smallest mp4 meeting 1080x1920', async () => {
    const urls: string[] = [];
    let auth = '';
    const fetchFn = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      auth = (init?.headers as Record<string, string>)?.Authorization ?? auth;
      return Response.json(
        url.includes('/videos/')
          ? { videos: [{ id: 7, url: 'https://www.pexels.com/video/hands-on-table-7/', duration: 9, user: { name: 'Vee', url: 'https://pexels.com/@vee' },
              video_files: [
                { file_type: 'video/mp4', width: 2160, height: 3840, link: 'https://v/uhd.mp4' },
                { file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://v/hd.mp4' },
                { file_type: 'video/mp4', width: 540, height: 960, link: 'https://v/sd.mp4' } ] }] }
          : { photos: [{ id: 3, width: 4000, height: 6000, url: 'https://www.pexels.com/photo/night-window-3/', photographer: 'Pat',
              photographer_url: 'https://pexels.com/@pat', alt: 'A dark Window at night', src: { original: 'https://img/3.jpeg' } }] },
      );
    }) as typeof fetch;
    const out = await pexels('KEY', fetchFn).search('night window');
    assert.equal(auth, 'KEY');
    assert.ok(urls.every((u) => u.includes('orientation=portrait')));
    const photo = out.find((c) => c.kind === 'photo')!;
    assert.deepEqual([photo.id, photo.creator, photo.ext, photo.license], ['3', 'Pat', 'jpeg', 'Pexels License']);
    assert.ok(photo.tags.includes('window') && photo.tags.includes('night'));
    const video = out.find((c) => c.kind === 'video')!;
    assert.equal(video.downloadUrl, 'https://v/hd.mp4');
    assert.equal(video.durationSec, 9);
    assert.deepEqual(video.tags, ['hands', 'on', 'table']);
  });

  it('pixabay: reports the capped 1280px photo size, carries tags, prefers a video size that meets the minimum', async () => {
    const fetchFn = (async (url: string) =>
      Response.json(
        url.includes('/videos/')
          ? { hits: [{ id: 9, pageURL: 'https://pixabay.com/videos/x-9/', tags: 'hands, waiting', duration: 12, user: 'Zed', user_id: 5,
              videos: { large: { url: 'https://v/large.mp4', width: 2160, height: 3840 }, medium: { url: 'https://v/med.mp4', width: 1080, height: 1920 }, small: { url: '', width: 0, height: 0 } } }] }
          : { hits: [{ id: 4, pageURL: 'https://pixabay.com/photos/y-4/', tags: 'street, night', largeImageURL: 'https://img/4_1280.jpg', imageWidth: 4000, imageHeight: 6000, user: 'Ann', user_id: 8 }] },
      )) as typeof fetch;
    const out = await pixabay('K', fetchFn).search('street');
    const photo = out.find((c) => c.kind === 'photo')!;
    assert.deepEqual([photo.width, photo.height], [1280, 1920]);
    assert.deepEqual(photo.tags, ['street', 'night']);
    assert.equal(photo.creatorUrl, 'https://pixabay.com/users/Ann-8/');
    assert.equal(out.find((c) => c.kind === 'video')!.downloadUrl, 'https://v/med.mp4');
  });

  it('unsplash: portrait search with Client-ID auth, photos only, download size and tags normalized', async () => {
    let seen = { url: '', auth: '' };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).Authorization };
      return Response.json({ results: [
        { id: 'abc', width: 4000, height: 6000, slug: 'lone-figure-on-street', alt_description: 'A silhouette walking away', description: null,
          urls: { raw: 'https://images.unsplash.com/photo-1?ixid=XYZ' }, links: { html: 'https://unsplash.com/photos/abc' },
          user: { name: 'Uma', links: { html: 'https://unsplash.com/@uma' } }, tags: [{ title: 'Street' }, { title: 'night life' }] },
        { id: 'small', width: 800, height: 1200, urls: { raw: 'https://images.unsplash.com/photo-2?ixid=Q' }, links: { html: 'h' }, user: { name: 'S' }, tags: [] },
        { id: 'nourl', width: 4000, height: 6000, urls: {} },
      ] });
    }) as typeof fetch;
    const out = await unsplash('ACCESS', fetchFn).search('night street');
    assert.equal(seen.auth, 'Client-ID ACCESS');
    assert.ok(seen.url.includes('orientation=portrait') && seen.url.includes('query=night%20street'));
    assert.deepEqual(out.map((c) => c.id), ['abc', 'small']); // a result with no raw URL is skipped
    const a = out[0];
    assert.deepEqual([a.kind, a.provider, a.license, a.creator, a.creatorUrl, a.pageUrl], ['photo', 'unsplash', 'Unsplash License', 'Uma', 'https://unsplash.com/@uma', 'https://unsplash.com/photos/abc']);
    const dl = new URL(a.downloadUrl);
    assert.deepEqual([dl.searchParams.get('ixid'), dl.searchParams.get('w'), dl.searchParams.get('fit'), dl.searchParams.get('fm')], ['XYZ', '2160', 'max', 'jpg']);
    assert.deepEqual([a.width, a.height], [2160, 3240]); // size of the download, not the 4000x6000 original
    assert.deepEqual(out[1].width, 800); // never claims more than the original has
    for (const t of ['street', 'night', 'life', 'silhouette', 'walking', 'lone-figure-on-street']) assert.ok(a.tags.includes(t), t);
  });

  it('unsplash results go through the same acceptance rules (size, portrait, close-up-face tags)', async () => {
    const fetchFn = (async () => Response.json({ results: [
      { id: 'ok', width: 4000, height: 6000, urls: { raw: 'https://i/1?x=1' }, links: { html: 'h' }, user: { name: 'a' }, tags: [{ title: 'street' }] },
      { id: 'small', width: 800, height: 1200, urls: { raw: 'https://i/2?x=1' }, links: { html: 'h' }, user: { name: 'a' }, tags: [] },
      { id: 'face', width: 4000, height: 6000, urls: { raw: 'https://i/3?x=1' }, links: { html: 'h' }, user: { name: 'a' }, tags: [{ title: 'portrait' }] },
      { id: 'closeup', width: 4000, height: 6000, urls: { raw: 'https://i/4?x=1' }, links: { html: 'h' }, user: { name: 'a' }, alt_description: 'close-up of a smiling man', tags: [] },
    ] })) as typeof fetch;
    const r = await findCandidates(['q'], [unsplash('K', fetchFn)]);
    assert.deepEqual(r.candidates.map((c) => c.id), ['ok']);
  });

  it('surfaces an HTTP error without leaking the API key', async () => {
    const fetchFn = (async () => new Response('no', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch;
    await assert.rejects(pixabay('SECRET', fetchFn).search('x'), (e: Error) => /429/.test(e.message) && !/SECRET/.test(e.message));
  });
});

describe('acceptability filters', () => {
  it('rejects too small, landscape, short clips', () => {
    assert.match(rejectReason(cand({ width: 720, height: 1280 }))!, /too small/);
    assert.match(rejectReason(cand({ width: 2400, height: 2000 }))!, /not portrait/);
    assert.match(rejectReason(cand({ kind: 'video', durationSec: 1.5 }))!, /too short/);
    assert.equal(rejectReason(cand({ kind: 'video', durationSec: 8 })), null);
    assert.equal(rejectReason(cand()), null);
  });

  it('drops close-up-face tags but keeps silhouettes, hands and places', () => {
    for (const t of [['portrait', 'man'], ['headshot'], ['smiling', 'woman'], ['close-up', 'face'], ['a', 'selfie']]) {
      assert.ok(mentionsCloseUpFace(t), t.join());
      assert.match(rejectReason(cand({ tags: t }))!, /face/);
    }
    assert.ok(mentionsCloseUpFace(['woman looking at camera']));
    for (const t of [['silhouette', 'sunset'], ['hands', 'table'], ['street', 'night'], ['doorway']]) assert.ok(!mentionsCloseUpFace(t), t.join());
  });
});

describe('findCandidates (fallback)', () => {
  it('does not query the fallback when the first provider leaves enough acceptable candidates', async () => {
    const calls: string[] = [];
    const r = await findCandidates(['a', 'b'], [fake('pexels', many(RULES.weakBelow, 'p'), calls), fake('pixabay', many(5, 'x'), calls)]);
    assert.deepEqual(r.queried, ['pexels']);
    assert.ok(calls.every((c) => c.startsWith('pexels')));
  });

  it('falls back to the next provider when the first is weak, keeping first-provider results ahead', async () => {
    const weak = [...many(RULES.weakBelow - 1, 'p'), ...many(6, 'bad', { tags: ['portrait'] }), cand({ id: 'small', width: 500, height: 900 })];
    const r = await findCandidates(['a'], [fake('pexels', weak), fake('pixabay', many(3, 'x'))]);
    assert.deepEqual(r.queried, ['pexels', 'pixabay']); // rejects don't count toward "enough"
    assert.deepEqual(r.candidates.map((c) => c.provider), ['pexels', 'pexels', 'pixabay', 'pixabay', 'pixabay']);
  });

  it('runs every query, dedupes across them, and skips a provider that errors', async () => {
    const calls: string[] = [];
    const broken: StockProvider = { name: 'pexels', async search() { throw new Error('pexels: HTTP 401'); } };
    const r = await findCandidates(['a', 'b'], [broken, fake('pixabay', many(2, 'x'), calls)]);
    assert.deepEqual(calls, ['pixabay:a', 'pixabay:b']);
    assert.equal(r.warnings.length, 2);
    assert.deepEqual(r.candidates.map((c) => c.id), ['x0', 'x1']); // same hits from both queries appear once
  });
});

describe('reuse matching', () => {
  const entry = (search_queries: string[]): LibraryEntry => ({ provider: 'pexels', source_url: 'u', creator: 'c', license: 'l', search_queries, picked_at: 't' });
  it('scores query overlap by shared words', () => {
    assert.equal(queryOverlap('night window', 'night window'), 1);
    assert.equal(queryOverlap('night window', 'window night'), 1);
    assert.ok(queryOverlap('bedroom window night', 'night window') >= RULES.reuseOverlap);
    assert.equal(queryOverlap('hands table', 'city street'), 0);
  });
  it('returns only library assets whose queries overlap significantly, best first', () => {
    const lib = { 'stills/a.jpg': entry(['night window']), 'stills/b.jpg': entry(['bedroom window night', 'x']), 'stills/c.jpg': entry(['city street']) };
    assert.deepEqual(reuseMatches(lib, ['night window']).map((m) => m.path), ['stills/a.jpg', 'stills/b.jpg']);
    assert.deepEqual(reuseMatches(lib, ['quiet forest']), []);
  });
});

describe('un-sourced beats refuse to render', () => {
  const run = (spec: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(PROJECT_ROOT, 'src/cli.ts'), 'render', spec], { encoding: 'utf8', cwd: PROJECT_ROOT });

  it('needsAsset: search_queries without a still/clip, and nothing else', () => {
    const beat = (visual: object, search_queries?: string[]) => ({ id: 'b', role: 'body', vo: 'x', visual, search_queries }) as never;
    assert.ok(needsAsset(beat({ type: 'solid' }, ['q'])));
    assert.ok(needsAsset(beat({ type: 'typography', text: 't' }, ['q'])));
    assert.ok(!needsAsset(beat({ type: 'still', asset: 'stills/a.png' }, ['q'])));
    assert.ok(!needsAsset(beat({ type: 'clip', asset: 'clips/a.mp4' }, ['q'])));
    assert.ok(!needsAsset(beat({ type: 'solid' })));
    assert.ok(!needsAsset(beat({ type: 'solid' }, [])));
  });

  it('`studio render` on examples/w2-p6-stock.json fails loudly, naming the beats, without rendering', () => {
    const r = run('examples/w2-p6-stock.json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /5 beats still need a still\/clip/);
    for (const id of ['hook', 'point', 'reframe', 'payoff', 'tease']) assert.match(r.stderr, new RegExp(id));
    assert.match(r.stderr, /studio assets examples\/w2-p6-stock\.json/);
    assert.ok(!/Render complete|rendered in/.test(r.stdout + r.stderr));
  });

  it('a spec with no un-sourced beats gets past the guard (it then stops only for a missing timeline)', () => {
    const r = run('examples/w2-p6.json');
    assert.ok(!/still need a still\/clip/.test(r.stderr));
  });
});

describe('studio assets / --pick (end to end, mocked network)', () => {
  let png: Buffer;
  let mp4: Buffer;
  before(() => {
    const d = mkdtempSync(join(tmpdir(), 'ttyng-bytes-'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=108x192:d=1', '-frames:v', '1', join(d, 'a.png')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x996633:s=108x192:d=1:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(d, 'a.mp4')]);
    png = readFileSync(join(d, 'a.png'));
    mp4 = readFileSync(join(d, 'a.mp4'));
  });

  const downloads = (async (url: string) => new Response(new Uint8Array(url.endsWith(".mp4") ? mp4 : png))) as typeof fetch;
  const photoHits = (prefix: string, n: number) => many(n, prefix);
  const clipHit = (id: string) => cand({ id, kind: 'video', durationSec: 8, downloadUrl: `https://cdn/${id}.mp4`, ext: 'mp4' });

  /** A throwaway repo root with the brand fonts (the sheet burns labels in) and a spec with two un-sourced beats. */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'ttyng-assets-'));
    cpSync(join(PROJECT_ROOT, 'brand'), join(root, 'brand'), { recursive: true });
    mkdirSync(join(root, 'assets', 'stills'), { recursive: true });
    const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'examples/w2-p6-stock.json'), 'utf8')) as VideoSpec;
    spec.id = 'pickme';
    spec.beats = spec.beats.filter((b) => ['hook', 'point', 'series_intro'].includes(b.id));
    spec.beats.find((b) => b.id === 'series_intro')!.search_queries = ['countdown six']; // typography beat: literal reading, also needs an asset
    spec.beats.find((b) => b.id === 'point')!.visual = { type: 'still', asset: 'stills/already.jpg', motion: 'pan_left' }; // has an asset -> skipped
    const specFile = join(root, 'pickme.json');
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
    return { root, spec, specFile };
  }
  const deps = (root: string, providers: StockProvider[]) => ({ root, tokens: project.tokens, providers, fetchFn: downloads, now: () => '2026-01-01T00:00:00.000Z' });

  it('downloads up to 4 per beat, labels a sheet, skips beats that have assets, and NEVER picks', async () => {
    const { root, spec, specFile } = setup();
    const specBefore = readFileSync(specFile, 'utf8');
    const providers = [fake('pexels', [...photoHits('p', 6), clipHit('v1')])];
    const r = await searchAssets(JSON.parse(specBefore), deps(root, providers));

    assert.deepEqual(r.beats.map((b) => b.beat_id), ['hook', 'series_intro']);
    assert.equal(r.skipped.length, 1);
    for (const b of r.beats) {
      assert.equal(b.candidates.length, RULES.perBeat);
      assert.deepEqual(b.candidates.map((c) => c.n), [1, 2, 3, 4]);
      const files = readdirSync(join(root, 'assets', 'candidates', b.beat_id));
      assert.equal(files.filter((f) => f !== 'candidates.json').length, RULES.perBeat);
    }
    assert.ok(statSync(r.sheet!).size > 1000);
    assert.equal(r.sheet, join(root, 'out', 'pickme', 'asset-candidates.jpg'));

    // Never-auto-pick invariant: spec, library folders and index are all untouched.
    assert.equal(readFileSync(specFile, 'utf8'), specBefore);
    assert.deepEqual(readdirSync(join(root, 'assets', 'stills')), []);
    assert.ok(!existsSync(join(root, 'assets', 'clips')));
    assert.ok(!existsSync(join(root, 'assets', 'index.json')));
    assert.equal(spec.beats[0].visual.type, 'solid');
  });

  it('falls back to the second provider for a weak beat and says so', async () => {
    const { root, spec } = setup();
    const r = await searchAssets(spec, deps(root, [fake('pexels', photoHits('p', 1)), fake('pixabay', photoHits('x', 5))]));
    const hook = r.beats[0];
    assert.deepEqual(hook.queried, ['pexels', 'pixabay']);
    assert.deepEqual(hook.candidates.map((c) => c.provider), ['pexels', 'pixabay', 'pixabay', 'pixabay']);
  });

  it('offers a matching library asset first, labeled existing, without counting it against the 4 new ones', async () => {
    const { root, spec } = setup();
    writeFileSync(join(root, 'assets', 'stills', 'old.jpg'), png);
    appendLibrary(root, 'stills/old.jpg', {
      provider: 'pexels', source_url: 'https://p/old', creator: 'Olga', license: 'Pexels License',
      search_queries: ['bedroom window night'], picked_at: 't',
    });
    const r = await searchAssets(spec, deps(root, [fake('pexels', photoHits('p', 6))]));
    const hook = r.beats.find((b) => b.beat_id === 'hook')!;
    assert.equal(hook.candidates.length, 1 + RULES.perBeat);
    assert.deepEqual([hook.candidates[0].existing, hook.candidates[0].file, hook.candidates[0].n], [true, 'stills/old.jpg', 1]);
    assert.ok(!r.beats.find((b) => b.beat_id === 'series_intro')!.candidates.some((c) => c.existing)); // unrelated queries
  });

  it('--pick moves the file, rewrites the beat, and appends a full index entry (and keeps old entries)', async () => {
    const { root, spec, specFile } = setup();
    appendLibrary(root, 'stills/keep.jpg', { provider: 'x', source_url: 'u', creator: 'c', license: 'l', search_queries: ['zzz'], picked_at: 't0' });
    const providers = [fake('pexels', [...photoHits('p', 2), clipHit('v1')])];
    await searchAssets(spec, deps(root, providers));

    // hook: candidate 1 (a photo); series_intro: the clip candidate
    const meta = JSON.parse(readFileSync(join(root, 'assets/candidates/series_intro/candidates.json'), 'utf8'));
    const clipN = meta.candidates.find((c: { kind: string }) => c.kind === 'video').n;
    const res = pickAssets(root, specFile, { hook: 1, series_intro: clipN }, () => '2026-01-01T00:00:00.000Z');

    assert.deepEqual(res.map((r) => r.asset), ['stills/pexels-p0.jpg', 'clips/pexels-v1.mp4']);
    assert.ok(existsSync(join(root, 'assets/stills/pexels-p0.jpg')) && existsSync(join(root, 'assets/clips/pexels-v1.mp4')));
    assert.ok(!existsSync(join(root, 'assets/candidates/hook', `1-pexels-p0.jpg`)), 'moved, not copied');

    const after = JSON.parse(readFileSync(specFile, 'utf8')) as VideoSpec;
    assert.deepEqual(after.beats.find((b) => b.id === 'hook')!.visual, { type: 'still', asset: 'stills/pexels-p0.jpg' });
    assert.deepEqual(after.beats.find((b) => b.id === 'series_intro')!.visual, { type: 'clip', asset: 'clips/pexels-v1.mp4' });

    const lib = readLibrary(root);
    assert.equal(lib['stills/keep.jpg'].picked_at, 't0'); // appended, never overwritten
    assert.deepEqual(lib['stills/pexels-p0.jpg'], {
      provider: 'pexels', source_url: 'https://p/1', creator: 'A', license: 'L',
      search_queries: spec.beats.find((b) => b.id === 'hook')!.search_queries, picked_at: '2026-01-01T00:00:00.000Z',
    });
    assert.ok('clips/pexels-v1.mp4' in lib);
  });

  it('--pick of a library candidate reuses it: no move, no new index entry; bad picks change nothing', async () => {
    const { root, spec, specFile } = setup();
    writeFileSync(join(root, 'assets', 'stills', 'old.jpg'), png);
    appendLibrary(root, 'stills/old.jpg', { provider: 'pexels', source_url: 'u', creator: 'c', license: 'l', search_queries: ['bedroom window night'], picked_at: 't0' });
    await searchAssets(spec, deps(root, [fake('pexels', photoHits('p', 4))]));
    const before = readFileSync(specFile, 'utf8');
    const libBefore = readFileSync(join(root, 'assets/index.json'), 'utf8');

    assert.throws(() => pickAssets(root, specFile, { hook: 1, series_intro: 99 }), /no candidate #99/);
    assert.throws(() => pickAssets(root, specFile, { nope: 1 }), /no beat with id/);
    assert.equal(readFileSync(specFile, 'utf8'), before, 'a failed pick must not change the spec');

    const res = pickAssets(root, specFile, { hook: 1 });
    assert.deepEqual(res, [{ beat_id: 'hook', asset: 'stills/old.jpg', moved: false }]);
    assert.equal(readFileSync(join(root, 'assets/index.json'), 'utf8'), libBefore);
    assert.equal((JSON.parse(readFileSync(specFile, 'utf8')) as VideoSpec).beats[0].visual.type, 'still');
  });

  it('contact sheet shows every tile when photos (rgba) and video frames (rgb24) are mixed', () => {
    const { root } = setup();
    const d = mkdtempSync(join(tmpdir(), 'ttyng-tiles-'));
    // Stock and generated PNGs often carry an alpha channel; that is what triggered the bug.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=108x192:d=1', '-frames:v', '1', '-pix_fmt', 'rgba', join(d, 'a.png')]);
    writeFileSync(join(d, 'b.mp4'), mp4);
    const out = join(d, 'sheet.jpg');
    buildCandidateSheet(root, out, [[
      { file: join(d, 'a.png'), kind: 'photo', label: 'x #1' },
      { file: join(d, 'b.mp4'), kind: 'video', label: 'x #2' },
      { file: join(d, 'a.png'), kind: 'photo', label: 'x #3' },
    ]], project.tokens);
    // Regression: a mixed-pixel-format tile sequence once came out as one tile plus black. Sample the middle of each tile.
    const mean = (col: number) => {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `crop=20:20:${col}:300,scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return raw[0] + raw[1] + raw[2];
    };
    for (const tile of [0, 1, 2]) assert.ok(mean(tile * 270 + 100) > 60, `tile ${tile} is black`);
  });

  it('appendLibrary refuses to overwrite an existing key', () => {
    const { root } = setup();
    const e: LibraryEntry = { provider: 'p', source_url: 'u', creator: 'c', license: 'l', search_queries: [], picked_at: 't' };
    appendLibrary(root, 'stills/a.jpg', e);
    assert.throws(() => appendLibrary(root, 'stills/a.jpg', { ...e, creator: 'other' }), /refusing to overwrite/);
    assert.equal(readLibrary(root)['stills/a.jpg'].creator, 'c');
  });
});
