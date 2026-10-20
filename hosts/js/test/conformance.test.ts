// Tests for hosts/js/conformance.ts: hand-written trace bundles run on a module file in a temporary root, output lines of plan.md 4.10.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { main, runTraceBundle } from '../conformance.ts';
import type { Expectation, TraceBundle } from '../trace.ts';

// The module m adds 1 to n per tick and the `by` of every m.bump it is given; its step refuses a fourth tick.
const MODULE = `\
export function init() {
  return { n: 0 };
}

export function step(ctx) {
  if (ctx.tick >= 3) throw new Error('only 3 ticks may run');
  for (const bump of ctx.events('m.bump')) ctx.state.n += bump.by;
  ctx.state.seen = ctx.events('m.bump').map((bump) => bump.by);
  ctx.state.n += 1;
  ctx.emit('m.tock', 0);
  ctx.emit('m.tick', { n: ctx.state.n });
}

export const operations = {
  get: (ctx) => ({ n: ctx.state.n, list: [1.5, 2], flag: true }),
  host: (ctx) => ctx.host,
  nan: () => NaN,
  echo: (ctx, params) => params,
  seen: (ctx) => ctx.state.seen,
  nil: () => null,
};
`;

// After 3 ticks with a bump of 10 given to tick 1, n is 1, 12 and 13 after the ticks; every tick emits m.tick and m.tock.
const PASSING: Expectation[] = [
  { at: 0, call: 'm.get', pointer: '/n', equals: 0 },
  { at: 2, call: 'm.get', equals: { n: 12, list: [1.5, 2], flag: true } },
  { at: 3, call: 'm.get', pointer: '/n', equals: 13 },
  { at: 3, call: 'm.get', pointer: '/list/0', near: 1.4, within: 0.2 },
  { at: 3, call: 'm.get', pointer: '/list/1', near: 2.5, within: 0.5 },
  { by: 3, emitted: 'm.tick', count: 3 },
  { by: 3, emitted: 'm.bump', count: 0 },
  { at: 0, call: 'm.get', pointer: '/n', near: 0, within: 0 },
  { at: 0, call: 'm.nil', equals: null },
];

// A hand-written trace bundle for the module m: 3 ticks at 10 Hz, with one m.bump of 10 given to tick 1.
function traceBundle(name: string, expect: Expectation[]): TraceBundle {
  return {
    trace: `conformance/${name}.json`,
    contract: 'counting',
    implementation: 'm',
    ticks: 3,
    bundle: {
      format: 1, game: `counting.${name}`, host: 'node', fixedHz: 10,
      modules: [{ id: 'm', entry: 'm/ts/index.ts', sees: ['m'], absent: [], packages: [] }],
      contracts: {},
      operations: { 'm.get': 'm', 'm.host': 'm', 'm.nan': 'm', 'm.echo': 'm', 'm.seen': 'm', 'm.nil': 'm' },
      events: { 'm.tick': 'm', 'm.tock': 'm', 'm.bump': 'm' },
      types: {}, config: { m: {} }, records: {}, assets: [],
      schedule: { fixed: ['m.step'], frame: [] },
    },
    inputs: [{ at: 1, event: 'm.bump', payload: { by: 10 } }],
    expect,
  };
}

// A temporary repository root holding the module file m/ts/index.ts; removed when the test ends.
function tempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'm', 'ts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'm', 'ts', 'index.ts'), MODULE);
  return root;
}

// Writes each entry as <root>/<dir>/<name>, a string as it is and anything else as JSON; returns dir.
function writeFiles(root: string, dir: string, files: Record<string, unknown>): string {
  fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, ...dir.split('/'), name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

// The lines runTraceBundle returns for one bundle run in `root`.
async function linesOf(root: string, tb: TraceBundle): Promise<string[]> {
  return (await runTraceBundle(tb.trace, tb, root)).lines;
}

// Runs main(argv) with `root` as the working directory; returns the exit code and the lines it printed to stdout and stderr.
async function runMain(root: string, ...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const cwd = process.cwd();
  console.log = (text: string) => { out.push(...text.split('\n')); };
  console.error = (text: string) => { err.push(...text.split('\n')); };
  process.chdir(root);
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.error = error;
  }
}

test('a passing bundle returns PASS and no detail lines', async (t) => {
  const result = await runTraceBundle('ok.json', traceBundle('ok', PASSING), tempRoot(t));
  assert.deepEqual(result, { ok: true, lines: ['PASS conformance/ok.json (m)'] });
});

test('a failed equals prints the call, the pointer, the expected value and the value it got', async (t) => {
  const expect: Expectation[] = [
    { at: 3, call: 'm.get', pointer: '/n', equals: 14 },
    { at: 2, call: 'm.get', equals: { n: 12, flag: false } },
    { at: 3, call: 'm.get', pointer: '/flag', equals: 1 },
  ];
  const result = await runTraceBundle('eq.json', traceBundle('eq', expect), tempRoot(t));
  assert.equal(result.ok, false);
  assert.deepEqual(result.lines, [
    'FAIL conformance/eq.json (m)',
    '  expect[1]: m.get : expected {"n":12,"flag":false}, got {"n":12,"list":[1.5,2],"flag":true}',
    '  expect[0]: m.get /n: expected 14, got 13',
    '  expect[2]: m.get /flag: expected 1, got true',
  ]);
});

test('a failed near prints the band, and near needs a number at the pointer', async (t) => {
  const expect: Expectation[] = [
    { at: 3, call: 'm.get', pointer: '/list/0', near: 2, within: 0.1 },
    ...['/flag', '/missing', ''].map((pointer) => ({ at: 3, call: 'm.get', pointer, near: 1, within: 5 })),
  ];
  assert.deepEqual(await linesOf(tempRoot(t), traceBundle('near', expect)), [
    'FAIL conformance/near.json (m)',
    '  expect[0]: m.get /list/0: expected 2 within 0.1, got 1.5',
    '  expect[1]: m.get /flag: expected 1 within 5, got true',
    '  expect[2]: m.get /missing: expected 1 within 5, got undefined',
    '  expect[3]: m.get : expected 1 within 5, got {"n":13,"list":[1.5,2],"flag":true}',
  ]);
});

test('a failed count prints an empty pointer and the number of events it counted', async (t) => {
  const expect: Expectation[] = [{ by: 3, emitted: 'm.tick', count: 2 }];
  assert.deepEqual(await linesOf(tempRoot(t), traceBundle('count', expect)), [
    'FAIL conformance/count.json (m)',
    '  expect[0]: m.tick : expected 2, got 3',
  ]);
});

test('a count counts the events ticks 0 to by - 1 returned; an event no module emits counts 0', async (t) => {
  const root = tempRoot(t);
  const counted: Expectation[] = [0, 1, 2, 3].map((by) => ({ by, emitted: 'm.tock', count: by }));
  const silent: Expectation[] = [{ by: 3, emitted: 'ghost.note', count: 0 }, { by: 3, emitted: 'm.bump', count: 0 }];
  assert.deepEqual(await linesOf(root, traceBundle('counted', [...counted, ...silent])), ['PASS conformance/counted.json (m)']);
  assert.deepEqual(await linesOf(root, traceBundle('silent', [{ by: 3, emitted: 'ghost.note', count: 1 }])), [
    'FAIL conformance/silent.json (m)',
    '  expect[0]: ghost.note : expected 1, got 0',
  ]);
});

test('at each tick call expectations are checked before count expectations, each in file order', async (t) => {
  const expect: Expectation[] = [
    { by: 0, emitted: 'm.tick', count: 1 },
    { at: 0, call: 'm.get', pointer: '/n', equals: 5 },
    { by: 0, emitted: 'm.tock', count: 1 },
    { at: 0, call: 'm.get', pointer: '/flag', equals: false },
  ];
  assert.deepEqual(await linesOf(tempRoot(t), traceBundle('order', expect)), [
    'FAIL conformance/order.json (m)',
    '  expect[1]: m.get /n: expected 5, got 0',
    '  expect[3]: m.get /flag: expected false, got true',
    '  expect[0]: m.tick : expected 1, got 0',
    '  expect[2]: m.tock : expected 1, got 0',
  ]);
});

test('a call passes its params, and the inputs of one tick arrive in file order', async (t) => {
  const tb = traceBundle('given', [
    { at: 0, call: 'm.echo', params: { k: [1, 'x'] }, equals: { k: [1, 'x'] } },
    { at: 1, call: 'm.seen', equals: [5] },
    { at: 2, call: 'm.seen', equals: [20, 10] },
    { at: 3, call: 'm.echo', params: 7, equals: 8 },
  ]);
  tb.inputs = [
    { at: 1, event: 'm.bump', payload: { by: 20 } },
    { at: 0, event: 'm.bump', payload: { by: 5 } },
    { at: 1, event: 'm.bump', payload: { by: 10 } },
  ];
  assert.deepEqual(await linesOf(tempRoot(t), tb), ['FAIL conformance/given.json (m)', '  expect[3]: m.echo : expected 8, got 7']);
});

test('a bundle for another host fails with wrong host and does not load', async (t) => {
  const tb = traceBundle('host', PASSING);
  tb.bundle.host = 'python';
  tb.bundle.modules[0].entry = 'm/ts/missing.ts';
  assert.deepEqual(await linesOf(tempRoot(t), tb), ['FAIL conformance/host.json (m)', '  wrong host python']);
});

test('an exception fails the file after the lines already collected and stops it', async (t) => {
  const root = tempRoot(t);
  const thrown = traceBundle('boom', [
    { at: 0, call: 'm.get', pointer: '/n', equals: 99 },
    { at: 4, call: 'm.get', pointer: '/n', equals: 99 },
  ]);
  thrown.ticks = 4;
  assert.deepEqual(await linesOf(root, thrown), [
    'FAIL conformance/boom.json (m)',
    '  expect[0]: m.get /n: expected 99, got 0',
    '  error: only 3 ticks may run',
  ]);
  const gone = traceBundle('gone', [{ at: 1, call: 'm.gone', equals: 1 }, { at: 3, call: 'm.get', pointer: '/n', equals: 99 }]);
  assert.deepEqual(await linesOf(root, gone), ['FAIL conformance/gone.json (m)', '  error: unknown: m.gone']);
  const unloadable = traceBundle('load', PASSING);
  unloadable.bundle.modules[0].entry = 'm/ts/missing.ts';
  const [head, error, ...rest] = await linesOf(root, unloadable);
  assert.equal(head, 'FAIL conformance/load.json (m)');
  assert.match(error, /^ {2}error: .*missing\.ts/);
  assert.deepEqual(rest, []);
});

test('bundles load in debug mode with an empty ctx.host', async (t) => {
  const root = tempRoot(t);
  assert.deepEqual(await linesOf(root, traceBundle('host', [{ at: 0, call: 'm.host', equals: {} }])), ['PASS conformance/host.json (m)']);
  assert.deepEqual(await linesOf(root, traceBundle('nan', [{ at: 0, call: 'm.nan', equals: 1 }])), [
    'FAIL conformance/nan.json (m)',
    '  error: result not JSON: m.nan',
  ]);
});

test('debug validation checks the schemas of the bundle and joins the errors with "; "', async (t) => {
  const root = tempRoot(t);
  const schema = (n: string, required: string[]) => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required,
    properties: { n: { type: n }, extra: { type: 'string' } },
  });
  writeFiles(root, 'schemas', {
    'ok.schema.json': schema('integer', ['n']),
    'bad.schema.json': schema('string', ['n', 'extra']),
  });
  const withSchema = (name: string): TraceBundle => {
    const tb = traceBundle(name, PASSING);
    tb.bundle.schemas = { state: {}, events: { 'm.tick': `schemas/${name}.schema.json` }, params: {}, results: {} };
    return tb;
  };
  assert.deepEqual(await linesOf(root, withSchema('ok')), ['PASS conformance/ok.json (m)']);
  const [head, error, ...rest] = await linesOf(root, withSchema('bad'));
  assert.equal(head, 'FAIL conformance/bad.json (m)');
  const prefix = '  error: invalid event for m.tick: ';
  assert.ok(error.startsWith(prefix), error);
  // Plan 4.8.2 and 4.10 fix the "<pointer>: " starts and the "; " join; Ajv words the messages.
  assert.deepEqual(error.slice(prefix.length).split('; ').map((part) => part.split(': ')[0]).sort(), ['/', '/n']);
  assert.deepEqual(rest, []);
});

test('a value that is not a trace bundle fails with not a trace bundle', async (t) => {
  const root = tempRoot(t);
  for (const value of [null, 5, [1, 2], { x: 1 }, { trace: 't.json' }, { implementation: 'm' }]) {
    const result = await runTraceBundle('odd.json', value as unknown as TraceBundle, root);
    assert.deepEqual(result, { ok: false, lines: ['FAIL odd.json', '  error: not a trace bundle'] }, JSON.stringify(value));
  }
});

test('main prints PASS lines and the summary and exits 0', async (t) => {
  const root = tempRoot(t);
  writeFiles(root, 'one', { 'ok.json': traceBundle('ok', PASSING) });
  writeFiles(root, 'two', { 'also.json': traceBundle('also', PASSING) });
  const { code, out, err } = await runMain(root, 'one', 'two');
  assert.deepEqual(out, ['PASS conformance/ok.json (m)', 'PASS conformance/also.json (m)', 'node: 2 passed, 0 failed']);
  assert.deepEqual([code, err], [0, []]);
});

test('main exits 1 with the failed lines and the counts when a file fails', async (t) => {
  const root = tempRoot(t);
  const wrongHost = traceBundle('host', PASSING);
  wrongHost.bundle.host = 'python';
  writeFiles(root, 'mixed', {
    'ok.json': traceBundle('ok', PASSING),
    'eq.json': traceBundle('eq', [{ at: 3, call: 'm.get', pointer: '/n', equals: 14 }]),
    'near.json': traceBundle('near', [{ at: 3, call: 'm.get', pointer: '/list/0', near: 2, within: 0.1 }]),
    'count.json': traceBundle('count', [{ by: 3, emitted: 'm.tick', count: 2 }]),
    'host.json': wrongHost,
  });
  const { code, out } = await runMain(root, 'mixed');
  assert.deepEqual(out, [
    'FAIL conformance/count.json (m)',
    '  expect[0]: m.tick : expected 2, got 3',
    'FAIL conformance/eq.json (m)',
    '  expect[0]: m.get /n: expected 14, got 13',
    'FAIL conformance/host.json (m)',
    '  wrong host python',
    'FAIL conformance/near.json (m)',
    '  expect[0]: m.get /list/0: expected 2 within 0.1, got 1.5',
    'PASS conformance/ok.json (m)',
    'node: 1 passed, 4 failed',
  ]);
  assert.equal(code, 1);
});

test('main runs files in sorted posix order within a directory and directories in argument order', async (t) => {
  const root = tempRoot(t);
  const bad = traceBundle('first_a_c', [{ at: 0, call: 'm.get', pointer: '/n', equals: 5 }]);
  writeFiles(root, 'first', { 'b.json': traceBundle('first_b', PASSING), 'notes.txt': 'not a trace bundle' });
  writeFiles(root, 'first/a', { 'c.json': bad });
  writeFiles(root, 'second', { 'a.json': traceBundle('second_a', PASSING) });
  const { code, out } = await runMain(root, 'second', 'first');
  assert.deepEqual(out, [
    'PASS conformance/second_a.json (m)',
    'FAIL conformance/first_a_c.json (m)',
    '  expect[0]: m.get /n: expected 5, got 0',
    'PASS conformance/first_b.json (m)',
    'node: 2 passed, 1 failed',
  ]);
  assert.equal(code, 1);
});

test('main fails a file that is not JSON or not a trace bundle, and counts it', async (t) => {
  const root = tempRoot(t);
  writeFiles(root, 'odd', { 'list.json': [1, 2], 'other.json': { x: 1 }, 'broken.json': '{' });
  const { code, out } = await runMain(root, 'odd');
  assert.equal(out[0], 'FAIL odd/broken.json');
  assert.match(out[1], /^ {2}error: /);
  assert.deepEqual(out.slice(2), [
    'FAIL odd/list.json', '  error: not a trace bundle',
    'FAIL odd/other.json', '  error: not a trace bundle',
    'node: 0 passed, 3 failed',
  ]);
  assert.equal(code, 1);
});

test('main exits 2 without arguments or with a missing directory (before any file runs) and 1 without bundles', async (t) => {
  const root = tempRoot(t);
  const none = await runMain(root);
  assert.equal(none.code, 2);
  assert.deepEqual(none.out, []);
  assert.match(none.err[0], /^usage: /);
  writeFiles(root, 'good', { 'ok.json': traceBundle('ok', PASSING) });
  assert.deepEqual(await runMain(root, 'good', 'missing'), { code: 2, out: [], err: ['conformance: no such directory: missing'] });
  writeFiles(root, 'empty', { 'notes.txt': 'no bundles here' });
  fs.mkdirSync(path.join(root, 'empty', 'deeper'));
  assert.deepEqual(await runMain(root, 'empty'), { code: 1, out: [], err: ['conformance: no trace bundles found'] });
});

test('node hosts/js/conformance.ts runs as a script from another working directory', (t) => {
  const root = tempRoot(t);
  writeFiles(root, 'good', { 'ok.json': traceBundle('ok', PASSING) });
  const script = path.join(import.meta.dirname, '..', 'conformance.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const passed = run('good');
  assert.deepEqual([passed.status, passed.stdout], [0, 'PASS conformance/ok.json (m)\nnode: 1 passed, 0 failed\n']);
  const missing = run('missing');
  assert.deepEqual([missing.status, missing.stdout, missing.stderr], [2, '', 'conformance: no such directory: missing\n']);
});
