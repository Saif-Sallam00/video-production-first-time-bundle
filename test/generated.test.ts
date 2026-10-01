import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { readLibrary } from '../src/assets/library.ts';
import { probeSize } from '../src/assets/run.ts';
import { ingestGenerated, writePrompts } from '../src/generated.ts';
import type { VideoSpec } from '../src/types.ts';
import { PROJECT_ROOT } from '../src/validate.ts';
import { errors, lint, makeAssets, makeSpec, project } from './helpers.ts';

const png = (file: string, size: string) => {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${size}`, '-frames:v', '1', file]);
};

/** A temp project root with a generated-mode spec: beats hook + body_1 have prompts, the rest are typography. */
function setup(style = 'Flat ink illustration, warm dusk palette.') {
  const root = mkdtempSync(join(tmpdir(), 'ttyng-gen-'));
  mkdirSync(join(root, 'brand'));
  writeFileSync(
    join(root, 'brand/image-style.md'),
    `# x\n<!-- STYLE-BLOCK-START -->\n${style}\n<!-- STYLE-BLOCK-END -->\nrules\n`,
  );
  const spec = makeSpec();
  spec.id = 'gen-test';
  spec.image_mode = 'generated';
  spec.beats = spec.beats.slice(0, 3).map((b, i) => ({
    id: b.id, role: b.role, vo: b.vo,
    visual: { type: 'typography' as const, text: 'x' },
    ...(i < 2 ? { image_prompt: `a single hand ${i}` } : {}),
  }));
  const specFile = join(root, 'spec.json');
  writeFileSync(specFile, JSON.stringify(spec));
  return { root, spec, specFile };
}

describe('generated-images mode: schema + lint', () => {
  it('accepts image_mode and image_prompt', () => {
    const spec = makeSpec();
    spec.image_mode = 'generated';
    spec.beats[0].image_prompt = 'a heart';
    assert.deepEqual(project.checkSchema(spec), []);
  });
  it('rejects an unknown image_mode', () => {
    const spec = makeSpec() as unknown as Record<string, unknown>;
    spec.image_mode = 'stock';
    assert.equal(project.checkSchema(spec).length, 1);
  });
  it('requires image_prompt on still/clip beats only in generated mode', () => {
    const spec = makeSpec();
    const assetsDir = makeAssets(['stills/a.jpg']);
    spec.beats[1].visual = { type: 'still', asset: 'stills/a.jpg' };
    const at = () => errors(lint(spec, { assetsDir })).filter((e) => e.path === '/beats/1/image_prompt');
    assert.deepEqual(at(), []);
    spec.image_mode = 'generated';
    assert.equal(at().length, 1);
    spec.beats[1].image_prompt = 'a brain';
    assert.deepEqual(at(), []);
  });
});

describe('banned words', () => {
  const lintPrompt = (text: string) => {
    const spec = makeSpec();
    spec.image_mode = 'generated';
    spec.beats[0].image_prompt = text;
    return errors(lint(spec)).filter((e) => e.path === '/beats/0/image_prompt');
  };
  it('fails a whole-word, case-insensitive match from the file list', () => {
    assert.match(lintPrompt('Two people HUG, a Couple')[0].message, /hug, couple/);
    assert.equal(lintPrompt('a single hand holding a key').length, 0);
  });
  it('is whole-word only: "bedrock" and "sextant" do not trip', () => {
    assert.equal(lintPrompt('a bedrock slab, a sextant').length, 0);
    assert.equal(lintPrompt('a bed').length, 1);
  });
  it('is not applied outside generated mode', () => {
    const spec = makeSpec();
    spec.beats[0].image_prompt = 'a bed';
    assert.equal(errors(lint(spec)).filter((e) => e.path === '/beats/0/image_prompt').length, 0);
  });
});

describe('studio prompts', () => {
  it('writes style block + image_prompt with the save path per beat', () => {
    const { root, spec } = setup();
    const out = readFileSync(writePrompts(root, spec), 'utf8');
    assert.ok(out.includes('assets/generated/gen-test/hook.png'));
    assert.ok(out.includes('Flat ink illustration, warm dusk palette.\nThe subject must be exactly one of: a single figure, a brain, a heart, hands, an object, or a symbol.\n\na single hand 0'));
    assert.ok(!/NEVER|undress/i.test(out), 'no negative list in the prompt text');
    assert.equal((out.match(/^## /gm) ?? []).length, 2, 'only beats with an image_prompt');
  });
  it('refuses while the style block is the TODO placeholder', () => {
    const { root, spec } = setup('TODO: paste it');
    assert.throws(() => writePrompts(root, spec), /style block is still empty/);
  });
  it('the shipped brand/image-style.md has its markers and hard rules', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'brand/image-style.md'), 'utf8');
    assert.ok(text.includes('STYLE-BLOCK-START') && text.includes('STYLE-BLOCK-END'));
    assert.match(text, /NEVER two bodies touching, beds, undressing/);
  });
});

describe('studio ingest', () => {
  it('lists missing and bad files and changes nothing', () => {
    const { root, spec, specFile } = setup();
    png(join(root, 'assets/generated/gen-test/hook.png'), '800x1200'); // too narrow
    const before = readFileSync(specFile, 'utf8');
    const r = ingestGenerated(root, specFile);
    assert.deepEqual(r.missing.map((m) => m.beat_id), [spec.beats[1].id]);
    assert.match(r.rejected[0].reason, /width 800/);
    assert.equal(readFileSync(specFile, 'utf8'), before);
    assert.ok(!existsSync(join(root, 'assets/stills')));
  });
  it('accepts .jpg, .jpeg and .webp as well as .png', () => {
    const { root, spec, specFile } = setup();
    png(join(root, `assets/generated/gen-test/${spec.beats[0].id}.jpg`), '1024x1536');
    png(join(root, `assets/generated/gen-test/${spec.beats[1].id}.webp`), '1024x1536');
    const r = ingestGenerated(root, specFile);
    assert.equal(r.converted.length, 2);
    assert.equal(readLibrary(root)[r.converted[1].asset].source_url, `assets/generated/gen-test/${spec.beats[1].id}.webp`);
  });
  it('rejects a wrong aspect ratio', () => {
    const { root, spec, specFile } = setup();
    for (const b of spec.beats.slice(0, 2)) png(join(root, `assets/generated/gen-test/${b.id}.png`), '1536x1024');
    assert.match(ingestGenerated(root, specFile).rejected[0].reason, /not close to 2:3 or 9:16/);
  });
  it('converts to jpg, sets visual.asset and indexes as chatgpt-generated; re-running is safe', () => {
    const { root, spec, specFile } = setup();
    const [a, b] = spec.beats;
    png(join(root, `assets/generated/gen-test/${a.id}.png`), '1024x1536');
    png(join(root, `assets/generated/gen-test/${b.id}.png`), '1080x1920');
    const r = ingestGenerated(root, specFile, () => 't');
    assert.deepEqual(r.converted.map((c) => c.asset), [`stills/gen-gen-test-${a.id}.jpg`, `stills/gen-gen-test-${b.id}.jpg`]);
    assert.deepEqual(probeSize(join(root, 'assets', r.converted[0].asset)), { width: 1024, height: 1536 });
    const after = JSON.parse(readFileSync(specFile, 'utf8')) as VideoSpec;
    assert.deepEqual(after.beats[0].visual, { type: 'still', asset: r.converted[0].asset });
    assert.equal(after.beats[2].visual.type, 'typography', 'beats without image_prompt are untouched');
    const lib = readLibrary(root);
    assert.equal(lib[r.converted[0].asset].provider, 'chatgpt-generated');
    assert.equal(ingestGenerated(root, specFile).converted.length, 2); // idempotent, no duplicate-index throw
  });
});
