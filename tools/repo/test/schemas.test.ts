// Tests for the five foundation schemas in schemas/: each compiles, accepts a valid document and rejects an invalid one.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const validator = createValidator(repoRoot);

const bundle = {
  format: 1,
  game: 'demo',
  host: 'node',
  fixedHz: 60,
  modules: [{ id: 'impl', entry: 'modules/impl/ts/index.ts', sees: ['api', 'impl'], absent: [], packages: [] }],
  contracts: { api: 'impl' },
  operations: { 'api.echo': 'impl' },
  events: { 'api.ping': 'api' },
  types: { 'api.item': 1 },
  config: { api: { greeting: 'hello' }, impl: {} },
  records: { 'api.item': { 'api/one': { n: 1 } } },
  assets: ['modules/api/assets/a.glb'],
  schedule: { fixed: ['impl.run'], frame: [] },
  schemas: { state: { impl: 'modules/impl/schemas/state.schema.json' }, events: {}, params: {}, results: {} },
};

const trace = {
  $schema: '../../../../schemas/trace.schema.json',
  summary: 'A ball falls.',
  fixedHz: 60,
  ticks: 60,
  modules: ['probe_peer'],
  config: { physics: { gravity: [0, -10, 0] } },
  records: { 'physics.body': { ball: { $version: 1, size: [1, 1, 1], mass: 1 } } },
  inputs: [{ at: 0, event: 'physics.spawn', payload: { id: 'ball', body: 'trace/ball', position: [0, 100, 0] } }],
  expect: [
    { at: 60, call: 'physics.position', params: { id: 'ball' }, pointer: '/1', near: 95, within: 0.2 },
    { at: 60, call: 'physics.bodies', pointer: '/0/id', equals: 'ball' },
    { by: 60, emitted: 'physics.contact', count: 0 },
  ],
};

const traceBundle = {
  trace: 'examples/modules/physics/conformance/fall.json',
  contract: 'physics',
  implementation: 'physics_basic',
  ticks: 60,
  bundle,
  inputs: trace.inputs,
  expect: trace.expect,
};

const contractModule = {
  $schema: '../../../schemas/module.schema.json',
  id: 'physics',
  summary: 'Rigid boxes under gravity.',
  contract: true,
  types: { body: 'schemas/body.schema.json' },
  events: { spawn: 'schemas/spawn.schema.json' },
  operations: {
    position: { params: 'schemas/position_params.schema.json', result: 'schemas/position_result.schema.json' },
    bodies: { result: 'schemas/bodies_result.schema.json' },
    reset: {},
  },
  config: { schema: 'schemas/config.schema.json', defaults: { gravity: [0, -9.81, 0] } },
};

const codeModule = {
  id: 'physics_basic',
  summary: 'Implements physics.',
  deprecated: 'Use physics_fast.',
  implements: ['physics'],
  requires: ['clock'],
  optional: ['audio'],
  state: 'schemas/state.schema.json',
  systems: [{ name: 'integrate', loop: 'fixed', after: ['physics', 'clock.tick'], before: ['render'] }, { name: 'draw', loop: 'frame' }],
  hosts: { node: 'ts/index.ts', python: 'python/physics_basic.py' },
  packages: ['node:fs', '@scope/pkg', 'left-pad'],
};

const game = {
  $schema: '../../../schemas/game.schema.json',
  id: 'sandbox',
  summary: 'Three boxes fall and stack.',
  hosts: ['node', 'python', 'web'],
  fixedHz: 60,
  modules: {
    physics_basic: {},
    physics: { config: { gravity: [0, -20, 0] } },
    render_boxes: { hosts: ['web'], config: { scale: 40 } },
  },
};

function pointers(schema: string, value: unknown): string[] {
  const problems = validator.validate(schema, value, 'case.json');
  assert.ok(problems.every((p) => p.rule === 'schema'), JSON.stringify(problems));
  return problems.map((p) => p.pointer).sort();
}

for (const name of ['module', 'game', 'bundle', 'trace', 'trace-bundle']) {
  test(`schemas/${name}.schema.json compiles with no problems`, () => {
    assert.deepEqual(validator.load(`schemas/${name}.schema.json`), []);
  });
}

test('module schema: a contract and a code module with every field are valid', () => {
  assert.deepEqual(pointers('schemas/module.schema.json', contractModule), []);
  assert.deepEqual(pointers('schemas/module.schema.json', codeModule), []);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', manifest: 1, $comment: 'c' }), []);
});

test('module schema: a bad id, an empty summary and an unknown key are rejected', () => {
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'Bad-Id', summary: '', requries: [] }), ['', '/id', '/summary']);
});

test('module schema: escaping paths, bad loops, repeated ids and manifest 2 are rejected', () => {
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', manifest: 2 }), ['/manifest']);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', hosts: { node: '../up.ts' } }), ['/hosts/node']);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', hosts: { node: '/abs.ts' } }), ['/hosts/node']);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', systems: [{ name: 'run', loop: 'sometimes' }] }), ['/systems/0/loop']);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', requires: ['b', 'b'] }), ['/requires']);
  assert.deepEqual(pointers('schemas/module.schema.json', { id: 'a', summary: 'x', packages: ['Bad Package'] }), ['/packages/0']);
});

test('game schema: a game with entry hosts and config is valid', () => {
  assert.deepEqual(pointers('schemas/game.schema.json', game), []);
});

test('game schema: no hosts, a zero rate, a bad module name and an empty entry host list are rejected', () => {
  assert.deepEqual(pointers('schemas/game.schema.json', { id: 'g', summary: 'x', hosts: [], fixedHz: 0, modules: {} }), ['/fixedHz', '/hosts']);
  assert.ok(pointers('schemas/game.schema.json', { ...game, modules: { Bad: {} } }).includes('/modules'));
  assert.deepEqual(pointers('schemas/game.schema.json', { ...game, modules: { a: { hosts: [] } } }), ['/modules/a/hosts']);
  assert.deepEqual(pointers('schemas/game.schema.json', { ...game, modules: { a: { extra: 1 } } }), ['/modules/a']);
});

test('bundle schema: a full bundle is valid', () => {
  assert.deepEqual(pointers('schemas/bundle.schema.json', bundle), []);
});

test('bundle schema: a wrong format and a missing schedule are rejected', () => {
  const broken: Record<string, unknown> = structuredClone(bundle);
  broken.format = 2;
  delete broken.schedule;
  assert.deepEqual(pointers('schemas/bundle.schema.json', broken), ['', '/format']);
  assert.deepEqual(pointers('schemas/bundle.schema.json', { ...bundle, records: { 'api.item': { 'not-an-id': {} } } }).length > 0, true);
  assert.deepEqual(pointers('schemas/bundle.schema.json', { ...bundle, types: { 'api.item': 0 } }), ['/types/api.item']);
});

test('trace schema: a trace with config, records, inputs and both expectation forms is valid', () => {
  assert.deepEqual(pointers('schemas/trace.schema.json', trace), []);
});

test('trace schema: a negative tick count, no expectations, a bad pointer and an unknown key are rejected', () => {
  assert.deepEqual(pointers('schemas/trace.schema.json', { summary: 'x', fixedHz: 60, ticks: -1, expect: [] }), ['/expect', '/ticks']);
  assert.deepEqual(pointers('schemas/trace.schema.json', { ...trace, expect: [{ at: 1, call: 'a.b', pointer: 'no-slash' }] }), ['/expect/0/pointer']);
  assert.deepEqual(pointers('schemas/trace.schema.json', { ...trace, expect: [{ at: 1, call: 'a.b', equals: 1, extra: true }] }), ['/expect/0']);
});

test('trace-bundle schema: a trace compiled for one implementation is valid', () => {
  assert.deepEqual(pointers('schemas/trace-bundle.schema.json', traceBundle), []);
});

test('trace-bundle schema: a bad implementation id and an empty bundle are rejected', () => {
  const problems = pointers('schemas/trace-bundle.schema.json', { ...traceBundle, implementation: 'Bad Name', bundle: {} });
  assert.ok(problems.includes('/implementation'), problems.join(' '));
  assert.ok(problems.includes('/bundle'), problems.join(' '));
});
