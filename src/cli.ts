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
  qa <spec>             out/<id>/contact-sheet.jpg from the rendered MP4 (SPEC section 10, gate 7 only)`;

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
