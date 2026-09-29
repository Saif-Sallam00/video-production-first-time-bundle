// Optimal (Knuth-Plass style) line/page breaker, shared by caption paging (`timeline.ts`, which packs
// several sentences' pages together) and single-block text wrapping (`text.ts`, one call = one page).

export const SENTENCE_END = /[.!?]["')]?$/;
export const CLAUSE_END = /[,;:]$/;
export const MIN_WORDS_PER_PAGE = 3;

/** One wrappable chunk: a word, or a word with its trailing standalone em dash attached (rule below). */
export interface Unit {
  /** Word indexes this unit covers, in order (more than one only for a word + its attached "—"). */
  indexes: number[];
  /** Combined display text, used only to measure width for wrapping. */
  text: string;
  /** Ends in clause punctuation (`, ; : —`): a preferred line-break point (SPEC section 7). */
  clause: boolean;
  /** Ends a sentence. */
  sentenceEnd: boolean;
}

export const unitWords = (units: Unit[]) => units.reduce((n, u) => n + u.indexes.length, 0);

/**
 * Splits whitespace-separated `words` into units, folding a standalone em dash into the previous unit
 * (SPEC section 5: an em dash is its own word but must never start a line). `indexes` are positions in
 * `words`.
 */
export function textToUnits(words: string[]): Unit[] {
  const units: Unit[] = [];
  words.forEach((text, i) => {
    if (text === '—' && units.length) {
      const prev = units.at(-1)!;
      prev.indexes.push(i);
      prev.text += ' —';
      prev.clause = true;
      prev.sentenceEnd = false;
      return;
    }
    units.push({ indexes: [i], text, clause: CLAUSE_END.test(text), sentenceEnd: SENTENCE_END.test(text) });
  });
  return units;
}

// Cost tiers for the optimal breaker, heaviest first (SPEC section 7). Each tier is orders of
// magnitude apart so no amount of stacking a lighter cost (or several) can ever match a heavier one —
// e.g. PAGE_BREAK_COST (an extra page) must never be worth paying to dodge GLUE_LINE_END_COST (a line
// ending on a glue word), so the two can't sit at the same order of magnitude.
const ONE_WORD_LINE_COST = 1e12; // very high
const GLUE_LINE_END_COST = 1e9; // high
const PAGE_UNDER_MIN_COST = 1e9; // high
// A flat cost per page, on top of per-line raggedness — otherwise a forced multi-page split is
// cost-indifferent between one full page and several thin ones (per-line raggedness alone is the same
// either way), and the DP could fragment a sentence into more, thinner pages than it needs. Flat (not
// scaled by how many lines went unused) so it discourages extra *pages* without also rewarding padding
// a page out with unnecessary extra *lines* (SPEC: "keep max_lines per page"). Below the high tier: an
// extra page is never worth avoiding a glue-ending line or an under-floor page.
const PAGE_BREAK_COST = 1e6;
const CLAUSE_BREAK_BONUS = -2e4; // reward
const RAGGED_WEIGHT = 0.05; // light — cost = unused px, squared, per line
const PAGE_IMBALANCE_WEIGHT = 3e3; // light — cost = (page words - target words per page) squared

/** Cheap greedy estimate of how many lines `units` needs at `maxWidth` — just to size the page-word
 * imbalance target below, not used for the actual (optimal) line breaks. */
function greedyLineCount(units: Unit[], maxWidth: number, lineWidth: (units: Unit[]) => number): number {
  let i = 0;
  let lines = 0;
  while (i < units.length) {
    let j = i + 1;
    while (j < units.length && lineWidth(units.slice(i, j + 1)) <= maxWidth) j++;
    i = j;
    lines++;
  }
  return lines;
}

export const GLUE_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but',
  'my', 'your', 'his', 'her', 'their', 'our', 'this', 'that', 'is', 'are', 'was',
]);
const endsOnGlueWord = (unit: Unit) => GLUE_WORDS.has(unit.text.toLowerCase().replace(/[^\p{L}]/gu, ''));

/**
 * Optimal (Knuth-Plass style) line + page breaker for one sentence (SPEC section 7). A DP over
 * `(unit index, lines placed in the currently-open page)` chooses, for every candidate line `[i, j)`,
 * whether to keep the page open or close it there, picking whichever path minimizes total cost:
 * a one-word line, a line ending on a glue word, and a page under `MIN_WORDS_PER_PAGE` words are all
 * penalized (unless the whole sentence is shorter than that floor); raggedness (squared unused line
 * width, plus squared page word-count deviation from an even split) is a light cost; breaking right
 * after clause punctuation (`, ; : —`) is rewarded; each additional page beyond the minimum needed
 * costs a flat penalty, so the DP doesn't fragment a sentence into more, thinner pages than it needs. A
 * line never splits a word — a single unit wider than `maxWidth` is still allowed alone on a line,
 * since there is no narrower alternative. Returns one or more pages, each a list of lines of word
 * indexes; more than one page means the sentence didn't fit in `maxLines` and was split. A caller that
 * only wants one page's worth of optimally-wrapped lines passes the box's own real `maxLines` — if the
 * text doesn't fit, it comes back as several forced pages of up to `maxLines` lines each; concatenating
 * them gives the same "wraps to N lines, too many" total a caller can check against `maxLines` (`text.ts`).
 */
export function breakSentence(units: Unit[], maxLines: number, maxWidth: number, lineWidth: (units: Unit[]) => number): number[][][] {
  const n = units.length;
  const totalWords = unitWords(units);
  const estPages = Math.max(1, Math.ceil(greedyLineCount(units, maxWidth, lineWidth) / maxLines));
  const targetWordsPerPage = totalWords / estPages;

  const lineCost = (i: number, j: number): number | undefined => {
    const slice = units.slice(i, j);
    const w = lineWidth(slice);
    if (w > maxWidth && slice.length > 1) return undefined; // doesn't fit; a lone unit is unavoidable overflow
    let cost = Math.max(0, maxWidth - w) ** 2 * RAGGED_WEIGHT;
    if (unitWords(slice) === 1 && totalWords > 1) cost += ONE_WORD_LINE_COST;
    const last = slice.at(-1)!;
    if (endsOnGlueWord(last)) cost += GLUE_LINE_END_COST;
    if (last.clause) cost += CLAUSE_BREAK_BONUS;
    return cost;
  };
  const pageCost = (pageStart: number, end: number): number => {
    const words = unitWords(units.slice(pageStart, end));
    const under = words < MIN_WORDS_PER_PAGE && totalWords >= MIN_WORDS_PER_PAGE;
    const imbalance = (words - targetWordsPerPage) ** 2 * PAGE_IMBALANCE_WEIGHT;
    return (under ? PAGE_UNDER_MIN_COST : 0) + PAGE_BREAK_COST + imbalance;
  };

  interface Cell {
    cost: number;
    prevI: number;
    prevK: number;
    pageStart: number;
  }
  // dp[i][k]: best cost to have broken units[0, i) into complete lines, with `k` of those lines
  // placed in the still-open trailing page (k === 0 means i is itself a page boundary).
  const dp: (Cell | undefined)[][] = Array.from({ length: n + 1 }, () => Array(maxLines).fill(undefined));
  dp[0][0] = { cost: 0, prevI: -1, prevK: -1, pageStart: 0 };

  for (let i = 0; i < n; i++) {
    for (let k = 0; k < maxLines; k++) {
      const cell = dp[i][k];
      if (!cell) continue;
      for (let j = i + 1; j <= n; j++) {
        const lc = lineCost(i, j);
        if (lc === undefined) break; // width only grows with j; no narrower multi-unit line ahead either
        const total = cell.cost + lc;
        const newK = k + 1;
        if (newK < maxLines) {
          const target = dp[j][newK];
          if (!target || total < target.cost) dp[j][newK] = { cost: total, prevI: i, prevK: k, pageStart: cell.pageStart };
        }
        const closedCost = total + pageCost(cell.pageStart, j);
        const target0 = dp[j][0];
        if (!target0 || closedCost < target0.cost) dp[j][0] = { cost: closedCost, prevI: i, prevK: k, pageStart: j };
      }
    }
  }

  const steps: { i: number; j: number; closesPage: boolean }[] = [];
  let curI = n;
  let curK = 0;
  while (curI > 0 || curK > 0) {
    const cell = dp[curI][curK]!;
    steps.push({ i: cell.prevI, j: curI, closesPage: curK === 0 });
    curI = cell.prevI;
    curK = cell.prevK;
  }
  steps.reverse();

  const pages: number[][][] = [];
  let page: number[][] = [];
  for (const step of steps) {
    page.push(units.slice(step.i, step.j).flatMap((u) => u.indexes));
    if (step.closesPage) {
      pages.push(page);
      page = [];
    }
  }
  return pages;
}
