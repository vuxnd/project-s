// Tests for the check, build and traces commands: spawned against fixture roots, and run in process against temporary repositories.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { run as runBuild } from '../commands/build.ts';
import { run as runCheck } from '../commands/check.ts';
import { run as runTraces } from '../commands/traces.ts';
import { discover } from '../lib/discover.ts';
import { writeGenerated } from '../lib/gen.ts';
import { formatJson, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const COMPOSE = `${FIXTURES}/ok-compose`;
const TRACES = `${FIXTURES}/ok-traces`;

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'repo', 'cli.ts'), ...args], { encoding: 'utf8' });
  return { status, stdout, stderr };
}

// Removes what a spawned command wrote under build/ for a fixture root, when the test ends.
function cleanBuild(t: TestContext, root: string): string {
  const dir = path.join(repoRoot, 'build', ...root.split('/'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Files = Record<string, Json | string>;

// A temporary repository that has the real schemas/ folder and the given files (repo-relative path -> JSON or text).
function tempRepo(t: TestContext, files: Files): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRoot, 'schemas'), path.join(dir, 'schemas'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, ...file.split('/'));
    if (typeof content === 'string') writeText(abs, content);
    else writeJson(abs, content);
  }
  return dir;
}

// Runs a command in this process against a temporary repository, collecting what it prints.
function runIn(t: TestContext, command: (args: string[], repoRoot: string) => number | Promise<number>, dir: string, ...args: string[]): { status: number | Promise<number>; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (...parts: unknown[]) => { out.push(parts.join(' ')); });
  t.mock.method(console, 'error', (...parts: unknown[]) => { err.push(parts.join(' ')); });
  return { status: command(args, dir), out, err };
}

// An app on node and a game demo that selects it; `extra` adds files.
function app(extra: Files = {}): Files {
  return {
    'modules/app/module.json': { id: 'app', summary: 'x', hosts: { node: 'ts/index.ts' } },
    'modules/app/ts/index.ts': 'export {};\n',
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules: { app: {} } },
    ...extra,
  };
}

// The command checks generated files too, and only ok-code of the fixture roots commits them, so it is the clean root for the command.
test('check on a clean root exits 0 and prints the summary line only', () => {
  assert.deepEqual(cli('check', '--root', `${FIXTURES}/ok-code`), { status: 0, stdout: 'check: 0 errors, 0 warnings in 1 roots\n', stderr: '' });
});

test('check on no-provider exits 1 and prints the formatted problem, then the summary', () => {
  const r = cli('check', '--root', `${FIXTURES}/no-provider`);
  assert.equal(r.status, 1);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], `${FIXTURES}/no-provider/games/demo/game.json#/modules: contract api has no implementation selected; add one of: impl [no-provider]`);
  assert.deepEqual(lines.slice(1, -2).map((line) => line.replace(/^.*\[(.*)\]$/, '$1')), ['gen-stale', 'gen-stale', 'gen-stale']);
  assert.deepEqual(lines.slice(-2), ['check: 4 errors, 0 warnings in 1 roots', '']);
});

test('check on ok-compose reports only the types.gen.ts files it does not commit', () => {
  const r = cli('check', '--root', COMPOSE);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.split('\n').slice(0, -2).map((line) => line.replace(/^.*\[(.*)\]$/, '$1')), ['gen-stale', 'gen-stale', 'gen-stale', 'gen-stale', 'gen-stale']);
});

test('check counts a warning without failing, and sorts the problems of several roots together', (t) => {
  const dir = tempRepo(t, {
    'one/modules/old/module.json': { id: 'old', summary: 'x', deprecated: 'Use new.' },
    'one/modules/user/module.json': { id: 'user', summary: 'x', requires: ['old'] },
    'two/modules/lost/module.json': { id: 'lost', summary: 'x', requires: ['ghost'] },
  });
  for (const root of ['one', 'two']) writeGenerated(discover(dir, root, createValidator(dir)));
  const warned = runIn(t, runCheck, dir, '--root', 'one');
  assert.equal(warned.status, 0);
  assert.equal(warned.out.length, 2);
  assert.match(warned.out[0], /^warning: one\/modules\/user\/module\.json#\/requires\/0: .* \[deprecated\]$/);
  assert.equal(warned.out[1], 'check: 0 errors, 1 warnings in 1 roots');
  const both = runIn(t, runCheck, dir, '--root', 'two', '--root', 'one');
  assert.deepEqual([both.status, both.out.map((line) => line.replace(/^.*\[(.*)\]$/, '$1'))], [1, ['deprecated', 'unknown-module', 'check: 1 errors, 1 warnings in 2 roots']]);
});

test('check without --root, with a positional or an unknown option, or with a root that is not a folder of the repository exits 2', () => {
  for (const args of [[], ['--root'], ['--root', '.', 'extra'], ['--bogus', '--root', '.']]) {
    const r = cli('check', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.notEqual(r.stderr, '', args.join(' '));
  }
  for (const root of ['nowhere', '../x', '/etc', 'C:/x', 'a\\b', 'package.json']) {
    assert.deepEqual(cli('check', '--root', root), { status: 2, stdout: '', stderr: `no such root: ${root}\n` }, root);
  }
});

test('build with_extra for node writes the bundle and says where', (t) => {
  const dir = cleanBuild(t, COMPOSE);
  const r = cli('build', 'with_extra', '--host', 'node', '--root', COMPOSE);
  const file = `build/${COMPOSE}/games/with_extra/node/bundle.json`;
  assert.deepEqual(r, { status: 0, stdout: `wrote ${file}\n`, stderr: '' });
  const written = path.join(dir, 'games', 'with_extra', 'node', 'bundle.json');
  const parsed = readJson(written);
  assert.ok(parsed.ok);
  assert.equal(readText(written), formatJson(parsed.value));
  assert.deepEqual(createValidator(repoRoot).validate('schemas/bundle.schema.json', parsed.value, file), []);
  assert.deepEqual((parsed.value as { game: string; host: string }).game, 'with_extra');
});

test('build for a host the game does not list exits 1 with game-host and writes nothing', (t) => {
  const dir = cleanBuild(t, COMPOSE);
  const r = cli('build', 'with_extra', '--host', 'web', '--root', COMPOSE);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`^${COMPOSE}/games/with_extra/game\\.json#/hosts: .* \\[game-host\\]\\n$`));
  assert.equal(fs.existsSync(path.join(dir, 'games', 'with_extra', 'web')), false);
});

test('build that fails on the composition exits 1 and prints the problem without a wrote line', (t) => {
  cleanBuild(t, `${FIXTURES}/no-provider`);
  const r = cli('build', 'demo', '--host', 'node', '--root', `${FIXTURES}/no-provider`);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[no-provider\]\n$/);
  assert.doesNotMatch(r.stdout, /wrote/);
});

test('build usage errors exit 2: missing or repeated arguments, an unknown game, a root that is not a folder', () => {
  for (const args of [[], ['with_extra'], ['with_extra', '--host', 'node'], ['--host', 'node', '--root', COMPOSE], ['a', 'b', '--host', 'node', '--root', COMPOSE],
    ['with_extra', '--host', 'node', '--host', 'web', '--root', COMPOSE], ['with_extra', '--host', 'node', '--root', COMPOSE, '--root', COMPOSE], ['with_extra', '--bogus', '--host', 'node', '--root', COMPOSE]]) {
    const r = cli('build', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.notEqual(r.stderr, '', args.join(' '));
  }
  assert.deepEqual(cli('build', 'nope', '--host', 'node', '--root', COMPOSE), { status: 2, stdout: '', stderr: 'unknown game: nope\n' });
  assert.deepEqual(cli('build', 'with_extra', '--host', 'node', '--root', 'nowhere'), { status: 2, stdout: '', stderr: 'no such root: nowhere\n' });
});

test('traces for node writes one trace bundle for ok-traces and says how many', (t) => {
  const dir = cleanBuild(t, TRACES);
  const r = cli('traces', '--host', 'node', '--root', TRACES);
  assert.deepEqual(r, { status: 0, stdout: 'traces: wrote 1 trace bundles\n', stderr: '' });
  const written = path.join(dir, 'traces', 'node', 'impl', 'api.basic.json');
  const parsed = readJson(written);
  assert.ok(parsed.ok);
  assert.equal(readText(written), formatJson(parsed.value));
  assert.deepEqual(createValidator(repoRoot).validate('schemas/trace-bundle.schema.json', parsed.value, written), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'traces', 'node')), ['impl']);
});

test('traces deletes the folder of each requested host before writing, and leaves the others', (t) => {
  const dir = cleanBuild(t, TRACES);
  writeText(path.join(dir, 'traces', 'node', 'stale.json'), '{}\n');
  writeText(path.join(dir, 'traces', 'python', 'keep.json'), '{}\n');
  const r = cli('traces', '--host', 'node', '--root', TRACES);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'traces', 'node', 'stale.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'traces', 'python', 'keep.json')), true);
});

test('traces on a root with a bad trace exits 1 with the problem, and writes no bundle for it', (t) => {
  const dir = cleanBuild(t, `${FIXTURES}/trace-unknown`);
  const r = cli('traces', '--host', 'node', '--root', `${FIXTURES}/trace-unknown`);
  assert.equal(r.status, 1);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], new RegExp(`^${FIXTURES}/trace-unknown/modules/api/conformance/bad\\.json#/expect/0/call: .* \\[trace-unknown\\]$`));
  assert.deepEqual(lines.slice(1), ['traces: wrote 0 trace bundles', '']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'traces', 'node')), []);
});

test('traces usage errors exit 2: no host or root, a host that is not a name, a root that is not a folder', () => {
  for (const args of [[], ['--host', 'node'], ['--root', TRACES], ['--host', 'node', '--root', TRACES, 'extra'], ['--bogus']]) {
    const r = cli('traces', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.notEqual(r.stderr, '', args.join(' '));
  }
  for (const host of ['..', 'Node', 'a/b', '']) {
    const r = cli('traces', '--host', host, '--root', TRACES);
    assert.deepEqual([r.status, r.stdout], [2, ''], host);
    assert.notEqual(r.stderr, '', host);
  }
  assert.deepEqual(cli('traces', '--host', 'node', '--root', 'nowhere'), { status: 2, stdout: '', stderr: 'no such root: nowhere\n' });
});

test('help lists check, build and traces', () => {
  const r = cli('help');
  assert.equal(r.status, 0);
  for (const name of ['build', 'check', 'traces']) assert.match(r.stdout, new RegExp(`^${name}  .+`, 'm'));
});

test('build writes build/games/<game>/<host>/bundle.json for root . and the file is the canonical text', (t) => {
  const dir = tempRepo(t, app());
  const r = runIn(t, runBuild, dir, 'demo', '--host', 'node', '--root', '.');
  assert.deepEqual([r.status, r.out, r.err], [0, ['wrote build/games/demo/node/bundle.json'], []]);
  const parsed = readJson(path.join(dir, 'build', 'games', 'demo', 'node', 'bundle.json'));
  assert.ok(parsed.ok);
  assert.equal(readText(path.join(dir, 'build', 'games', 'demo', 'node', 'bundle.json')), formatJson(parsed.value));
});

test('build of a game whose game.json discover rejects prints the problem, then unknown game, and exits 2', (t) => {
  const dir = tempRepo(t, app({ 'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules: { app: {} }, extra: 1 } }));
  const r = runIn(t, runBuild, dir, 'demo', '--host', 'node', '--root', '.');
  assert.equal(r.status, 2);
  assert.match(r.out.join('\n'), /^games\/demo\/game\.json#: .* \[schema\]$/);
  assert.deepEqual(r.err, ['unknown game: demo']);
});

test('build fails on a record error of the root even when the game is fine, and writes nothing', (t) => {
  const dir = tempRepo(t, app({
    'modules/kinds/module.json': { id: 'kinds', summary: 'x', types: { item: 'schemas/item.schema.json' } },
    'modules/kinds/schemas/item.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version', 'name'],
      properties: { $schema: { type: 'string' }, $version: { const: 1 }, $comment: { type: 'string' }, name: { type: 'string' } },
    },
    'modules/kinds/content/kinds.item/bad.json': { $version: 1, name: 3 },
  }));
  const r = runIn(t, runBuild, dir, 'demo', '--host', 'node', '--root', '.');
  assert.equal(r.status, 1);
  assert.match(r.out.join('\n'), /modules\/kinds\/content\/kinds\.item\/bad\.json#\/name: .* \[schema\]/);
  assert.equal(r.out.some((line) => line.startsWith('wrote')), false);
  assert.equal(fs.existsSync(path.join(dir, 'build')), false);
});

test('build fails on a record type without a version, which only checkSchemas reports', (t) => {
  const dir = tempRepo(t, app({
    'modules/kinds/module.json': { id: 'kinds', summary: 'x', types: { item: 'schemas/item.schema.json' } },
    'modules/kinds/schemas/item.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: {} },
    'modules/kinds/content/kinds.item/one.json': { $version: 1 },
  }));
  const r = runIn(t, runBuild, dir, 'demo', '--host', 'node', '--root', '.');
  assert.equal(r.status, 1);
  assert.match(r.out.join('\n'), /\[record-type\]/);
  assert.equal(fs.existsSync(path.join(dir, 'build')), false);
});

test('traces writes bundles under build/traces/<host> for root ., creates the folder of a host nobody has, and fails on a content error', (t) => {
  const contract = (extra: Files = {}): Files => ({
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true, operations: { count: { result: 'schemas/count.schema.json' } } },
    'modules/api/schemas/count.schema.json': { $schema: DRAFT, type: 'integer' },
    'modules/api/conformance/t.json': { summary: 'x', fixedHz: 60, ticks: 1, expect: [{ at: 1, call: 'api.count', equals: 0 }] },
    'modules/impl/module.json': { id: 'impl', summary: 'x', implements: ['api'], hosts: { node: 'ts/index.ts' } },
    'modules/impl/ts/index.ts': 'export {};\n',
    ...extra,
  });
  const dir = tempRepo(t, contract());
  const r = runIn(t, runTraces, dir, '--host', 'node', '--host', 'web', '--root', '.');
  assert.deepEqual([r.status, r.out, r.err], [0, ['traces: wrote 1 trace bundles'], []]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'build', 'traces', 'node', 'impl')), ['api.t.json']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'build', 'traces', 'web')), []);

  const broken = tempRepo(t, contract({ 'modules/impl/content/api.thing/one.json': { $version: 1 }, 'modules/api/conformance/other.json': '{' }));
  const failed = runIn(t, runTraces, broken, '--host', 'node', '--root', '.');
  assert.equal(failed.status, 1);
  assert.match(failed.out.join('\n'), /\[unknown-type\]/);
  assert.match(failed.out.join('\n'), /\[json-parse\]/);
  assert.equal(failed.out.at(-1), 'traces: wrote 0 trace bundles');
  assert.deepEqual(fs.readdirSync(path.join(broken, 'build', 'traces', 'node')), []);
});

test('traces still compiles the other traces of a root when one trace file is bad', (t) => {
  const dir = tempRepo(t, {
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true, operations: { count: {} } },
    'modules/api/conformance/good.json': { summary: 'x', fixedHz: 60, ticks: 1, expect: [{ at: 1, call: 'api.count', equals: 0 }] },
    'modules/api/conformance/bad.json': { summary: 'x' },
    'modules/impl/module.json': { id: 'impl', summary: 'x', implements: ['api'], hosts: { node: 'ts/index.ts' } },
    'modules/impl/ts/index.ts': 'export {};\n',
  });
  const r = runIn(t, runTraces, dir, '--host', 'node', '--root', '.');
  assert.equal(r.status, 1);
  assert.equal(r.out.at(-1), 'traces: wrote 1 trace bundles');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'build', 'traces', 'node', 'impl')), ['api.good.json']);
});
