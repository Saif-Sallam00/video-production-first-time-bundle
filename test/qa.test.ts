import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contactSheetTimes } from '../src/qa.ts';
import type { Timeline } from '../src/timeline.ts';

const baseTimeline: Timeline = {
  id: 't',
  duration_sec: 10,
  audio: { vo: 'audio.wav', music: null },
  label: null,
  beats: [
    { id: 'a', start: 0, end: 4, visual: { type: 'solid' } },
    { id: 'b', start: 4, end: 10, visual: { type: 'solid' } },
  ],
  words: [],
  caption_pages: [
    { start: 0, end: 2, lines: [['Hi']], word_indexes: [0, 0] },
    { start: 2, end: 4, lines: [['there.']], word_indexes: [1, 1] },
  ],
  caption_style: 'word_highlight',
  cta_pop: null,
  end_card: null,
};

describe('contactSheetTimes', () => {
  it('includes t=0, every beat midpoint and every caption page midpoint, sorted', () => {
    // beats: a(0-4)->2, b(4-10)->7; caption pages: (0-2)->1, (2-4)->3.
    assert.deepEqual(contactSheetTimes(baseTimeline), [0, 1, 2, 3, 7]);
  });

  it('adds the CTA pop midpoint when present', () => {
    const timeline = { ...baseTimeline, cta_pop: { text: 'Follow', start: 5, end: 7, style: 'pill' as const } };
    assert.deepEqual(contactSheetTimes(timeline), [0, 1, 2, 3, 6, 7]);
  });

  it('dedupes an exact coincidence between two midpoints', () => {
    // Beat "b"'s midpoint (7) exactly matches a new caption page's midpoint (6-8).
    const timeline: Timeline = {
      ...baseTimeline,
      caption_pages: [...baseTimeline.caption_pages, { start: 6, end: 8, lines: [['x']], word_indexes: [2, 2] }],
    };
    const times = contactSheetTimes(timeline);
    assert.deepEqual(times, [0, 1, 2, 3, 7]);
    assert.equal(times.filter((t) => t === 7).length, 1);
  });
});
