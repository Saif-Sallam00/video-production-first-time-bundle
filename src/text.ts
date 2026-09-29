import * as fontkit from 'fontkit';
import { join } from 'node:path';
import { breakSentence, textToUnits } from './breaker.ts';
import type { Tokens } from './types.ts';

export type FontRole = 'display' | 'body';

export interface TextMeasure {
  /** Shaped advance width in px (kerning applied). */
  width(text: string, role: FontRole, size: number): number;
}

export function loadMeasure(root: string, tokens: Tokens): TextMeasure {
  const fonts = {
    display: openFont(join(root, tokens.fonts.display.file)),
    body: openFont(join(root, tokens.fonts.body.file)),
  };
  return {
    width: (text, role, size) => (fonts[role].layout(text).advanceWidth / fonts[role].unitsPerEm) * size,
  };
}

function openFont(file: string): fontkit.Font {
  const font = fontkit.openSync(file);
  if (!('layout' in font)) throw new Error(`${file} is a font collection; expected a single font`);
  return font;
}

/**
 * Optimal (Knuth-Plass style) word wrap — same breaker and costs as caption paging (`breakSentence` in
 * `breaker.ts`), using the text box's own `maxLines` so lines are chosen jointly, not greedily, within
 * that real budget. A text needing more lines than `maxLines` comes back as several forced groups of up
 * to `maxLines` lines each, concatenated — the caller (`lint.ts`, via `textBlock`) reports the total
 * line count against the same budget, exactly as it did with the old greedy wrap. Never splits a word.
 * `overflow` is the first word that is wider than `maxWidth` on its own; when set, `lines` is incomplete.
 */
export function wrap(
  text: string,
  maxWidth: number,
  width: (s: string) => number,
  maxLines: number,
): { lines: string[]; overflow?: string } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [] };
  const overflow = words.find((word) => width(word) > maxWidth);
  if (overflow) return { lines: [], overflow };

  const units = textToUnits(words);
  const lineWidth = (us: typeof units) => width(us.map((u) => u.text).join(' '));
  const pages = breakSentence(units, maxLines, maxWidth, lineWidth);
  return { lines: pages.flatMap((page) => page.map((indexes) => indexes.map((i) => words[i]).join(' '))) };
}

export const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Finds `phrase` inside `vo`, ignoring case and punctuation. Words are whitespace-separated, as in
 * the timing model. Returns the index of the first matched word among vo's whitespace-separated
 * words and that word's character offset in `vo`, or null when there is no match.
 */
export function findPhrase(vo: string, phrase: string): { wordIndex: number; charOffset: number } | null {
  const words = [...vo.matchAll(/\S+/g)]
    .map((m, wordIndex) => ({ norm: normalizeWord(m[0]), wordIndex, charOffset: m.index }))
    .filter((w) => w.norm); // standalone punctuation such as "—" can't be matched
  const target = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (target.length === 0) return null;
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((t, j) => words[i + j].norm === t)) {
      return { wordIndex: words[i].wordIndex, charOffset: words[i].charOffset };
    }
  }
  return null;
}
