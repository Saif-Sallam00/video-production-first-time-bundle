import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBannedWords } from './generated.ts';
import { lintBatch, lintSpec, type LintContext } from './lint.ts';
import { loadMeasure } from './text.ts';
import type { Issue, Tokens, VideoSpec } from './types.ts';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Project extends LintContext {
  root: string;
  checkSchema: (data: unknown) => Issue[];
}

export function loadProject(root = PROJECT_ROOT): Project {
  const tokens = readJson(join(root, 'brand/tokens.json')) as Tokens;
  // prefixItems + items and the untyped allOf branch are valid 2020-12; these strict checks just flag the style.
  const ajv = new Ajv2020({ allErrors: true, strictTuples: false, strictTypes: false });
  const validate = ajv.compile(readJson(join(root, 'schema/video.schema.json')) as object);
  return {
    root,
    tokens,
    assetsDir: join(root, 'assets'),
    measure: loadMeasure(root, tokens),
    bannedWords: () => readBannedWords(root),
    checkSchema: (data) => (validate(data) ? [] : schemaIssues(validate.errors ?? [])),
  };
}

/**
 * With allErrors, a failed oneOf also reports every branch's own complaints, which is mostly noise
 * (e.g. "must be equal to constant" for each visual type that wasn't chosen). Keep the oneOf error
 * and drop the branch errors beneath it.
 */
function schemaIssues(errors: ErrorObject[]): Issue[] {
  const oneOfPaths = errors.filter((e) => e.keyword === 'oneOf').map((e) => e.schemaPath.replace(/\/oneOf$/, '/oneOf/'));
  return errors
    .filter((e) => e.keyword === 'oneOf' || !oneOfPaths.some((p) => e.schemaPath.startsWith(p)))
    .map((e) => ({
      level: 'error',
      path: e.instancePath,
      message: e.keyword === 'oneOf' ? 'does not match any allowed shape' : `${e.message}${formatParams(e)}`,
    }));
}

function formatParams(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  if (e.keyword === 'additionalProperties') return ` ("${p.additionalProperty}")`;
  if (e.keyword === 'enum') return ` (${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')})`;
  if (e.keyword === 'const') return ` (${JSON.stringify(p.allowedValue)})`;
  return '';
}

export interface FileResult {
  file: string;
  /** Present when the spec parsed and passed the schema. */
  spec?: VideoSpec;
  issues: Issue[];
}

export function validateFile(file: string, project: Project): FileResult {
  let data: unknown;
  try {
    data = readJson(file);
  } catch (e) {
    return { file, issues: [{ level: 'error', path: '', message: (e as Error).message }] };
  }
  const schemaErrors = project.checkSchema(data);
  if (schemaErrors.length) return { file, issues: schemaErrors };
  const spec = data as VideoSpec;
  return { file, spec, issues: lintSpec(spec, project) };
}

/** A single spec file, or every .json under a directory in natural order (w2 before w10). */
export function collectSpecFiles(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(target, f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function validateTarget(target: string, project: Project): { files: FileResult[]; batch: Issue[] } {
  const files = collectSpecFiles(target).map((f) => validateFile(f, project));
  const isDir = statSync(target).isDirectory();
  const valid = files.flatMap((r) => (r.spec ? [{ file: relative(process.cwd(), r.file), spec: r.spec }] : []));
  return { files, batch: isDir ? lintBatch(valid) : [] };
}

function readJson(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
}
