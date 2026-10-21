// Documentation check (plan.md 4.15): the paths a document names exist, its sh commands run, and ARCHITECTURE.md has its sections and contract labels.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { absPath, exists, isDir, isFile, listFiles, toPosix } from './lib/fsx.ts';
import { isObject, parseJson, readJson, readText } from './lib/json.ts';

export interface Span { line: number; text: string }
export interface Command { line: number; text: string; run: boolean }

const HEADINGS = [
  'Repository structure', 'Principles', 'Major systems', 'Module boundaries', 'Data flows', 'Extension mechanisms',
  'Technology integration', 'Backward compatibility', 'Dependency management', 'Testing', 'Deferred', 'Decisions',
];
// Validated but not run: installing, the whole test suite (which runs this check) and a server that does not exit.
const NOT_RUN = ['npm ci', 'npm test', 'npm run serve'];
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
const NOT_A_PATH = /[<>*{} :]/;
const NOT_CHECKED = ['build/', 'node_modules/', 'http'];
const OUTPUT_LINES = 20;

// Every line of the document with its 1-based number and, for a line inside a fenced block, the block's info string; fence lines are left out.
function lines(md: string): { line: number; text: string; info?: string }[] {
  const found: { line: number; text: string; info?: string }[] = [];
  let open: { fence: string; info: string } | undefined;
  md.split(/\r?\n/).forEach((text, i) => {
    const fence = FENCE.exec(text);
    if (open === undefined && fence) {
      open = { fence: fence[1], info: fence[2].trim() };
    } else if (open !== undefined && fence && fence[1][0] === open.fence[0] && fence[1].length >= open.fence.length && fence[2].trim() === '') {
      open = undefined;
    } else {
      found.push(open === undefined ? { line: i + 1, text } : { line: i + 1, text, info: open.info });
    }
  });
  return found;
}

// The text of each code span delimited by single backticks; a span opened by a longer backtick run ends at a run of the same length.
function codeSpans(text: string): string[] {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, length: m[0].length }));
  const spans: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((run, j) => j > i && run.length === runs[i].length);
    if (close < 0) continue;
    if (runs[i].length === 1) spans.push(text.slice(runs[i].at + 1, runs[close].at));
    i = close;
  }
  return spans;
}

// Inline code spans outside fenced blocks that name a repository path by the 4.15 rule.
export function extractPaths(md: string): Span[] {
  return lines(md)
    .filter((l) => l.info === undefined)
    .flatMap((l) => codeSpans(l.text).map((text) => ({ line: l.line, text })))
    .filter((s) => s.text.includes('/') && !NOT_A_PATH.test(s.text) && !NOT_CHECKED.some((start) => s.text.startsWith(start)));
}

// The non-blank lines of every fenced sh block; npm ci, npm test and npm run serve are validated instead of run.
export function extractCommands(md: string): Command[] {
  return lines(md)
    .filter((l) => l.info === 'sh' && l.text.trim() !== '')
    .map((l) => ({ line: l.line, text: l.text.trim(), run: !NOT_RUN.includes(l.text.trim()) }));
}

// The required ## headings that no heading of the document starts with, ignoring case.
export function missingHeadings(md: string): string[] {
  const headings = lines(md).filter((l) => l.info === undefined && l.text.startsWith('## ')).map((l) => l.text.slice(3).trim().toLowerCase());
  return HEADINGS.filter((name) => !headings.some((h) => h.startsWith(name.toLowerCase())));
}

// The `contract C<n>` labels that a description in a schema cites and the document never mentions; schemaTexts maps each schema file to its text.
export function missingContracts(md: string, schemaTexts: Record<string, string>): { label: string; file: string }[] {
  const missing: { label: string; file: string }[] = [];
  for (const [file, text] of Object.entries(schemaTexts)) {
    const parsed = parseJson(text);
    const labels = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      if (!isObject(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'description' && typeof value === 'string') for (const m of value.matchAll(/contract (C\d+)\b/g)) labels.add(m[1]);
        else visit(value);
      }
    };
    if (parsed.ok) visit(parsed.value);
    for (const label of [...labels].sort()) {
      if (!new RegExp(`\\b${label}\\b`).test(md)) missing.push({ label, file });
    }
  }
  return missing;
}

// A command that is not run is valid when the script it names exists, or for npm ci, when the lockfile does.
function valid(repoRoot: string, command: string): boolean {
  if (command === 'npm ci') return isFile(absPath(repoRoot, 'package-lock.json'));
  const parsed = readJson(absPath(repoRoot, 'package.json'));
  const scripts = parsed.ok && isObject(parsed.value) && isObject(parsed.value.scripts) ? parsed.value.scripts : {};
  return Object.hasOwn(scripts, command === 'npm test' ? 'test' : command.slice('npm run '.length));
}

function lastLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-OUTPUT_LINES).map((line) => `  ${line}`);
}

function main(argv: string[]): number {
  if (argv.length === 0) {
    console.error('usage: node tools/repo/docs.ts <file.md>...');
    return 2;
  }
  for (const file of argv) {
    if (!isFile(file)) {
      console.error(`docs: no such file: ${file}`);
      return 2;
    }
  }
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const schemaTexts = Object.fromEntries(listFiles(absPath(repoRoot, 'schemas')).filter((f) => f.endsWith('.schema.json')).map((f) => [`schemas/${f}`, readText(absPath(repoRoot, `schemas/${f}`))]));
  let paths = 0;
  let commands = 0;
  let failures = 0;
  const fail = (line: string): void => {
    console.log(line);
    failures++;
  };

  for (const arg of argv) {
    const file = toPosix(arg);
    const md = readText(arg);
    for (const span of extractPaths(md)) {
      paths++;
      const target = absPath(repoRoot, span.text.replace(/\/$/, ''));
      if (span.text.endsWith('/') ? !isDir(target) : !exists(target)) fail(`${file}:${span.line}: missing path ${span.text}`);
    }
    for (const command of extractCommands(md)) {
      commands++;
      if (!command.run) {
        if (!valid(repoRoot, command.text)) fail(`${file}:${command.line}: command not valid: ${command.text}`);
        continue;
      }
      const result = spawnSync(command.text, { shell: true, stdio: 'pipe', cwd: repoRoot, encoding: 'utf8' });
      if (result.status !== 0) {
        fail(`${file}:${command.line}: command failed (exit ${result.status ?? result.signal}): ${command.text}`);
        for (const line of lastLines(`${result.stdout}${result.stderr}`)) console.log(line);
      }
    }
    if (path.basename(arg) !== 'ARCHITECTURE.md') continue;
    for (const name of missingHeadings(md)) fail(`${file}: missing heading ${name}`);
    for (const { label, file: schema } of missingContracts(md, schemaTexts)) fail(`${file}: contract ${label} cited by ${schema} is not described`);
  }

  console.log(`docs: ${paths} paths, ${commands} commands checked, ${failures} failures`);
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
