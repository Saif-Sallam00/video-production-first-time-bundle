import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { breakSentence, CLAUSE_END, SENTENCE_END, type Unit } from './breaker.ts';
import { ctaOverlayConflicts, safeRect } from './layout.ts';
import { findPhrase, type TextMeasure } from './text.ts';
import { spokenText, type CachedAlignment, type VoiceConfig } from './voice.ts';
import type { Issue, MotionPresetName, Overlay, Tokens, VideoSpec, Visual } from './types.ts';

const CTA_LATE_SEC = 5.0;
const CTA_DEFAULT_DURATION_SEC = 2.5; // schema default for cta_pop.duration_sec
const END_CARD_DEFAULT_DURATION_SEC = 1.5; // schema default for end_card.duration_sec
const MUSIC_DEFAULT_GAIN_DB = -22; // schema default for music.gain_db

/** One spoken word of the full VO, original spelling (SPEC section 5). */
export interface TimelineWord {
  text: string;
  start: number;
  end: number;
  beat_id: string;
}

export interface TimelineBeat {
  id: string;
  start: number;
  end: number;
  visual: Visual;
  overlay?: Overlay;
  /** Resolved motion preset (the beat's `motion`, else the spec's `motion_preset`); absent = plain Ken Burns. */
  motion?: MotionPresetName;
}

export interface CaptionPage {
  start: number;
  end: number;
  lines: string[][];
  /** [first, last] index into `Timeline.words`, inclusive. */
  word_indexes: [number, number];
}

export interface TimelineCta {
  text: string;
  start: number;
  end: number;
  style: 'pill' | 'bar';
}

export interface Timeline {
  id: string;
  duration_sec: number;
  audio: {
    vo: string;
    /** `file` is relative to the repo root (`assets/...`); schema defaults are already resolved. */
    music: { file: string; gain_db: number; duck_under_vo: boolean } | null;
  };
  label: string | null;
  beats: TimelineBeat[];
  words: TimelineWord[];
  caption_pages: CaptionPage[];
  caption_style: 'word_highlight' | 'phrase' | null;
  cta_pop: TimelineCta | null;
  end_card: { text: string; start: number; duration_sec: number } | null;
}

/**
 * Builds `timeline.json` from the spec and its cached TTS alignment (SPEC section 5). Re-runs the
 * CTA-vs-overlay overlap check and the >5s CTA warning with real word timings, so `issues` may
 * contain errors even for a spec that already passed `validate` (which only has estimated timing).
 */
export function buildTimeline(
  spec: VideoSpec,
  alignment: CachedAlignment,
  config: VoiceConfig,
  audioVoPath: string,
  tokens: Tokens,
  measure: TextMeasure,
): { timeline: Timeline | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const error = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  // Group the spoken (post-pronunciation) word timings back onto the original script's
  // whitespace-separated words: a pronunciation substitution can expand one script word into several
  // spoken words, but captions must show the original spelling, not the spoken form.
  const words: TimelineWord[] = [];
  const beatFirstWord: number[] = [];
  let spokenIndex = 0;
  for (const beat of spec.beats) {
    beatFirstWord.push(words.length);
    for (const original of beat.vo.split(/\s+/).filter(Boolean)) {
      const count = Math.max(1, spokenText(original, config.pronunciations).split(/\s+/).filter(Boolean).length);
      const group = alignment.words.slice(spokenIndex, spokenIndex + count);
      spokenIndex += count;
      const first = group[0];
      const last = group.at(-1) ?? first;
      words.push({ text: original, start: first.start, end: last.end, beat_id: beat.id });
    }
  }

  // Beat start = start of its first word (forced to 0 for the first beat, regardless of any
  // leading-silence remainder). Beat end = start of the next beat's first word; the last beat ends
  // at VO end + tail_sec.
  const beats: TimelineBeat[] = spec.beats.map((beat, i) => {
    const start = i === 0 ? 0 : words[beatFirstWord[i]].start;
    const end = i < spec.beats.length - 1 ? words[beatFirstWord[i + 1]].start : words.at(-1)!.end + tokens.audio.tail_sec;
    const motion = beat.motion ?? spec.motion_preset;
    return { id: beat.id, start, end, visual: beat.visual, ...(beat.overlay ? { overlay: beat.overlay } : {}), ...(motion ? { motion } : {}) };
  });
  const voEnd = beats.at(-1)!.end;

  // CTA pop: resolve to a real time, then re-check the overlap and lateness rules that `validate`
  // could only estimate.
  let cta: TimelineCta | null = null;
  if (spec.cta_pop) {
    const c = spec.cta_pop;
    let start: number | undefined;
    if ('at_sec' in c.start) {
      start = c.start.at_sec;
    } else {
      const { beat_id, phrase } = c.start;
      const beatIdx = spec.beats.findIndex((b) => b.id === beat_id);
      if (beatIdx < 0) {
        error('/cta_pop/start/beat_id', `no beat with id "${beat_id}"`);
      } else {
        const match = findPhrase(spec.beats[beatIdx].vo, phrase);
        if (!match) {
          error('/cta_pop/start/phrase', `"${phrase}" not found in the vo of beat "${beat_id}"`);
        } else {
          start = words[beatFirstWord[beatIdx] + match.wordIndex].start;
        }
      }
    }
    if (start !== undefined) {
      const end = start + (c.duration_sec ?? CTA_DEFAULT_DURATION_SEC);
      cta = { text: c.text, start, end, style: c.style ?? 'pill' };
      if (start > CTA_LATE_SEC) {
        warn('/cta_pop/start', `CTA pop starts at ${start.toFixed(2)} s, later than ${CTA_LATE_SEC.toFixed(1)} s`);
      }
      for (const i of ctaOverlayConflicts(spec, beats, { start, end }, tokens, measure)) {
        error(`/beats/${i}/overlay`, `overlay box overlaps the CTA pop box while both are on screen`);
      }
    }
  }

  // Captions: paginate the original-spelling words, word_highlight and phrase share the same pages.
  const captionsOn = spec.captions?.enabled !== false;
  const captionStyle = captionsOn ? (spec.captions?.style ?? 'word_highlight') : null;
  const hiddenBeats = new Set(spec.beats.filter((b) => b.captions_hidden).map((b) => b.id));
  const pages = captionsOn ? paginateCaptions(words, tokens, voEnd, measure, hiddenBeats) : [];

  const endCard =
    spec.end_card?.enabled && spec.end_card.text
      ? { text: spec.end_card.text, start: voEnd, duration_sec: spec.end_card.duration_sec ?? END_CARD_DEFAULT_DURATION_SEC }
      : null;

  if (issues.some((i) => i.level === 'error')) return { timeline: null, issues };

  const timeline: Timeline = {
    id: spec.id,
    duration_sec: endCard ? voEnd + endCard.duration_sec : voEnd,
    audio: {
      vo: audioVoPath,
      music: spec.music
        ? { file: `assets/${spec.music.file}`, gain_db: spec.music.gain_db ?? MUSIC_DEFAULT_GAIN_DB, duck_under_vo: spec.music.duck_under_vo ?? true }
        : null,
    },
    label: spec.series?.label ?? null,
    beats,
    words,
    caption_pages: pages,
    caption_style: captionStyle,
    cta_pop: cta,
    end_card: endCard,
  };
  return { timeline, issues };
}

/**
 * Groups spoken words into caption pages (SPEC section 7). Each sentence is broken by `breakSentence`,
 * which chooses line and page breaks jointly to minimize cost (pixel line width, not
 * `caption.max_chars_per_line`). A sentence that fits in `caption.max_lines` lines comes back as one
 * packable page and is packed together, in order, with neighbouring sentences that also fit (never
 * splitting one across pages if the next also fits whole — so a page never ends on just the opening
 * word(s) of a sentence it can't finish). A sentence too long for one page comes back as several
 * dedicated pages and is never packed with a neighbouring sentence.
 *
 * A page's end is the next page's start, mirroring how a beat's end is the next beat's start; the
 * last page runs to `totalEnd`.
 */
export function paginateCaptions(
  words: TimelineWord[],
  tokens: Tokens,
  totalEnd: number,
  measure: TextMeasure,
  hiddenBeats: ReadonlySet<string> = new Set(),
): CaptionPage[] {
  const { max_lines: maxLines } = tokens.caption;
  const maxWidth = safeRect(tokens).w;
  const px = tokens.type_scale.caption;
  const lineWidth = (units: Unit[]) => measure.width(units.map((u) => u.text).join(' '), 'body', px);

  // An em dash is its own word (SPEC section 5) but must never start a line, so fold it into the
  // previous unit for wrapping purposes; it still renders as its own word (see `flushPage`). A word
  // from a `captions_hidden` beat (SPEC section 7) is skipped entirely — it's still spoken and still
  // in `timeline.words`, it just never appears on a caption page.
  const allUnits: Unit[] = [];
  words.forEach((w, i) => {
    if (hiddenBeats.has(w.beat_id)) return;
    if (w.text === '—' && allUnits.length) {
      const prev = allUnits.at(-1)!;
      prev.indexes.push(i);
      prev.text += ' —';
      prev.clause = true;
      prev.sentenceEnd = false;
      return;
    }
    allUnits.push({ indexes: [i], text: w.text, clause: CLAUSE_END.test(w.text), sentenceEnd: SENTENCE_END.test(w.text) });
  });

  const sentences: Unit[][] = [];
  let sentence: Unit[] = [];
  for (const u of allUnits) {
    sentence.push(u);
    if (u.sentenceEnd) {
      sentences.push(sentence);
      sentence = [];
    }
  }
  if (sentence.length) sentences.push(sentence);

  // A "block" is the lines for one page. A sentence that fits whole is one packable block; a
  // sentence that doesn't is split into several dedicated (never packed) blocks up front.
  const blocks: { lines: number[][]; dedicated: boolean }[] = [];
  for (const s of sentences) {
    const sentencePages = breakSentence(s, maxLines, maxWidth, lineWidth);
    const dedicated = sentencePages.length > 1;
    for (const lines of sentencePages) blocks.push({ lines, dedicated });
  }

  const pages: CaptionPage[] = [];
  let page: number[][] = [];
  for (const block of blocks) {
    if (block.dedicated) {
      if (page.length) pages.push(flushPage(page, words));
      pages.push(flushPage(block.lines, words));
      page = [];
      continue;
    }
    if (page.length && page.length + block.lines.length > maxLines) {
      pages.push(flushPage(page, words));
      page = [];
    }
    page.push(...block.lines);
  }
  if (page.length) pages.push(flushPage(page, words));

  pages.forEach((p, i) => {
    const nextStart = i < pages.length - 1 ? words[pages[i + 1].word_indexes[0]].start : totalEnd;
    // If a captions_hidden beat's words were skipped right after this page, don't let its caption
    // bleed through that beat all the way to the next visible page — end it where the hidden stretch
    // starts instead.
    const gapWord = words[p.word_indexes[1] + 1];
    p.end = gapWord && hiddenBeats.has(gapWord.beat_id) ? gapWord.start : nextStart;
  });
  return pages;
}

function flushPage(pageLines: number[][], words: TimelineWord[]): CaptionPage {
  const first = pageLines[0][0];
  const last = pageLines.at(-1)!.at(-1)!;
  return {
    start: words[first].start,
    end: 0, // filled by the caller once every page's start is known
    lines: pageLines.map((l) => l.map((i) => words[i].text)),
    word_indexes: [first, last],
  };
}

/** SPEC `studio timeline`: writes `out/<id>/timeline.json`. */
export function writeTimeline(root: string, timeline: Timeline): string {
  const file = join(root, 'out', timeline.id, 'timeline.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(timeline, null, 2) + '\n');
  return file;
}

/** Path to a cached TTS take's audio file, relative to `root` (what `timeline.json` records). */
export const audioVoPath = (root: string, cacheDir: string) => relative(root, join(cacheDir, 'audio.wav'));
