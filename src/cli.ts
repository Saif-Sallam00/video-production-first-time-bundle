import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadVoiceConfig } from './voice.ts';
import { buildTimeline, writeTimeline, audioVoPath, type Timeline } from './timeline.ts';
import { render } from './render.ts';
import { buildContactSheet } from './qa.ts';
import type { CachedAlignment } from './voice.ts';
import type { Issue } from './types.ts';
import { loadProject, PROJECT_ROOT, validateFile, validateTarget } from './validate.ts';
import { audition, speedAudition, synthesize } from './voice.ts';
import { needsAsset, pickAssets, searchAssets } from './assets/run.ts';
import { pexels } from './assets/pexels.ts';
import { pixabay } from './assets/pixabay.ts';
import type { StockProvider } from './assets/provider.ts';

const USAGE = `usage: studio <command> <spec|dir>

commands:
  validate <spec|dir>   schema check + lint rules; exit 1 on errors
  voice <spec>          TTS + word timings into cache/tts/<hash>/ (cache hit skips TTS)
  voice --audition <spec>
                        hook beat in every American male Kokoro voice -> out/audition/<voice>.wav
  voice --audition-speed <spec>
                        full VO at 0.8/0.85/0.9/1.0x -> out/audition/speed/<speed>.wav, with wpm
  timeline <spec>       out/<id>/timeline.json from the spec + real TTS word timings
  render <spec>         renders templates/ against timeline.json -> out/<id>/<id>.mp4
  qa <spec>             out/<id>/contact-sheet.jpg from the rendered MP4 (SPEC section 10, gate 7 only)
  assets <spec>         stock candidates for beats with search_queries and no still/clip yet
                        -> assets/candidates/<beat>/ + out/<id>/asset-candidates.jpg (never picks)
  assets --pick <spec> <beat_id>=<n> ...
                        moves candidate n into assets/stills|clips, updates the spec, appends assets/index.json`;

const PLANNED: Record<string, string> = {
  make: 'M7',
};

async function main(argv: string[]): Promise<number> {
  const [command, target] = argv;
  if (command === 'validate' && target) return validate(target);
  if (command === 'voice' && target === '--audition' && argv[2]) return voice(argv[2], 'audition');
  if (command === 'voice' && target === '--audition-speed' && argv[2]) return voice(argv[2], 'speed');
  if (command === 'voice' && target && target !== '--audition' && target !== '--audition-speed') return voice(target, 'voice');
  if (command === 'timeline' && target) return timeline(target);
  if (command === 'render' && target) return renderCmd(target);
  if (command === 'qa' && target) return qaCmd(target);
  if (command === 'assets' && target === '--pick' && argv[2] && argv.length > 3) return assetsPickCmd(argv[2], argv.slice(3));
  if (command === 'assets' && target && target !== '--pick') return assetsCmd(target);
  if (command && PLANNED[command]) {
    console.error(`studio ${command}: not implemented yet (milestone ${PLANNED[command]})`);
    return 2;
  }
  console.error(USAGE);
  return 2;
}

function validate(target: string): number {
  if (!existsSync(target)) {
    console.error(`studio validate: ${target} does not exist`);
    return 1;
  }
  const { files, batch } = validateTarget(target, loadProject());
  for (const r of files) {
    console.log(`${relative(process.cwd(), r.file)}${r.issues.length ? '' : '  ok'}`);
    printIssues(r.issues);
  }
  if (batch.length) {
    console.log('batch');
    printIssues(batch);
  }
  const all = [...files.flatMap((r) => r.issues), ...batch];
  const errors = all.filter((i) => i.level === 'error').length;
  const warnings = all.length - errors;
  const specs = `${files.length} spec${files.length === 1 ? '' : 's'}`;
  console.log(`\n${specs}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return errors ? 1 : 0;
}

async function voice(target: string, mode: 'voice' | 'audition' | 'speed'): Promise<number> {
  if (!existsSync(target)) {
    console.error(`studio voice: ${target} does not exist`);
    return 1;
  }
  const project = loadProject();
  const { spec, issues } = validateFile(target, project);
  console.log(relative(process.cwd(), target));
  printIssues(issues);
  if (!spec || issues.some((i) => i.level === 'error')) {
    console.error('studio voice: fix the errors above first');
    return 1;
  }
  const envFile = join(PROJECT_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (mode === 'audition') {
    for (const file of await audition(spec, { root: project.root })) console.log(`  ${relative(process.cwd(), file)}`);
    return 0;
  }
  if (mode === 'speed') {
    for (const r of await speedAudition(spec, { root: project.root })) {
      console.log(`  ${r.speed.toFixed(2)}x  ${relative(process.cwd(), r.file)}  ${r.durationSec.toFixed(2)}s  ${r.wpm.toFixed(0)} wpm`);
    }
    return 0;
  }
  const r = await synthesize(spec, { root: project.root });
  const dir = relative(process.cwd(), r.dir);
  const who = `${r.voice.provider} ${r.voice.voice_id} @ ${r.voice.speed}x`;
  if (r.cached) {
    console.log(`  cache hit: ${dir} (${who}; TTS not called)`);
  } else {
    console.log(`  cache miss: ran ${who} for ${r.text.length} characters -> ${dir}`);
    if (r.trimmedSec > 0) console.log(`  leading silence trimmed: ${r.trimmedSec.toFixed(3)} s`);
  }
  return 0;
}

async function timeline(target: string): Promise<number> {
  if (!existsSync(target)) {
    console.error(`studio timeline: ${target} does not exist`);
    return 1;
  }
  const project = loadProject();
  const { spec, issues: validateIssues } = validateFile(target, project);
  console.log(relative(process.cwd(), target));
  printIssues(validateIssues);
  if (!spec || validateIssues.some((i) => i.level === 'error')) {
    console.error('studio timeline: fix the errors above first');
    return 1;
  }
  const envFile = join(PROJECT_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const r = await synthesize(spec, { root: project.root });
  const alignment = JSON.parse(readFileSync(join(r.dir, 'alignment.json'), 'utf8')) as CachedAlignment;
  const config = loadVoiceConfig(project.root);
  const { timeline: tl, issues } = buildTimeline(
    spec,
    alignment,
    config,
    audioVoPath(project.root, r.dir),
    project.tokens,
    project.measure,
  );
  printIssues(issues);
  if (!tl) {
    console.error('studio timeline: fix the errors above first');
    return 1;
  }
  const file = writeTimeline(project.root, tl);
  console.log(`  wrote ${relative(process.cwd(), file)}`);
  return 0;
}

async function renderCmd(target: string): Promise<number> {
  if (!existsSync(target)) {
    console.error(`studio render: ${target} does not exist`);
    return 1;
  }
  const project = loadProject();
  const { spec, issues } = validateFile(target, project);
  if (!spec || issues.some((i) => i.level === 'error')) {
    console.error('studio render: fix the errors above first (see `studio validate`)');
    return 1;
  }
  // A beat that named search_queries but never became a still/clip would render as a silent blank
  // background. Refuse instead (SPEC M5b): source it with `studio assets`, or drop its search_queries.
  const unsourced = spec.beats.filter(needsAsset).map((b) => b.id);
  if (unsourced.length) {
    console.error(
      `studio render: ${unsourced.length} beat${unsourced.length === 1 ? '' : 's'} still need a still/clip (search_queries but no asset): ${unsourced.join(', ')}\n` +
        `  run \`studio assets ${relative(process.cwd(), target)}\` then \`studio assets --pick ...\`, or remove search_queries from beats meant to stay as they are`,
    );
    return 1;
  }
  const timelineFile = join(project.root, 'out', spec.id, 'timeline.json');
  if (!existsSync(timelineFile)) {
    console.error(`studio render: ${relative(process.cwd(), timelineFile)} not found; run \`studio timeline\` first`);
    return 1;
  }
  const tl = JSON.parse(readFileSync(timelineFile, 'utf8')) as Timeline;
  const output = await render(project.root, tl, project.tokens, project.measure);
  console.log(`  wrote ${relative(process.cwd(), output)}`);
  return 0;
}

async function qaCmd(target: string): Promise<number> {
  if (!existsSync(target)) {
    console.error(`studio qa: ${target} does not exist`);
    return 1;
  }
  const project = loadProject();
  const { spec, issues } = validateFile(target, project);
  if (!spec || issues.some((i) => i.level === 'error')) {
    console.error('studio qa: fix the errors above first (see `studio validate`)');
    return 1;
  }
  const timelineFile = join(project.root, 'out', spec.id, 'timeline.json');
  if (!existsSync(timelineFile)) {
    console.error(`studio qa: ${relative(process.cwd(), timelineFile)} not found; run \`studio timeline\` first`);
    return 1;
  }
  const mp4File = join(project.root, 'out', spec.id, `${spec.id}.mp4`);
  if (!existsSync(mp4File)) {
    console.error(`studio qa: ${relative(process.cwd(), mp4File)} not found; run \`studio render\` first`);
    return 1;
  }
  const tl = JSON.parse(readFileSync(timelineFile, 'utf8')) as Timeline;
  const sheet = buildContactSheet(project.root, mp4File, tl, project.tokens);
  console.log(`  wrote ${relative(process.cwd(), sheet)}`);
  return 0;
}

async function assetsCmd(target: string): Promise<number> {
  if (!existsSync(target)) {
    console.error(`studio assets: ${target} does not exist`);
    return 1;
  }
  const project = loadProject();
  const { spec, issues } = validateFile(target, project);
  if (!spec || issues.some((i) => i.level === 'error')) {
    printIssues(issues);
    console.error('studio assets: fix the errors above first (see `studio validate`)');
    return 1;
  }
  const envFile = join(PROJECT_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const providers: StockProvider[] = [];
  if (process.env.PEXELS_API_KEY) providers.push(pexels(process.env.PEXELS_API_KEY));
  else console.warn('  warning  PEXELS_API_KEY not set in .env; skipping Pexels');
  if (process.env.PIXABAY_API_KEY) providers.push(pixabay(process.env.PIXABAY_API_KEY));
  else console.warn('  warning  PIXABAY_API_KEY not set in .env; no Pixabay fallback');
  if (!providers.length) {
    console.error('studio assets: set PEXELS_API_KEY and/or PIXABAY_API_KEY in .env (both have free tiers)');
    return 1;
  }
  const r = await searchAssets(spec, { root: project.root, tokens: project.tokens, providers });
  console.log(relative(process.cwd(), target));
  for (const s of r.skipped) console.log(`  skipped  ${s}`);
  for (const b of r.beats) {
    const existing = b.candidates.filter((c) => c.existing).length;
    console.log(`  ${b.beat_id}: ${b.candidates.length - existing} new + ${existing} existing (queried ${b.queried.join(' then ') || 'nothing'})`);
    for (const w of b.warnings) console.log(`    warning  ${w}`);
  }
  if (!r.beats.length) console.log('  nothing to do: no beat has search_queries without a still/clip asset');
  if (r.sheet) {
    console.log(`  wrote ${relative(process.cwd(), r.sheet)}`);
    console.log(`  review, then: studio assets --pick ${relative(process.cwd(), target)} <beat_id>=<n> ...`);
  }
  return 0;
}

function assetsPickCmd(target: string, pairs: string[]): number {
  if (!existsSync(target)) {
    console.error(`studio assets --pick: ${target} does not exist`);
    return 1;
  }
  const picks: Record<string, number> = {};
  for (const p of pairs) {
    const m = /^([a-z0-9_]+)=(\d+)$/.exec(p);
    if (!m) {
      console.error(`studio assets --pick: expected <beat_id>=<n>, got "${p}"`);
      return 1;
    }
    picks[m[1]] = Number(m[2]);
  }
  const project = loadProject();
  for (const r of pickAssets(project.root, target, picks)) {
    console.log(`  ${r.beat_id} -> assets/${r.asset}${r.moved ? '' : ' (already in the library)'}`);
  }
  const { issues } = validateFile(target, project);
  printIssues(issues);
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

function printIssues(issues: Issue[]) {
  for (const i of issues) {
    console.log(`  ${i.level.padEnd(7)}  ${i.path ? `${i.path}  ` : ''}${i.message}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  },
);
