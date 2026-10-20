// Tests for tools/repo/lib/traces.ts: the exact trace bundle of ok-traces, the trace checks of 4.7.5, host selection and listTraces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import type { Problem } from '../lib/problems.ts';
import { compileTraces, listTraces, traceBundlePath } from '../lib/traces.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const T = 'modules/api/conformance/t.json';

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

// Contract api (event ping, operation count) with the trace t.json, and the implementation impl on node; `extra` adds or replaces files.
function files(trace: Record<string, Json>, extra: Files = {}, api: Record<string, Json> = {}): Files {
  return {
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true, events: { ping: 'schemas/ping.schema.json' }, operations: { count: { result: 'schemas/count.schema.json' } }, ...api },
    'modules/api/schemas/ping.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer' } } },
    'modules/api/schemas/count.schema.json': { $schema: DRAFT, type: 'integer' },
    [T]: { summary: 'x', fixedHz: 60, ticks: 2, expect: [{ at: 2, call: 'api.count', equals: 0 }], ...trace },
    'modules/impl/module.json': { id: 'impl', summary: 'x', implements: ['api'], hosts: { node: 'ts/index.ts' } },
    'modules/impl/ts/index.ts': 'export {};\n',
    ...extra,
  };
}

function compile(repo: string, root = '.', hosts: readonly string[] | 'all' = 'all') {
  const validator = createValidator(repo);
  const index = discover(repo, root, validator);
  const listed = listTraces(index, validator);
  const compiled = compileTraces(index, loadRecords(index, validator).records, listed.traces, hosts, validator);
  return { listed, bundles: compiled.bundles, problems: [...listed.problems, ...compiled.problems] };
}

function where(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`).sort();
}

const OKT = `${FIXTURES}/ok-traces`;

test('ok-traces compiles for node to the exact trace bundle', () => {
  const { bundles, problems } = compile(repoRoot, OKT, ['node']);
  assert.deepEqual(problems, []);
  assert.deepEqual(bundles.map((b) => b.path), [`build/${OKT}/traces/node/impl/api.basic.json`]);
  assert.deepEqual(bundles[0].value, {
    trace: `${OKT}/modules/api/conformance/basic.json`,
    contract: 'api',
    implementation: 'impl',
    ticks: 3,
    bundle: {
      format: 1,
      game: 'api.basic',
      host: 'node',
      fixedHz: 50,
      modules: [{ id: 'impl', entry: `${OKT}/modules/impl/ts/index.ts`, sees: ['api', 'impl'], absent: [], packages: [] }],
      contracts: { api: 'impl' },
      operations: { 'api.count': 'impl' },
      events: { 'api.ping': 'api' },
      types: { 'api.item': 1 },
      config: { api: {}, impl: {} },
      records: { 'api.item': { 'trace/apple': { name: 'apple', weight: 0.2 } } },
      assets: [],
      schedule: { fixed: [], frame: [] },
      schemas: {
        state: {},
        events: { 'api.ping': `${OKT}/modules/api/schemas/ping.schema.json` },
        params: {},
        results: { 'api.count': `${OKT}/modules/api/schemas/count.schema.json` },
      },
    },
    inputs: [{ at: 0, event: 'api.ping', payload: { n: 1 } }, { at: 1, event: 'api.ping', payload: { n: 2 } }],
    expect: [
      { at: 3, call: 'api.count', equals: 2 },
      { at: 3, call: 'api.count', near: 2, within: 0.5 },
      { by: 3, emitted: 'api.ping', count: 0 },
    ],
  });
  assert.deepEqual(Object.keys(bundles[0].value), ['trace', 'contract', 'implementation', 'ticks', 'bundle', 'inputs', 'expect']);
  assert.deepEqual(createValidator(repoRoot).validate('schemas/trace-bundle.schema.json', bundles[0].value, 'trace bundle'), []);
});

test('listTraces returns the traces of ok-traces, and traceBundlePath names the file', () => {
  const index = discover(repoRoot, OKT, createValidator(repoRoot));
  const listed = listTraces(index, createValidator(repoRoot));
  assert.deepEqual(listed.problems, []);
  assert.deepEqual(listed.traces.map((t) => [t.contract, t.name, t.file]), [['api', 'basic', `${OKT}/modules/api/conformance/basic.json`]]);
  assert.equal(traceBundlePath('.', 'node', 'impl', 'api', 'basic'), 'build/traces/node/impl/api.basic.json');
  assert.equal(traceBundlePath('hosts/conformance', 'python', 'probe_impl', 'probe', 'order'), 'build/hosts/conformance/traces/python/probe_impl/probe.order.json');
});

test('trace-expect and trace-unknown give their rule at the expectation and compile no bundle', () => {
  const expectRoot = compile(repoRoot, `${FIXTURES}/trace-expect`);
  assert.deepEqual(where(expectRoot.problems), [`error trace-expect ${FIXTURES}/trace-expect/modules/api/conformance/bad.json#/expect/0`]);
  assert.deepEqual(expectRoot.bundles, []);
  const unknownRoot = compile(repoRoot, `${FIXTURES}/trace-unknown`);
  assert.deepEqual(where(unknownRoot.problems), [`error trace-unknown ${FIXTURES}/trace-unknown/modules/api/conformance/bad.json#/expect/0/call`]);
  assert.deepEqual(unknownRoot.bundles, []);
});

const CASES: [name: string, fields: Record<string, Json>, rule: string, pointer: string][] = [
  ['an input at the tick count', { inputs: [{ at: 2, event: 'api.ping', payload: { n: 1 } }] }, 'trace-expect', '/inputs/0/at'],
  ['an input for an event nobody declares', { inputs: [{ at: 0, event: 'api.nothing', payload: {} }] }, 'trace-unknown', '/inputs/0/event'],
  ['an input payload that breaks the event schema', { inputs: [{ at: 0, event: 'api.ping', payload: { n: 'x' } }] }, 'schema', '/inputs/0/payload/n'],
  ['a call after the last tick', { expect: [{ at: 3, call: 'api.count', equals: 0 }] }, 'trace-expect', '/expect/0/at'],
  ['a count after the last tick', { expect: [{ by: 3, emitted: 'api.ping', count: 0 }] }, 'trace-expect', '/expect/0/by'],
  ['a call without equals or near', { expect: [{ at: 1, call: 'api.count' }] }, 'trace-expect', '/expect/0'],
  ['a call with near and no within', { expect: [{ at: 1, call: 'api.count', near: 0 }] }, 'trace-expect', '/expect/0'],
  ['a call with equals and near', { expect: [{ at: 1, call: 'api.count', equals: 0, near: 0, within: 1 }] }, 'trace-expect', '/expect/0'],
  ['a call without at', { expect: [{ call: 'api.count', equals: 0 }] }, 'trace-expect', '/expect/0'],
  ['a count without count', { expect: [{ by: 1, emitted: 'api.ping' }] }, 'trace-expect', '/expect/0'],
  ['a count with params', { expect: [{ by: 1, emitted: 'api.ping', count: 0, params: {} }] }, 'trace-expect', '/expect/0'],
  ['an empty expectation', { expect: [{}] }, 'trace-expect', '/expect/0'],
  ['an operation nobody declares', { expect: [{ at: 1, call: 'api.nothing', equals: 0 }] }, 'trace-unknown', '/expect/0/call'],
  ['an event nobody declares in a count', { expect: [{ by: 1, emitted: 'api.nothing', count: 0 }] }, 'trace-unknown', '/expect/0/emitted'],
];

for (const [name, fields, rule, pointer] of CASES) {
  test(`${name} is [${rule}] at ${pointer}`, (t) => {
    const { bundles, problems } = compile(tempRepo(t, files(fields)));
    assert.deepEqual(where(problems), [`error ${rule} ${T}#${pointer}`]);
    assert.deepEqual(bundles, []);
  });
}

test('ticks, inputs and expectations at the edges of their ranges compile', (t) => {
  const { bundles, problems } = compile(tempRepo(t, files({
    inputs: [{ at: 0, event: 'api.ping', payload: { n: 1 } }, { at: 1, event: 'api.ping', payload: { n: 1 } }],
    expect: [
      { at: 0, call: 'api.count', equals: 0 },
      { at: 2, call: 'api.count', pointer: '', params: null, near: 0, within: 0 },
      { by: 0, emitted: 'api.ping', count: 0 },
      { by: 2, emitted: 'api.ping', count: 0 },
    ],
  })));
  assert.deepEqual(problems, []);
  assert.equal(bundles.length, 1);
});

test('a count expectation on an event of a root module outside the composition compiles with no problems (D32), an input for it does not', (t) => {
  const other = {
    'modules/other/module.json': { id: 'other', summary: 'x', events: { thing: 'schemas/thing.schema.json' } },
    'modules/other/schemas/thing.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false },
  };
  const counted = compile(tempRepo(t, files({ expect: [{ by: 2, emitted: 'other.thing', count: 0 }] }, other)));
  assert.deepEqual(counted.problems, []);
  assert.equal(counted.bundles.length, 1);
  const input = compile(tempRepo(t, files({ inputs: [{ at: 0, event: 'other.thing', payload: {} }] }, other)));
  assert.deepEqual(where(input.problems), [`error trace-unknown ${T}#/inputs/0/event`]);
});

test('a trace with a wrong $schema gives schema-path at /$schema', (t) => {
  const { problems } = compile(tempRepo(t, files({ $schema: '../schemas/trace.schema.json' })));
  assert.deepEqual(where(problems), [`error schema-path ${T}#/$schema`]);
  const right = compile(tempRepo(t, files({ $schema: '../../../schemas/trace.schema.json' })));
  assert.deepEqual(right.problems, []);
});

test('a trace listing a module that is not in the root gives unknown-module at /modules/<index>', (t) => {
  const { bundles, problems } = compile(tempRepo(t, files({ modules: ['ghost'] })));
  assert.deepEqual(where(problems), [`error unknown-module ${T}#/modules/0`]);
  assert.deepEqual(bundles, []);
  const second = compile(tempRepo(t, files({ modules: ['other', 'ghost'] }, { 'modules/other/module.json': { id: 'other', summary: 'x' } })));
  assert.deepEqual(where(second.problems), [`error unknown-module ${T}#/modules/1`]);
});

test('a deprecated module of the trace is a warning at its index and the bundle is still written', (t) => {
  const { bundles, problems } = compile(tempRepo(t, files({ modules: ['old'] }, { 'modules/old/module.json': { id: 'old', summary: 'x', deprecated: 'Use new.' } })));
  assert.deepEqual(where(problems), [`warning deprecated ${T}#/modules/0`]);
  assert.equal(bundles.length, 1);
});

test('config of the implementation, which declares none, and config outside the composition are bad-config at /config/<id>', (t) => {
  assert.deepEqual(where(compile(tempRepo(t, files({ config: { impl: { speed: 1 } } }))).problems), [`error bad-config ${T}#/config/impl`]);
  assert.deepEqual(where(compile(tempRepo(t, files({ config: { stranger: {} } }))).problems), [`error bad-config ${T}#/config/stranger`]);
  assert.deepEqual(where(compile(tempRepo(t, files({ config: { api: { x: 1 } } }))).problems), [`error bad-config ${T}#/config/api`]);
});

test('config of a listed module is merged into the bundle, and a value that breaks its schema is bad-config at /config/<id>', (t) => {
  const tuned = {
    'modules/tuned/module.json': { id: 'tuned', summary: 'x', config: { schema: 'schemas/config.schema.json', defaults: { speed: 1 } } },
    'modules/tuned/schemas/config.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, required: ['speed'], properties: { speed: { type: 'integer' } } },
  };
  const good = compile(tempRepo(t, files({ modules: ['tuned'], config: { tuned: { speed: 3 } } }, tuned)));
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.bundles[0].value.bundle.config, { api: {}, impl: {}, tuned: { speed: 3 } });
  const bad = compile(tempRepo(t, files({ modules: ['tuned'], config: { tuned: { speed: 'fast' } } }, tuned)));
  assert.deepEqual(where(bad.problems), [`error bad-config ${T}#/config/tuned`]);
});

test('a problem at a module file keeps its file and pointer', (t) => {
  const { problems } = compile(tempRepo(t, files({ modules: ['web_only'] }, {
    'modules/web_only/module.json': { id: 'web_only', summary: 'x', hosts: { web: 'web/index.ts' } },
    'modules/web_only/web/index.ts': 'export {};\n',
  })));
  assert.deepEqual(where(problems), ['error no-host-entry modules/web_only/module.json#/hosts']);
});

test('trace records are checked as records of the trace and join the bundle as trace/<name>', (t) => {
  const type = (version: number, properties: Record<string, Json> = {}): Json => ({
    $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version'],
    properties: { $schema: { type: 'string' }, $version: { const: version }, $comment: { type: 'string' }, ...properties },
  });
  const extra: Files = {
    'modules/api/schemas/item.schema.json': type(1, { link: { type: 'string', 'x-ref': 'api.item' }, model: { type: 'string', 'x-asset': ['glb'] } }),
    'modules/api/schemas/tall.schema.json': type(2),
    'modules/impl/content/api.item/root_one.json': { $version: 1 },
    'modules/other/module.json': { id: 'other', summary: 'x', requires: ['api'] },
    'modules/other/content/api.item/far.json': { $version: 1 },
  };
  const api = { types: { item: 'schemas/item.schema.json', tall: 'schemas/tall.schema.json' } };
  const run = (records: Json) => compile(tempRepo(t, files({ records }, extra, api)));
  const item = (fields: Record<string, Json>): Json => ({ 'api.item': { a: { $version: 1, ...fields }, b: { $version: 1 } } });

  const linked = run(item({ link: 'trace/b' }));
  assert.deepEqual(linked.problems, []);
  assert.deepEqual(Object.keys(linked.bundles[0].value.bundle.records['api.item']), ['impl/root_one', 'trace/a', 'trace/b']);
  assert.deepEqual(linked.bundles[0].value.bundle.records['api.item']['trace/a'], { link: 'trace/b' });
  assert.deepEqual(run(item({ link: 'impl/root_one' })).problems, []);

  const failures: [Json, string][] = [
    [item({ link: 'trace/ghost' }), 'error dangling-ref /records/api.item/a/link'],
    [item({ link: 'other/far' }), 'error dangling-ref /records/api.item/a/link'],
    [item({ model: 'assets/x.glb' }), 'error asset-missing /records/api.item/a/model'],
    [{ 'api.tall': { a: { $version: 1 } } }, 'error outdated-record /records/api.tall/a/$version'],
    [{ 'api.tall': { a: { $version: 3 } } }, 'error schema /records/api.tall/a/$version'],
    [{ 'api.ghost': { a: { $version: 1 } } }, 'error unknown-type /records/api.ghost/a'],
  ];
  for (const [records, expected] of failures) {
    const [severity, rule, pointer] = expected.split(' ');
    const { bundles, problems } = run(records);
    assert.deepEqual(where(problems), [`${severity} ${rule} ${T}#${pointer}`], expected);
    assert.deepEqual(bundles, [], expected);
  }
});

test('each implementation of the contract and each host it has an entry for gets a bundle; hosts narrows them', (t) => {
  const dir = tempRepo(t, files({}, {
    'modules/impl/module.json': { id: 'impl', summary: 'x', implements: ['api'], hosts: { python: 'python/impl.py', node: 'ts/index.ts' } },
    'modules/impl/python/impl.py': '',
    'modules/zeta/module.json': { id: 'zeta', summary: 'x', implements: ['api'], hosts: { node: 'ts/index.ts' } },
    'modules/zeta/ts/index.ts': 'export {};\n',
  }));
  const names = (hosts: readonly string[] | 'all'): string[] => compile(dir, '.', hosts).bundles.map((b) => `${b.value.implementation} ${b.value.bundle.host} ${b.path}`);
  assert.deepEqual(names('all'), [
    'impl node build/traces/node/impl/api.t.json',
    'impl python build/traces/python/impl/api.t.json',
    'zeta node build/traces/node/zeta/api.t.json',
  ]);
  assert.deepEqual(names(['node']), ['impl node build/traces/node/impl/api.t.json', 'zeta node build/traces/node/zeta/api.t.json']);
  assert.deepEqual(names(['python']), ['impl python build/traces/python/impl/api.t.json']);
  assert.deepEqual(names(['web']), []);
  assert.deepEqual(compile(dir, '.', ['web']).problems, []);
});

test('a contract with traces and no implementation gives no bundle and no problem', (t) => {
  const { 'modules/impl/module.json': _module, 'modules/impl/ts/index.ts': _entry, ...rest } = files({});
  const { bundles, problems } = compile(tempRepo(t, rest));
  assert.deepEqual([bundles, problems], [[], []]);
});

test('listTraces returns valid traces sorted by contract and file, and reports json-parse, schema and contract-shape', (t) => {
  const valid = { summary: 'x', fixedHz: 60, ticks: 1, expect: [{ at: 1, call: 'api.count', equals: 0 }] };
  const dir = tempRepo(t, files({}, {
    'modules/api/conformance/b.json': valid,
    'modules/api/conformance/a.json': valid,
    'modules/api/conformance/broken.json': '{\n  "summary": }\n',
    'modules/api/conformance/invalid.json': { summary: 'x' },
    'modules/api/conformance/notes.txt': 'not a trace',
    'modules/aaa/module.json': { id: 'aaa', summary: 'x', contract: true },
    'modules/aaa/conformance/z.json': valid,
    'modules/plain/module.json': { id: 'plain', summary: 'x' },
    'modules/plain/conformance/x.json': valid,
  }));
  const validator = createValidator(dir);
  const listed = listTraces(discover(dir, '.', validator), validator);
  assert.deepEqual(listed.traces.map((tr) => `${tr.contract}.${tr.name}`), ['aaa.z', 'api.a', 'api.b', 'api.t']);
  assert.deepEqual(where(listed.problems.filter((p) => p.rule !== 'schema')), [
    'error contract-shape modules/plain/conformance#',
    'error json-parse modules/api/conformance/broken.json#',
  ]);
  assert.equal(listed.problems.find((p) => p.rule === 'json-parse')?.line, 2);
  assert.ok(listed.problems.filter((p) => p.rule === 'schema').every((p) => p.file === 'modules/api/conformance/invalid.json'));
  assert.ok(listed.problems.some((p) => p.rule === 'schema'));
});
