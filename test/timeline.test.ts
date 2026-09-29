import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildTimeline, paginateCaptions, type TimelineWord } from '../src/timeline.ts';
import { GLUE_WORDS } from '../src/breaker.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { loadVoiceConfig, type CachedAlignment } from '../src/voice.ts';
import { errors, makeSpec, project } from './helpers.ts';

/** One word per index, 0.5s apart, 0.4s long — same convention as align.test.ts. */
const words = (texts: string[]): TimelineWord[] =>
  texts.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, beat_id: 'b' }));

describe('paginateCaptions', () => {
  it('breaks a short sentence into its own page even under the line limit', () => {
    const w = words(['Hi', 'there.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages, [{ start: 0, end: 5, lines: [['Hi', 'there.']], word_indexes: [0, 1] }]);
  });

  it('splits a long, unpunctuated run into word-balanced pages, not greedy-full-then-leftover', () => {
    // 10 words don't fit in caption.max_lines=2 lines at the real caption pixel width, forcing a
    // split into pages of close (not necessarily exactly equal) word counts — never a one-word line,
    // never a page under 3 words, and never a wildly lopsided greedy-full-then-short-leftover split.
    const w = words(Array.from({ length: 10 }, (_, i) => `word${i}`));
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[0].word_indexes, [0, 3]);
    assert.deepEqual(pages[1].word_indexes, [4, 9]);
    for (const p of pages) {
      for (const l of p.lines) assert.ok(l.length > 1, `one-word line: ${JSON.stringify(l)}`);
      const words = p.lines.flat().length;
      assert.ok(words >= 3 && words <= 7, `page word count too lopsided: ${words}`);
    }
    // A page's end is the next page's start; the last page runs to totalEnd.
    assert.equal(pages[0].end, w[4].start);
    assert.equal(pages[1].end, 5);
  });

  it('never forces a page under 3 words when balance-splitting a long sentence', () => {
    // 9 words needs 3 lines (4+4+1) -> over max_lines=2, so it splits into 2 pages. An even word split
    // (5/4) keeps both pages at or above the 3-word floor.
    const w = words([...Array.from({ length: 8 }, (_, i) => `word${i}`), 'word8.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.equal(pages.length, 2);
    for (const p of pages) assert.ok(p.lines.flat().length >= 3, `page has fewer than 3 words: ${JSON.stringify(p.lines)}`);
  });

  it('never splits a word even when it alone exceeds the caption line width', () => {
    const w = words(['a-word-longer-than-the-whole-caption-line', 'ok']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(
      pages.flatMap((p) => p.lines),
      [['a-word-longer-than-the-whole-caption-line'], ['ok']],
    );
  });

  it('packs two whole short sentences onto one page when both fit', () => {
    const w = words(['Ok', 'now.', 'Good', 'day.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages.map((p) => p.lines), [
      [
        ['Ok', 'now.'],
        ['Good', 'day.'],
      ],
    ]);
  });

  it('never starts a page on just the opening word(s) of a sentence it can\'t finish', () => {
    // "Ok now." is one line; the second sentence needs two more lines (four words per line, per the
    // char-budget test above), so all three lines can't fit on one caption.max_lines=2 page.
    const w = words(['Ok', 'now.', 'word0', 'word1', 'word2', 'word3', 'word4', 'word5', 'word6', 'word7.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages.map((p) => p.lines), [
      [['Ok', 'now.']],
      [
        ['word0', 'word1', 'word2', 'word3'],
        ['word4', 'word5', 'word6', 'word7.'],
      ],
    ]);
  });

  it('breaks a line at clause punctuation instead of a further-out, equally-fitting break', () => {
    // "alphabet bravado charlie, delta echo foxtrot golf." doesn't fit caption.max_chars_per_line at
    // the real caption pixel width, forcing a 2-line wrap. The comma sits right after 3 words; the
    // clause-break reward takes that break over an unpunctuated one nearby.
    const w = words(['alphabet', 'bravado', 'charlie,', 'delta', 'echo', 'foxtrot', 'golf.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages[0].lines, [
      ['alphabet', 'bravado', 'charlie,'],
      ['delta', 'echo', 'foxtrot', 'golf.'],
    ]);
  });

  it("doesn't take a clause break that would strand a one-word line", () => {
    // Same shape as above, but the comma now sits after only the first word. Taking that break would
    // leave "alphabet," alone on its line — the one-word-line cost outweighs the clause-break reward.
    const w = words(['alphabet,', 'bravado', 'charlie', 'delta', 'echo', 'foxtrot', 'golf.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages[0].lines, [
      ['alphabet,', 'bravado', 'charlie'],
      ['delta', 'echo', 'foxtrot', 'golf.'],
    ]);
    for (const l of pages[0].lines) assert.ok(l.length > 1, `one-word line: ${JSON.stringify(l)}`);
  });

  it('attaches an em dash to the previous word so a line never starts with one', () => {
    const w = words(['abcdefghijklmnopqrstuvwxyz', '—', 'and', 'more.']);
    const pages = paginateCaptions(w, project.tokens, 5, project.measure);
    assert.deepEqual(pages[0].lines, [['abcdefghijklmnopqrstuvwxyz', '—'], ['and', 'more.']]);
  });

  it('skips a captions_hidden beat entirely, preserving word_indexes into the full word list', () => {
    const w = [
      ...words(['Ok', 'now.']).map((word) => ({ ...word, beat_id: 'visible_a' })),
      ...words(['Hidden', 'text', 'here.']).map((word) => ({ ...word, beat_id: 'hidden' })),
      ...words(['Good', 'day.']).map((word) => ({ ...word, beat_id: 'visible_b' })),
    ];
    const pages = paginateCaptions(w, project.tokens, 5, project.measure, new Set(['hidden']));
    // The two visible sentences pack onto one page, same as if the hidden beat weren't there at all.
    assert.deepEqual(pages.map((p) => p.lines), [
      [
        ['Ok', 'now.'],
        ['Good', 'day.'],
      ],
    ]);
    // word_indexes still point into the full (unfiltered) word list, spanning across the hidden gap.
    assert.deepEqual(pages[0].word_indexes, [0, 6]);
  });

  it("doesn't let a page's caption bleed through a captions_hidden beat that immediately follows it", () => {
    // A continuous timeline: an 8-word sentence (needs exactly caption.max_lines=2 lines, so it packs
    // alone on one page), a captions_hidden beat, then another short sentence.
    const beatIds = [
      ...Array(8).fill('visible_a'),
      ...Array(3).fill('hidden'),
      ...Array(2).fill('visible_b'),
    ];
    const texts = ['word0', 'word1', 'word2', 'word3', 'word4', 'word5', 'word6', 'word7.', 'Hidden', 'text', 'here.', 'Good', 'day.'];
    const w = texts.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, beat_id: beatIds[i] }));
    const pages = paginateCaptions(w, project.tokens, 20, project.measure, new Set(['hidden']));
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[0].lines, [
      ['word0', 'word1', 'word2', 'word3'],
      ['word4', 'word5', 'word6', 'word7.'],
    ]);
    // page 0's caption must disappear where the hidden beat's speech starts (word index 8), not linger
    // all the way to page 1's start.
    assert.equal(pages[0].end, w[8].start);
  });
});

describe('buildTimeline (real fixture alignment)', () => {
  const alignment = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'test/fixtures/w2-p6/alignment.json'), 'utf8'),
  ) as CachedAlignment;
  const config = loadVoiceConfig(project.root);

  it('times beats from real word timings and resolves the CTA pop with no conflicts', () => {
    const spec = makeSpec();
    const { timeline, issues } = buildTimeline(spec, alignment, config, 'cache/tts/x/audio.wav', project.tokens, project.measure);
    assert.deepEqual(errors(issues), []);
    assert.ok(timeline);
    assert.equal(timeline.words.length, spec.beats.reduce((n, b) => n + b.vo.split(/\s+/).length, 0));
    assert.equal(timeline.beats[0].start, 0);
    assert.equal(timeline.beats.at(-1)!.end, timeline.duration_sec);
    assert.equal(timeline.duration_sec, alignment.words.at(-1)!.end + project.tokens.audio.tail_sec);

    // Every beat's start/end line up with its neighbours (visuals cut on speech, not silence).
    for (let i = 1; i < timeline.beats.length; i++) {
      assert.equal(timeline.beats[i].start, timeline.beats[i - 1].end);
    }

    // CTA resolves from the phrase inside the hook beat, before the 5s "late" warning threshold.
    assert.ok(timeline.cta_pop);
    assert.ok(timeline.cta_pop!.start > 0 && timeline.cta_pop!.start < 5);
    assert.equal(timeline.cta_pop!.end, timeline.cta_pop!.start + 2.5);

    // Every word appears on exactly one caption page, in order (QA gate 4) — except words from a
    // `captions_hidden` beat (the fixture's payoff beat), which never appear on any page.
    const covered = timeline.caption_pages.flatMap((p) =>
      Array.from({ length: p.word_indexes[1] - p.word_indexes[0] + 1 }, (_, i) => p.word_indexes[0] + i),
    );
    const hiddenBeatIds = new Set(spec.beats.filter((b) => b.captions_hidden).map((b) => b.id));
    const expected = timeline.words.flatMap((w, i) => (hiddenBeatIds.has(w.beat_id) ? [] : [i]));
    assert.deepEqual(covered, expected);
    assert.ok(hiddenBeatIds.size > 0, 'fixture no longer has a captions_hidden beat to exercise this');
  });

  it('never strands "you;" or "performance." alone on their own page (previously reported orphans)', () => {
    const spec = makeSpec();
    const { timeline } = buildTimeline(spec, alignment, config, 'cache/tts/x/audio.wav', project.tokens, project.measure);
    for (const text of ['you;', 'performance.']) {
      const page = timeline!.caption_pages.find((p) => p.lines.flat().includes(text));
      assert.ok(page, `no caption page contains "${text}"`);
      assert.ok(page!.lines.flat().length > 1, `"${text}" is alone on its page: ${JSON.stringify(page!.lines)}`);
    }
  });

  it('never leaves a one-word line or a line ending on a glue word in the real fixture', () => {
    const spec = makeSpec();
    const { timeline } = buildTimeline(spec, alignment, config, 'cache/tts/x/audio.wav', project.tokens, project.measure);
    for (const page of timeline!.caption_pages) {
      for (const line of page.lines) {
        assert.ok(line.length > 1, `one-word line: ${JSON.stringify(line)}`);
        const last = line.at(-1)!.toLowerCase().replace(/[^\p{L}]/gu, '');
        assert.ok(!GLUE_WORDS.has(last), `line ends on glue word "${line.at(-1)}": ${JSON.stringify(line)}`);
      }
    }
  });

  it('reports the CTA-vs-overlay conflict with real timings, not just estimates', () => {
    const spec = makeSpec();
    spec.beats[1].overlay = { text: 'Blocks the bar', style: 'kicker', position: 'upper' };
    spec.cta_pop!.style = 'bar'; // full-width, top of the safe zone — same box as an "upper" overlay
    spec.cta_pop!.duration_sec = 4; // stretch the pop into series_intro's overlay
    const { timeline, issues } = buildTimeline(spec, alignment, config, 'audio.wav', project.tokens, project.measure);
    assert.equal(timeline, null);
    assert.equal(errors(issues).length, 1);
    assert.equal(errors(issues)[0].path, '/beats/1/overlay');
  });
});
