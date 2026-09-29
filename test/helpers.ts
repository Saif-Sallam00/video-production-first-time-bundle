import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lintSpec } from '../src/lint.ts';
import type { Issue, Tokens, VideoSpec } from '../src/types.ts';
import { loadProject, PROJECT_ROOT } from '../src/validate.ts';

export const project = loadProject();

const fixture = JSON.parse(readFileSync(join(PROJECT_ROOT, 'examples/w2-p6.json'), 'utf8')) as VideoSpec;

/** A fresh copy of the w2-p6 fixture to mutate. */
export const makeSpec = (): VideoSpec => structuredClone(fixture);

/** A temp assets/ folder holding the given files. */
export function makeAssets(files: string[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ttyng-')), 'assets');
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function lint(spec: VideoSpec, opts: { assetsDir?: string; tokens?: Tokens } = {}): Issue[] {
  return lintSpec(spec, {
    ...project,
    assetsDir: opts.assetsDir ?? project.assetsDir,
    tokens: opts.tokens ?? project.tokens,
  });
}

export const errorsAt = (issues: Issue[], path: string) =>
  issues.filter((i) => i.level === 'error' && i.path === path);
export const warningsAt = (issues: Issue[], path: string) =>
  issues.filter((i) => i.level === 'warning' && i.path === path);
export const errors = (issues: Issue[]) => issues.filter((i) => i.level === 'error');
