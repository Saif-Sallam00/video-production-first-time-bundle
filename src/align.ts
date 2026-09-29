/** A span of audio a TTS provider or recognizer reported: one character, word or recognized word. */
export interface TimedToken {
  text: string;
  start: number | null;
  end: number | null;
}

/** One whitespace-separated word of the script text, punctuation attached (SPEC section 5). */
export interface WordTiming {
  text: string;
  start: number;
  end: number;
  /** False when the timing was interpolated from its neighbours. */
  matched: boolean;
}

const MAX_UNMATCHED_RATIO = 0.1;

const normChars = (s: string) => [...s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];

/**
 * Times every word of `script` from provider tokens. The script is the source of truth: tokens only
 * lend it timings. Characters are matched on letters and digits with a longest-common-subsequence
 * pass, so tokenization, punctuation and small recognition differences don't matter. A word takes its
 * timing from the tokens under its matched characters when at least half of them matched; the rest
 * are interpolated between their neighbours by length. Throws when more than 10% of the words that
 * have letters or digits can't be matched.
 */
export function alignToScript(script: string, tokens: TimedToken[], durationSec: number): WordTiming[] {
  const words = script.split(/\s+/).filter(Boolean);
  const a: { c: string; word: number }[] = words.flatMap((w, word) => normChars(w).map((c) => ({ c, word })));
  const b: { c: string; token: number }[] = tokens.flatMap((t, token) =>
    t.start === null || t.end === null ? [] : normChars(t.text).map((c) => ({ c, token })),
  );

  // LCS table, then walk back to pair script characters with token characters.
  const n = a.length;
  const m = b.length;
  const lcs = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] = a[i].c === b[j].c ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  const hits = words.map(() => ({ count: 0, start: Infinity, end: -Infinity }));
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i].c === b[j].c && lcs[at(i, j)] === lcs[at(i + 1, j + 1)] + 1) {
      const t = tokens[b[j].token];
      const h = hits[a[i].word];
      h.count++;
      h.start = Math.min(h.start, t.start!);
      h.end = Math.max(h.end, t.end!);
      i++;
      j++;
    } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) i++;
    else j++;
  }

  const lengths = words.map((w) => normChars(w).length);
  const out: WordTiming[] = words.map((text, i) => {
    const ok = lengths[i] > 0 && hits[i].count >= lengths[i] / 2;
    return { text, start: ok ? hits[i].start : NaN, end: ok ? hits[i].end : NaN, matched: ok };
  });

  const countable = lengths.filter((l) => l > 0).length;
  const unmatched = out.filter((w, i) => !w.matched && lengths[i] > 0).length;
  if (unmatched > countable * MAX_UNMATCHED_RATIO) {
    const pct = ((unmatched / countable) * 100).toFixed(1);
    throw new Error(`${unmatched} of ${countable} words (${pct}%) could not be matched to audio timings; max is 10%`);
  }

  // Interpolate each run of unmatched words across the gap between its matched neighbours.
  for (let i = 0; i < out.length; ) {
    if (out[i].matched) {
      i++;
      continue;
    }
    let k = i;
    while (k < out.length && !out[k].matched) k++;
    const from = i > 0 ? out[i - 1].end : 0;
    const to = Math.max(from, k < out.length ? out[k].start : durationSec);
    const weights = out.slice(i, k).map((_, r) => Math.max(1, lengths[i + r]));
    const total = weights.reduce((s, w) => s + w, 0);
    let t = from;
    for (let r = i; r < k; r++) {
      out[r].start = t;
      t += ((to - from) * weights[r - i]) / total;
      out[r].end = t;
    }
    i = k;
  }
  return out;
}
