// Trace runner for Node (contract C6, plan.md 4.10): runs compiled trace bundles on runtime.ts and prints one PASS or FAIL line for each.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDir, joinPosix, toPosix, walkFiles } from '../../tools/repo/lib/fsx.ts';
import { getPointer, jsonEqual, readJson } from '../../tools/repo/lib/json.ts';
import { createValidator } from '../../tools/repo/lib/validate.ts';
import { load } from './runtime.ts';
import type { Game } from './runtime.ts';
import type { Expectation, TraceBundle } from './trace.ts';

const HOST = 'node';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A value as an expectation line prints it; a pointer step that does not exist is `undefined`.
const show = (value: unknown): string => (value === undefined ? 'undefined' : JSON.stringify(value));

// A call expectation passes on equals, or on near within.
function meets(e: Expectation, value: unknown): boolean {
  if (e.equals !== undefined && jsonEqual(value, e.equals)) return true;
  return e.near !== undefined && typeof value === 'number' && Math.abs(value - e.near) <= (e.within as number);
}

// Compiled bundles carry the fields each form needs (call, within, emitted, count), hence the casts.
function checkCall(game: Game, i: number, e: Expectation, lines: string[]): void {
  const pointer = e.pointer ?? '';
  const value = getPointer(game.call(e.call as string, e.params), pointer);
  if (meets(e, value)) return;
  const want = e.near === undefined ? show(e.equals) : `${show(e.near)} within ${show(e.within)}`;
  lines.push(`  expect[${i}]: ${e.call} ${pointer}: expected ${want}, got ${show(value)}`);
}

// Appends one line per failed expectation to `lines`; an exception from load, tick or call leaves through the caller.
async function execute(tb: TraceBundle, repoRoot: string, lines: string[]): Promise<void> {
  const validator = createValidator(repoRoot);
  const game = await load(tb.bundle, {
    root: pathToFileURL(repoRoot + path.sep).href,
    host: {},
    debug: true,
    validate(schema, value) {
      const errors = validator.errors(schema, value);
      return errors.length === 0 ? null : errors.join('; ');
    },
  });
  const counts = new Map<string, number>();
  for (let t = 0; t <= tb.ticks; t++) {
    for (const [i, e] of tb.expect.entries()) {
      if (e.at === t) checkCall(game, i, e, lines);
    }
    for (const [i, e] of tb.expect.entries()) {
      if (e.by !== t) continue;
      const got = counts.get(e.emitted as string) ?? 0;
      if (got !== e.count) lines.push(`  expect[${i}]: ${e.emitted} : expected ${e.count}, got ${got}`);
    }
    if (t === tb.ticks) break;
    for (const emitted of game.tick(tb.inputs.filter((input) => input.at === t))) {
      counts.set(emitted.event, (counts.get(emitted.event) ?? 0) + 1);
    }
  }
}

export async function runTraceBundle(file: string, tb: TraceBundle, repoRoot: string): Promise<{ ok: boolean; lines: string[] }> {
  if (typeof tb?.trace !== 'string' || typeof tb.implementation !== 'string') {
    return { ok: false, lines: [`FAIL ${file}`, '  error: not a trace bundle'] };
  }
  const lines: string[] = [];
  try {
    if (tb.bundle.host !== HOST) lines.push(`  wrong host ${tb.bundle.host}`);
    else await execute(tb, repoRoot, lines);
  } catch (e) {
    lines.push(`  error: ${messageOf(e)}`);   // module code may throw anything (R21)
  }
  const ok = lines.length === 0;
  return { ok, lines: [`${ok ? 'PASS' : 'FAIL'} ${tb.trace} (${tb.implementation})`, ...lines] };
}

// A file that cannot be read or parsed fails like a bundle that cannot run.
async function runFile(file: string, repoRoot: string): Promise<{ ok: boolean; lines: string[] }> {
  let error: string;
  try {
    const parsed = readJson(file);
    if (parsed.ok) return await runTraceBundle(file, parsed.value as unknown as TraceBundle, repoRoot);
    error = `line ${parsed.line}: ${parsed.message}`;
  } catch (e) {
    error = messageOf(e);
  }
  return { ok: false, lines: [`FAIL ${file}`, `  error: ${error}`] };
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error('usage: node hosts/js/conformance.ts <dir>...');
    return 2;
  }
  for (const dir of argv) {
    if (!isDir(dir)) {
      console.error(`conformance: no such directory: ${dir}`);
      return 2;
    }
  }
  const files = argv.flatMap((dir) => walkFiles(dir).filter((name) => name.endsWith('.json')).map((name) => joinPosix(toPosix(dir), name)));
  if (files.length === 0) {
    console.error('conformance: no trace bundles found');
    return 1;
  }
  const repoRoot = process.cwd();
  let failed = 0;
  for (const file of files) {
    const { ok, lines } = await runFile(file, repoRoot);
    console.log(lines.join('\n'));
    if (!ok) failed++;
  }
  console.log(`${HOST}: ${files.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
