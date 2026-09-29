import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignToScript, type TimedToken } from '../src/align.ts';

/** One token per word, 0.5 s each, back to back. */
const wordTokens = (text: string): TimedToken[] =>
  text.split(' ').map((w, i) => ({ text: w, start: i * 0.5, end: i * 0.5 + 0.4 }));

describe('alignToScript', () => {
  it('times each script word from word tokens, keeping punctuation on the script word', () => {
    const words = alignToScript('Six: pauses, happen.', wordTokens('Six pauses happen'), 2);
    assert.deepEqual(words, [
      { text: 'Six:', start: 0, end: 0.4, matched: true },
      { text: 'pauses,', start: 0.5, end: 0.9, matched: true },
      { text: 'happen.', start: 1, end: 1.4, matched: true },
    ]);
  });
  it('uses first-character start and last-character end from character tokens (ElevenLabs)', () => {
    const chars = [...'Hi you'].map((c, i) => ({ text: c, start: i * 0.1, end: i * 0.1 + 0.1 }));
    const words = alignToScript('Hi you', chars, 1);
    assert.deepEqual(words.map((w) => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]), [['Hi', 0, 0.2], ['you', 0.3, 0.6]]);
  });
  it('bridges different tokenization: split contractions, punctuation tokens, curly quotes', () => {
    const tokens: TimedToken[] = [
      { text: 'That', start: 0, end: 0.2 },
      { text: '’s', start: 0.2, end: 0.3 },
      { text: 'not', start: 0.4, end: 0.6 },
      { text: '—', start: null, end: null },
      { text: 'real', start: 0.8, end: 1.0 },
    ];
    const words = alignToScript("That's not — real", tokens, 1.2);
    assert.deepEqual(words.map((w) => [w.text, w.start, w.end, w.matched]), [
      ["That's", 0, 0.3, true],
      ['not', 0.4, 0.6, true],
      ['—', 0.6, 0.8, false], // punctuation-only: interpolated into the gap, not counted as unmatched
      ['real', 0.8, 1.0, true],
    ]);
  });
  it('interpolates an unmatched word by length between its neighbours', () => {
    const tokens = wordTokens('one two three four five six seven eight nine ten');
    tokens[4].text = 'xxxx'; // misrecognized
    const words = alignToScript('one two three four five six seven eight nine ten', tokens, 5);
    assert.equal(words[4].matched, false);
    assert.equal(words[4].start, words[3].end);
    assert.equal(words[4].end, words[5].start);
  });
  it('fails when more than 10% of words are unmatched', () => {
    const tokens = wordTokens('one two three four five six seven eight nine ten');
    tokens[1].text = 'xxx';
    tokens[2].text = 'xxxxx';
    assert.throws(
      () => alignToScript('one two three four five six seven eight nine ten', tokens, 5),
      /2 of 10 words \(20\.0%\) could not be matched/,
    );
  });
  it('allows exactly 10%', () => {
    const tokens = wordTokens('one two three four five six seven eight nine ten');
    tokens[1].text = 'xxx';
    assert.equal(alignToScript('one two three four five six seven eight nine ten', tokens, 5).filter((w) => !w.matched).length, 1);
  });
  it('interpolates to the audio end when the last words are unmatched', () => {
    const tokens = wordTokens('a b c d e f g h i j k l m n o p q r s t');
    tokens[19] = { text: 't', start: null, end: null };
    const words = alignToScript('a b c d e f g h i j k l m n o p q r s t', tokens, 10);
    assert.deepEqual([words[19].start, words[19].end], [words[18].end, 10]);
  });
});
