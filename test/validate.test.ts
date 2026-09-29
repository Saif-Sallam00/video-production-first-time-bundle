import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/validate.ts';
import { makeSpec, project } from './helpers.ts';

describe('schema', () => {
  it('accepts the fixture', () => {
    assert.deepEqual(project.checkSchema(makeSpec()), []);
  });
  it('requires the first beat to be the hook', () => {
    const spec = makeSpec();
    spec.beats[0].role = 'body';
    assert.deepEqual(
      project.checkSchema(spec).map((i) => i.path),
      ['/beats/0/role'],
    );
  });
  it('reports one error for a visual matching no shape', () => {
    const spec = makeSpec() as unknown as { beats: { visual: object }[] };
    spec.beats[2].visual = { type: 'still' }; // missing asset
    assert.deepEqual(project.checkSchema(spec), [
      { level: 'error', path: '/beats/2/visual', message: 'does not match any allowed shape' },
    ]);
  });
  it('rejects music without a license_note', () => {
    const spec = makeSpec() as unknown as Record<string, unknown>;
    spec.music = { file: 'track.mp3' };
    assert.equal(project.checkSchema(spec).length, 1);
  });
});

describe('studio validate', () => {
  const studio = (...args: string[]) =>
    spawnSync(process.execPath, [join(PROJECT_ROOT, 'bin/studio.js'), 'validate', ...args], { encoding: 'utf8' });
  const writeSpecs = (specs: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ttyng-specs-'));
    for (const [file, spec] of Object.entries(specs)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), typeof spec === 'string' ? spec : JSON.stringify(spec));
    }
    return dir;
  };

  it('exits 0 on the fixture with no warnings', () => {
    const r = studio(join(PROJECT_ROOT, 'examples/w2-p6.json'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 spec: 0 errors, 0 warnings/);
  });
  it('exits 1 on lint errors', () => {
    const spec = makeSpec();
    spec.beats[1].id = 'hook';
    const r = studio(join(writeSpecs({ 'bad.json': spec }), 'bad.json'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /duplicate beat id "hook"/);
  });
  it('exits 1 on invalid JSON', () => {
    const r = studio(join(writeSpecs({ 'broken.json': '{ "id": ' }), 'broken.json'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /invalid JSON/);
  });
  it('exits 1 on a missing path', () => {
    assert.equal(studio('/nope/nothing.json').status, 1);
  });
  it('validates a dir in natural order and runs the batch lint', () => {
    const specs = Object.fromEntries(
      ['w2/w2-p10.json', 'w2/w2-p9.json', 'w2/w2-p8.json'].map((f) => [f, { ...makeSpec(), id: f.slice(3, -5) }]),
    );
    const r = studio(writeSpecs(specs));
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /batch\n.*3 consecutive specs .*w2-p8\.json, .*w2-p9\.json, .*w2-p10\.json/);
    assert.match(r.stdout, /3 specs: 0 errors, 1 warning\b/);
  });
});
