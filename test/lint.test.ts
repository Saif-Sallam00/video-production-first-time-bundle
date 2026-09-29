import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintBatch } from '../src/lint.ts';
import { findPhrase } from '../src/text.ts';
import type { VideoSpec } from '../src/types.ts';
import { errors, errorsAt, lint, makeAssets, makeSpec, project, warningsAt } from './helpers.ts';

describe('the w2-p6 fixture', () => {
  it('has no lint errors', () => {
    assert.deepEqual(errors(lint(makeSpec())), []);
  });
});

describe('error: beat ids unique', () => {
  it('fails on a duplicate id', () => {
    const spec = makeSpec();
    spec.beats[3].id = 'point';
    assert.equal(errorsAt(lint(spec), '/beats/3/id').length, 1);
  });
  it('passes with unique ids', () => {
    assert.deepEqual(errorsAt(lint(makeSpec()), '/beats/3/id'), []);
  });
});

describe('error: at most one hook beat', () => {
  it('fails on a second hook', () => {
    const spec = makeSpec();
    spec.beats[4].role = 'hook';
    assert.equal(errorsAt(lint(spec), '/beats/4/role').length, 1);
  });
  it('passes with a single hook', () => {
    assert.deepEqual(errorsAt(lint(makeSpec()), '/beats/4/role'), []);
  });
});

describe('error: cta_pop.start.beat_id exists', () => {
  it('fails on an unknown beat', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { beat_id: 'nope', phrase: 'follow so you' };
    assert.equal(errorsAt(lint(spec), '/cta_pop/start/beat_id').length, 1);
  });
  it('passes on a known beat', () => {
    assert.deepEqual(errorsAt(lint(makeSpec()), '/cta_pop/start/beat_id'), []);
  });
});

describe('error: cta_pop phrase found in the beat vo', () => {
  it('fails when the phrase is in another beat', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { beat_id: 'series_intro', phrase: 'awkward is normal' };
    assert.equal(errorsAt(lint(spec), '/cta_pop/start/phrase').length, 1);
  });
  it('fails when words are not contiguous', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { beat_id: 'series_intro', phrase: 'follow you' };
    assert.equal(errorsAt(lint(spec), '/cta_pop/start/phrase').length, 1);
  });
  it('passes ignoring case and punctuation', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { beat_id: 'series_intro', phrase: 'FOLLOW, so you dont' };
    assert.deepEqual(errorsAt(lint(spec), '/cta_pop/start/phrase'), []);
  });
  it('matches across a curly apostrophe and skips standalone dashes', () => {
    assert.deepEqual(findPhrase('That’s not it going wrong — that’s real', "wrong that's"), {
      wordIndex: 4,
      charOffset: 20,
    });
  });
});

describe('error: asset exists under assets/', () => {
  const assetsDir = makeAssets(['stills/a.jpg', 'clips/b.mp4', 'music/m.mp3']);
  const withVisual = (visual: VideoSpec['beats'][number]['visual']) => {
    const spec = makeSpec();
    spec.beats[2].visual = visual;
    return lint(spec, { assetsDir });
  };
  it('fails on a missing still', () => {
    assert.equal(errorsAt(withVisual({ type: 'still', asset: 'stills/missing.jpg' }), '/beats/2/visual/asset').length, 1);
  });
  it('fails on a missing clip', () => {
    assert.equal(errorsAt(withVisual({ type: 'clip', asset: 'clips/missing.mp4' }), '/beats/2/visual/asset').length, 1);
  });
  it('fails on a directory', () => {
    assert.equal(errorsAt(withVisual({ type: 'still', asset: 'stills' }), '/beats/2/visual/asset').length, 1);
  });
  it('fails on a path escaping assets/', () => {
    assert.equal(errorsAt(withVisual({ type: 'still', asset: '../SPEC.md' }), '/beats/2/visual/asset').length, 1);
  });
  it('fails on missing music', () => {
    const spec = makeSpec();
    spec.music = { file: 'music/missing.mp3', license_note: 'Artlist #123' };
    assert.equal(errorsAt(lint(spec, { assetsDir }), '/music/file').length, 1);
    spec.music.file = 'm.mp3'; // relative to assets/, not assets/music/
    assert.equal(errorsAt(lint(spec, { assetsDir }), '/music/file').length, 1);
  });
  it('passes on existing still, clip and music', () => {
    assert.deepEqual(errorsAt(withVisual({ type: 'still', asset: 'stills/a.jpg' }), '/beats/2/visual/asset'), []);
    assert.deepEqual(errorsAt(withVisual({ type: 'clip', asset: 'clips/b.mp4' }), '/beats/2/visual/asset'), []);
    const spec = makeSpec();
    spec.music = { file: 'music/m.mp3', license_note: 'Artlist #123' };
    assert.deepEqual(errorsAt(lint(spec, { assetsDir }), '/music/file'), []);
  });
});

describe('error: color token exists', () => {
  it('fails on an unknown solid color', () => {
    const spec = makeSpec();
    spec.beats[2].visual = { type: 'solid', color: 'hot_pink' };
    assert.equal(errorsAt(lint(spec), '/beats/2/visual/color').length, 1);
  });
  it('fails on an unknown typography color', () => {
    const spec = makeSpec();
    spec.beats[4].visual = { type: 'typography', text: 'Hi', color: 'hot_pink' };
    assert.equal(errorsAt(lint(spec), '/beats/4/visual/color').length, 1);
  });
  it('fails on an inherited object key', () => {
    const spec = makeSpec();
    spec.beats[2].visual = { type: 'solid', color: 'constructor' };
    assert.equal(errorsAt(lint(spec), '/beats/2/visual/color').length, 1);
  });
  it('passes on token colors', () => {
    const spec = makeSpec();
    spec.beats[4].visual = { type: 'typography', text: 'Hi', color: 'accent' };
    assert.deepEqual(errorsAt(lint(spec), '/beats/4/visual/color'), []);
    assert.deepEqual(errorsAt(lint(spec), '/beats/2/visual/color'), []); // bg_alt
  });
});

describe('error: text box fits the safe zone at its token size', () => {
  const longWord = 'Incomprehensibilitiesincomprehensibilities';
  const assertError = (spec: VideoSpec, path: string, pattern: RegExp, tokens = project.tokens) => {
    const found = errorsAt(lint(spec, { tokens }), path);
    assert.equal(found.length, 1, `expected one error at ${path}`);
    assert.match(found[0].message, pattern);
  };

  it('fails a label that is wider than one line', () => {
    const spec = makeSpec();
    spec.series!.label = 'WWWWW WWWWW WWWWW WWWWW WWWWW WWWWW WWW';
    assertError(spec, '/series/label', /one line/);
  });
  it('fails a hook_slam overlay with an unbreakable word', () => {
    const spec = makeSpec();
    spec.beats[0].overlay!.text = `Your ${longWord}`;
    assertError(spec, '/beats/0/overlay/text', /max is 880 px \(safe width\)/);
  });
  it('fails an overlay taller than the safe zone', () => {
    const spec = makeSpec();
    const tokens = structuredClone(project.tokens);
    tokens.safe_zone.bottom = 1500; // leaves 200 px of safe height
    assertError(spec, '/beats/0/overlay/text', /safe height is 200 px/, tokens);
  });
  it('fails card and kicker overlays with an unbreakable word', () => {
    const spec = makeSpec();
    spec.beats[2].overlay = { text: longWord, style: 'card' };
    // 796 px lowercase, 958 px uppercase at 40 px: only fails because kickers are measured uppercased.
    spec.beats[3].overlay = { text: 'incomprehensibilitiesincomprehensibility', style: 'kicker' };
    assertError(spec, '/beats/2/overlay/text', /px wide at 64 px/);
    assertError(spec, '/beats/3/overlay/text', /INCOMPREHENSIBILITIESINCOMPREHENSIBILITY/);
  });
  it('fails a statement over 3 lines', () => {
    const spec = makeSpec();
    spec.beats[4].visual = {
      type: 'typography',
      text: 'Awkward is normal and it passes every single time you let it happen without panicking',
    };
    assertError(spec, '/beats/4/visual/text', /max is 3/);
  });
  it('fails a hook_slam over 4 lines, passes at 4', () => {
    const spec = makeSpec();
    spec.beats[0].overlay!.text =
      'Your first time will not look like anything you have seen on a screen and that is good news for you';
    assertError(spec, '/beats/0/overlay/text', /wraps to 5 lines .*max is 4/);
    spec.beats[0].overlay!.text = 'Your first time will not look like anything you have seen on a screen and that is good';
    assert.deepEqual(errorsAt(lint(spec), '/beats/0/overlay/text'), []);
  });
  it('fails a card over 3 lines, passes at 3', () => {
    const spec = makeSpec();
    spec.beats[2].overlay = { text: 'Pauses happen. Something will be awkward and somebody might laugh out loud.', style: 'card' };
    assertError(spec, '/beats/2/overlay/text', /wraps to 4 lines .*max is 3/);
    spec.beats[2].overlay = { text: 'Pauses happen. Something gets awkward. Somebody laughs.', style: 'card' };
    assert.deepEqual(errorsAt(lint(spec), '/beats/2/overlay/text'), []);
  });
  it('fails a kicker over 1 line, passes on 1', () => {
    const spec = makeSpec();
    spec.beats[2].overlay = { text: 'Nobody tells you this part about the first time', style: 'kicker' };
    assertError(spec, '/beats/2/overlay/text', /one line/);
    spec.beats[2].overlay = { text: 'Nobody tells you this', style: 'kicker' };
    assert.deepEqual(errorsAt(lint(spec), '/beats/2/overlay/text'), []);
  });
  it('fails an end card over 2 lines, passes at 2', () => {
    const spec = makeSpec();
    spec.end_card = { enabled: true, text: 'Follow for part seven, it takes all the pressure off you' };
    assertError(spec, '/end_card/text', /wraps to 3 lines .*max is 2/);
    spec.end_card = { enabled: true, text: 'Follow for part seven tomorrow' };
    assert.deepEqual(errorsAt(lint(spec), '/end_card/text'), []);
  });
  it('counts card padding: a word that fits the safe width but not inside the padding', () => {
    const spec = makeSpec();
    // 810 px at 64 px: under the 880 px safe width, over 880 - 2 × 36 = 808.
    spec.beats[2].overlay = { text: 'Antidisestablishmentarian', style: 'card' };
    assertError(spec, '/beats/2/overlay/text', /max is 808 px \(safe width minus padding\)/);
    spec.beats[2].overlay.style = 'hook_slam';
    spec.beats[2].overlay.text = 'Antidisestablishment';
    assert.deepEqual(errorsAt(lint(spec), '/beats/2/overlay/text'), []);
  });
  it('counts pill padding, but not horizontal padding on the full-width bar', () => {
    const spec = makeSpec();
    // 824 px at 44 px: over 880 - 2 × 32 = 816 for the pill, under 880 for the bar's text.
    spec.cta_pop!.text = 'Follow now for every part of this series';
    assertError(spec, '/cta_pop/text', /max is 816 px/);
    spec.cta_pop!.style = 'bar';
    assert.deepEqual(errorsAt(lint(spec), '/cta_pop/text'), []);
  });
  it('fails a number too wide for one line', () => {
    const spec = makeSpec();
    spec.beats[1].visual = { type: 'typography', style: 'number', text: '123456789' };
    assertError(spec, '/beats/1/visual/text', /safe width/);
  });
  it('fails a caption word too wide for a line', () => {
    const spec = makeSpec();
    spec.beats[2].vo = `Six: ${longWord}.`;
    assertError(spec, '/beats/2/vo', /at 58 px/);
  });
  it('skips caption words when captions are off', () => {
    const spec = makeSpec();
    spec.beats[2].vo = `Six: ${longWord}.`;
    spec.captions = { enabled: false };
    assert.deepEqual(errorsAt(lint(spec), '/beats/2/vo'), []);
  });
  it('fails a CTA pop wider than one line', () => {
    const spec = makeSpec();
    spec.cta_pop!.text = 'WWWWW WWWWW WWWWW WWWWW WWWWW WWWWW WWW';
    assertError(spec, '/cta_pop/text', /one line/);
  });
  it('fails an enabled end card with an unbreakable word', () => {
    const spec = makeSpec();
    spec.end_card = { enabled: true, text: longWord };
    assertError(spec, '/end_card/text', /safe width/);
  });
  it('passes every text box in the fixture', () => {
    const spec = makeSpec();
    spec.end_card = { enabled: true, text: 'Follow for part 7' };
    assert.deepEqual(errors(lint(spec)), []);
  });
});

describe('error: CTA pop box overlaps an overlay box in the same time range', () => {
  it('fails a bar over an upper overlay on screen at the same time', () => {
    const spec = makeSpec();
    spec.beats[0].overlay!.position = 'upper';
    spec.cta_pop!.style = 'bar';
    assert.equal(errorsAt(lint(spec), '/beats/0/overlay').length, 1);
  });
  it('fails a pill over a center overlay when captions are off', () => {
    const spec = makeSpec();
    // 4-line hook centered on the canvas spans y 758-1162; with captions off the pill sits at y 1136-1224.
    spec.beats[0].overlay!.text = 'Your first time will not look like anything you have seen on a screen and that is good';
    spec.captions = { enabled: false };
    assert.equal(errorsAt(lint(spec), '/beats/0/overlay').length, 1);
  });
  it('passes when the boxes overlap but the times do not', () => {
    const spec = makeSpec();
    spec.beats[0].overlay!.position = 'upper';
    spec.cta_pop = { text: 'Follow for all 7', start: { beat_id: 'tease', phrase: 'number five next' }, style: 'bar' };
    assert.deepEqual(errorsAt(lint(spec), '/beats/0/overlay'), []);
  });
  it('passes the fixture: pill under the captions, hook centered above them', () => {
    assert.deepEqual(errorsAt(lint(makeSpec()), '/beats/0/overlay'), []);
  });
});

describe('warning: CTA pop later than 5.0 s', () => {
  it('warns on at_sec over 5', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { at_sec: 6 };
    assert.equal(warningsAt(lint(spec), '/cta_pop/start/at_sec').length, 1);
  });
  it('warns on a phrase deep into the VO (~9 s in)', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { beat_id: 'series_intro', phrase: 'follow so you' };
    const found = warningsAt(lint(spec), '/cta_pop/start');
    assert.equal(found.length, 1);
    assert.match(found[0].message, /~9\.2 s/);
  });
  it('passes on at_sec 5 and on a phrase in the hook', () => {
    const spec = makeSpec();
    spec.cta_pop!.start = { at_sec: 5 };
    assert.deepEqual(warningsAt(lint(spec), '/cta_pop/start/at_sec'), []);
    assert.deepEqual(warningsAt(lint(makeSpec()), '/cta_pop/start'), []); // fixture: hook, ~4.3 s
  });
});

describe('warning: full VO over ~1,100 characters', () => {
  const vo = 'x'.repeat(399);
  it('warns at 1,101 characters', () => {
    const spec = makeSpec();
    spec.beats = spec.beats.slice(0, 3).map((b) => ({ ...b, vo })); // 3 × 399 + 2 spaces = 1,199
    spec.beats[2].vo = 'x'.repeat(301); // 399 + 399 + 301 + 2 = 1,101
    spec.cta_pop = undefined;
    assert.equal(warningsAt(lint(spec), '/beats').length, 1);
  });
  it('passes at 1,100 characters', () => {
    const spec = makeSpec();
    spec.beats = spec.beats.slice(0, 3).map((b) => ({ ...b, vo }));
    spec.beats[2].vo = 'x'.repeat(300);
    spec.cta_pop = undefined;
    assert.deepEqual(warningsAt(lint(spec), '/beats'), []);
  });
});

describe('warning: ai_generated_label false with any TTS voice', () => {
  it('warns when false', () => {
    const spec = makeSpec();
    spec.disclosure = { ai_generated_label: false };
    assert.equal(warningsAt(lint(spec), '/disclosure/ai_generated_label').length, 1);
  });
  it('passes when true or omitted (defaults to true)', () => {
    assert.deepEqual(warningsAt(lint(makeSpec()), '/disclosure/ai_generated_label'), []);
    const spec = makeSpec();
    delete spec.disclosure;
    assert.deepEqual(warningsAt(lint(spec), '/disclosure/ai_generated_label'), []);
  });
});

describe("warning: captions_hidden beat whose on-screen text mostly diverges from its vo", () => {
  const beatIndex = (spec: VideoSpec) => spec.beats.findIndex((b) => b.id === 'payoff_statement');

  it('warns when the typography text shares under 50% of its words with the vo', () => {
    const spec = makeSpec();
    const i = beatIndex(spec);
    spec.beats[i].visual = { type: 'typography', text: 'Something else entirely, not related', style: 'statement' };
    assert.equal(warningsAt(lint(spec), `/beats/${i}/captions_hidden`).length, 1);
  });
  it('passes on the fixture, where the typography text mostly repeats the vo', () => {
    const spec = makeSpec();
    assert.deepEqual(warningsAt(lint(spec), `/beats/${beatIndex(spec)}/captions_hidden`), []);
  });
  it('does not apply when captions_hidden is not set, even with no overlap at all', () => {
    const spec = makeSpec();
    const i = beatIndex(spec);
    spec.beats[i].captions_hidden = false;
    spec.beats[i].visual = { type: 'typography', text: 'Something else entirely, not related', style: 'statement' };
    assert.deepEqual(warningsAt(lint(spec), `/beats/${i}/captions_hidden`), []);
  });
  it('checks overlay text too, combined with typography when both are present', () => {
    const spec = makeSpec();
    const i = beatIndex(spec);
    // The typography text alone is a full match; an unrelated overlay text pulls the combined overlap
    // under 50%.
    spec.beats[i].overlay = { text: 'unrelated words that do not appear anywhere else at all', style: 'kicker' };
    assert.equal(warningsAt(lint(spec), `/beats/${i}/captions_hidden`).length, 1);
  });
});

describe('warning (batch): 3+ consecutive specs open the same way', () => {
  const entry = (file: string, style?: 'hook_slam' | 'card' | 'kicker', visual: 'solid' | 'typography' = 'solid') => {
    const spec = makeSpec();
    spec.beats[0].visual = visual === 'solid' ? { type: 'solid' } : { type: 'typography', text: 'Hi' };
    if (style) spec.beats[0].overlay = { text: 'Hi', style };
    else delete spec.beats[0].overlay;
    return { file, spec };
  };
  it('warns on 3 in a row, naming the files', () => {
    const issues = lintBatch([entry('a', 'card'), entry('b', 'hook_slam'), entry('c', 'hook_slam'), entry('d', 'hook_slam')]);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /3 consecutive .*hook_slam overlay on solid.*: b, c, d/);
  });
  it('treats an omitted overlay style as card, and no overlay as its own value', () => {
    const noStyle = entry('b');
    noStyle.spec.beats[0].overlay = { text: 'Hi' };
    assert.equal(lintBatch([entry('a', 'card'), noStyle, entry('c', 'card')]).length, 1);
    assert.equal(lintBatch([entry('a'), entry('b'), entry('c')]).length, 1);
  });
  it('passes when the style or the visual type varies', () => {
    assert.deepEqual(lintBatch([entry('a', 'card'), entry('b', 'card'), entry('c', 'hook_slam'), entry('d', 'card')]), []);
    assert.deepEqual(lintBatch([entry('a', 'card'), entry('b', 'card', 'typography'), entry('c', 'card')]), []);
  });
});
