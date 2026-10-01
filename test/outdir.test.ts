import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { outDirOf, outputName } from '../src/outdir.ts';

test('output folder falls back to out/<id>', () => {
  assert.equal(outDirOf('/r', { id: 'a-b' }), join('/r', 'out', 'a-b'));
  assert.equal(outputName({ id: 'a-b' }), 'a-b');
});

test('output_dir sets the folder and names the video after its last folder', () => {
  const t = { id: 'a-b', output_dir: 'week2/day3/slot1-name' };
  assert.equal(outDirOf('/r', t), join('/r', 'out', 'week2/day3/slot1-name'));
  assert.equal(outputName(t), 'slot1-name');
});
