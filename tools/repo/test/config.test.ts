// Tests for tools/repo/lib/config.ts: the 15 cases of RFC 7396 Appendix A, config resolution, and the check of config defaults.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { gameComposition, traceComposition } from '../lib/composition.ts';
import { checkConfigDefaults, mergePatch, resolveConfig } from '../lib/config.ts';
import { discover } from '../lib/discover.ts';
import type { RootIndex } from '../lib/discover.ts';
import { writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import type { Problem } from '../lib/problems.ts';
import { resolve } from '../lib/resolve.ts';
import { createValidator } from '../lib/validate.ts';
import type { Validator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

type Files = Record<string, Json | string>;

// RFC 7396 Appendix A: the original document, the patch and the result, as the RFC writes them.
const RFC_7396: [original: string, patch: string, result: string][] = [
  ['{"a":"b"}', '{"a":"c"}', '{"a":"c"}'],
  ['{"a":"b"}', '{"b":"c"}', '{"a":"b","b":"c"}'],
  ['{"a":"b"}', '{"a":null}', '{}'],
  ['{"a":"b","b":"c"}', '{"a":null}', '{"b":"c"}'],
  ['{"a":["b"]}', '{"a":"c"}', '{"a":"c"}'],
  ['{"a":"c"}', '{"a":["b"]}', '{"a":["b"]}'],
  ['{"a":{"b":"c"}}', '{"a":{"b":"d","c":null}}', '{"a":{"b":"d"}}'],
  ['{"a":[{"b":"c"}]}', '{"a":[1]}', '{"a":[1]}'],
  ['["a","b"]', '["c","d"]', '["c","d"]'],
  ['{"a":"b"}', '["c"]', '["c"]'],
  ['{"a":"foo"}', 'null', 'null'],
  ['{"a":"foo"}', '"bar"', '"bar"'],
  ['{"e":null}', '{"a":1}', '{"e":null,"a":1}'],
  ['[1,2]', '{"a":"b","c":null}', '{"a":"b"}'],
  ['{}', '{"a":{"bb":{"ccc":null}}}', '{"a":{"bb":{}}}'],
];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Every object and array reachable from the value.
function objectsIn(value: unknown, found = new Set<object>()): Set<object> {
  if (typeof value === 'object' && value !== null && !found.has(value)) {
    found.add(value);
    Object.values(value).forEach((inner) => objectsIn(inner, found));
  }
  return found;
}

RFC_7396.forEach(([original, patch, result], i) => {
  test(`RFC 7396 appendix A case ${i + 1}: ${original} + ${patch} gives ${result}`, () => {
    const target = deepFreeze(JSON.parse(original) as Json);   // a mutation of a frozen input throws
    const change = deepFreeze(JSON.parse(patch) as Json);
    const merged = mergePatch(target, change);
    assert.equal(JSON.stringify(merged), JSON.stringify(JSON.parse(result)));
    const inputs = objectsIn([target, change]);
    assert.deepEqual([...objectsIn(merged)].filter((o) => inputs.has(o)), []);
    assert.equal(JSON.stringify(target), JSON.stringify(JSON.parse(original)));
    assert.equal(JSON.stringify(change), JSON.stringify(JSON.parse(patch)));
  });
});

test('mergePatch keeps the keys of the target in their order, then adds new keys in patch order', () => {
  assert.equal(JSON.stringify(mergePatch({ b: 1, a: 2 }, { c: 3, a: 4, d: 5 })), '{"b":1,"a":4,"c":3,"d":5}');
});

test('mergePatch with no target, a null target or a null for a missing key', () => {
  assert.deepEqual(mergePatch(undefined, { a: { b: null, c: 1 }, d: null }), { a: { c: 1 } });
  assert.deepEqual(mergePatch(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergePatch({ a: 1 }, { b: null }), { a: 1 });
  assert.equal(mergePatch(undefined, 5), 5);
  assert.equal(mergePatch(undefined, null), null);
});

test('mergePatch keeps a "__proto__" key as plain data and never changes a prototype', () => {
  const merged = mergePatch({}, JSON.parse('{"__proto__":{"polluted":true}}') as Json);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.hasOwn(Object(merged), '__proto__'), true);
  assert.equal(Reflect.get(Object(merged), 'polluted'), undefined);
  assert.equal(Reflect.get({}, 'polluted'), undefined);
  const again = mergePatch(merged, JSON.parse('{"__proto__":{"x":1}}') as Json);
  assert.equal(JSON.stringify(again), '{"__proto__":{"polluted":true,"x":1}}');
});

// A temporary repository with the real schemas/ folder and the given files; the index of its root and a validator for it.
function load(t: TestContext, files: Files): { index: RootIndex; validator: Validator } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRoot, 'schemas'), path.join(dir, 'schemas'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, ...file.split('/'));
    if (typeof content === 'string') writeText(abs, content);
    else writeJson(abs, content);
  }
  const own = createValidator(dir);
  return { index: discover(dir, '.', own), validator: own };
}

const SPEED_SCHEMA: Json = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['speed'],
  properties: { speed: { type: 'integer' }, tags: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'string' } } },
};

// A module or contract with a config of SPEED_SCHEMA and the given defaults.
function configured(id: string, defaults: Json, kind: 'code' | 'contract' = 'code'): Files {
  const manifest: Record<string, Json> = { id, summary: 'x', config: { schema: 'schemas/config.schema.json', defaults } };
  if (kind === 'contract') manifest.contract = true;
  else manifest.hosts = { node: 'ts/index.ts' };
  return {
    [`modules/${id}/module.json`]: manifest,
    [`modules/${id}/schemas/config.schema.json`]: SPEED_SCHEMA,
    ...(kind === 'code' ? { [`modules/${id}/ts/index.ts`]: 'export {};\n' } : {}),
  };
}

function plain(id: string, fields: Record<string, Json> = {}): Files {
  return { [`modules/${id}/module.json`]: { id, summary: 'x', hosts: { node: 'ts/index.ts' }, ...fields }, [`modules/${id}/ts/index.ts`]: 'export {};\n' };
}

function game(modules: Record<string, Json>): Files {
  return { 'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules } };
}

function configOf(index: RootIndex, v: Validator, host = 'node'): { config: Record<string, Json>; problems: Problem[] } {
  const composition = gameComposition(index.games.get('demo')!);
  return resolveConfig(index, resolve(index, composition, host), composition, v);
}

function describeAll(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}: ${p.message}`);
}

// Message text is asserted only where section 4 fixes it; for the rest the test pins rule, severity, file and pointer.
function where(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`);
}

const DEFAULTS: Json = { speed: 1, tags: { a: 'x' } };

test('without an override the config is a copy of the defaults', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', DEFAULTS), ...game({ m: {} }) });
  const result = configOf(index, v);
  assert.deepEqual(result, { config: { m: DEFAULTS }, problems: [] });
  const defaults = index.modules.get('m')!.config!.defaults;
  assert.notEqual(result.config.m, defaults);
  assert.notEqual((result.config.m as { tags: Json }).tags, defaults.tags);
});

test('an override is merged into the defaults by RFC 7396: objects merge and null deletes', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', DEFAULTS), ...game({ m: { config: { speed: 3, tags: { b: 'y', a: null } } } }) });
  assert.deepEqual(configOf(index, v), { config: { m: { speed: 3, tags: { b: 'y' } } }, problems: [] });
  assert.deepEqual(index.modules.get('m')!.config!.defaults, DEFAULTS);
});

test('every selected module and contract gets a config, {} when it declares none, with keys sorted', (t) => {
  const { index, validator: v } = load(t, {
    ...configured('api', { speed: 2 }, 'contract'),
    ...plain('impl', { implements: ['api'] }),
    ...configured('zed', DEFAULTS),
    ...plain('bare'),
    ...game({ zed: {}, impl: {}, bare: {} }),
  });
  const result = configOf(index, v);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(Object.keys(result.config), ['api', 'bare', 'impl', 'zed']);
  assert.deepEqual(result.config, { api: { speed: 2 }, bare: {}, impl: {}, zed: DEFAULTS });
});

test('an override for a module or a contract that declares no config is bad-config at the override', (t) => {
  const { index, validator: v } = load(t, {
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true },
    ...plain('impl', { implements: ['api'] }),
    ...game({ api: { config: { a: 1 } }, impl: { config: { b: 2 } } }),
  });
  const result = configOf(index, v);
  assert.deepEqual(describeAll(result.problems), [
    'error bad-config games/demo/game.json#/modules/api/config: api declares no config',
    'error bad-config games/demo/game.json#/modules/impl/config: impl declares no config',
  ]);
  assert.deepEqual(result.config, { api: {}, impl: {} });
});

test('a merged config that fails its schema is bad-config at the override, one error per failure, naming the property', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', DEFAULTS), ...game({ m: { config: { speed: 'fast', extra: 1 } } }) });
  const result = configOf(index, v);
  assert.deepEqual(where(result.problems), Array(2).fill('error bad-config games/demo/game.json#/modules/m/config'));
  assert.ok(result.problems.some((p) => p.message.startsWith('/speed: ')), describeAll(result.problems).join('\n'));
  assert.ok(result.problems.some((p) => p.message.startsWith('/: ') && p.message.includes('extra')), describeAll(result.problems).join('\n'));
  assert.deepEqual(result.config.m, { speed: 'fast', tags: { a: 'x' }, extra: 1 });
});

test('deleting a required property with null fails the schema', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', DEFAULTS), ...game({ m: { config: { speed: null } } }) });
  const { problems } = configOf(index, v);
  assert.deepEqual(where(problems), ['error bad-config games/demo/game.json#/modules/m/config']);
  assert.match(problems[0].message, /^\/: .*speed/);
});

test('defaults that fail the schema are reported again where the composition builds on them', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', { speed: 'x' }), ...game({ m: {} }) });
  const { problems } = configOf(index, v);
  assert.deepEqual(where(problems), ['error bad-config games/demo/game.json#/modules/m/config']);
  assert.match(problems[0].message, /^\/speed: /);
});

test('a config schema that is missing is discover\'s missing-file; one that cannot be loaded keeps its schema-load problem', (t) => {
  const missing = load(t, { ...configured('m', DEFAULTS), ...game({ m: {} }) });
  fs.rmSync(path.join(missing.index.repoRoot, 'modules', 'm', 'schemas', 'config.schema.json'));
  assert.deepEqual(configOf(missing.index, missing.validator).problems, []);
  const broken = load(t, { ...configured('m', DEFAULTS), 'modules/m/schemas/config.schema.json': '{ nope', ...game({ m: {} }) });
  const problems = configOf(broken.index, broken.validator).problems;
  assert.deepEqual(problems.map((p) => [p.rule, p.file]), [['schema-load', 'modules/m/schemas/config.schema.json']]);
});

test('the bad-config fixture root fails speed at the game entry and nowhere else', () => {
  const index = discover(repoRoot, `${FIXTURES}/bad-config`, validator);
  const composition = gameComposition(index.games.get('demo')!);
  const result = resolveConfig(index, resolve(index, composition, 'node'), composition, validator);
  assert.deepEqual(where(result.problems), [`error bad-config ${FIXTURES}/bad-config/games/demo/game.json#/modules/a/config`]);
  assert.match(result.problems[0].message, /^\/speed: /);
  assert.deepEqual(result.config, { a: { speed: 'fast' } });
  assert.deepEqual(checkConfigDefaults(index, validator), []);
});

test('a trace composition reports a bad override at the trace file with its empty pointer', (t) => {
  const { index, validator: v } = load(t, {
    ...configured('api', { speed: 1 }, 'contract'),
    ...plain('impl', { implements: ['api'] }),
  });
  const trace = { summary: 'x', fixedHz: 60, ticks: 1, config: { api: { speed: 'x' } }, expect: [] };
  const composition = traceComposition(index.modules.get('api')!, index.modules.get('impl')!, trace, 'modules/api/conformance/t.json');
  const result = resolveConfig(index, resolve(index, composition, 'node'), composition, v);
  assert.deepEqual(where(result.problems), ['error bad-config modules/api/conformance/t.json#/api/config']);
  assert.match(result.problems[0].message, /^\/speed: /);
});

test('checkConfigDefaults reports each failing default at the manifest, modules in id order', (t) => {
  const { index, validator: v } = load(t, {
    ...configured('zed', { speed: 'x' }),
    ...configured('api', { tags: { a: 1 } }, 'contract'),
    ...configured('fine', DEFAULTS),
    ...plain('bare'),
  });
  const problems = checkConfigDefaults(index, v);
  assert.deepEqual(where(problems), [
    'error bad-config modules/api/module.json#/config/defaults',
    'error bad-config modules/api/module.json#/config/defaults',
    'error bad-config modules/zed/module.json#/config/defaults',
  ]);
  assert.deepEqual(problems.slice(0, 2).map((p) => p.message.split(':')[0]).sort(), ['/', '/tags/a']);
  assert.match(problems[2].message, /^\/speed: /);
});

test('checkConfigDefaults skips a missing schema and passes valid defaults, on the clean fixture roots too', (t) => {
  const { index, validator: v } = load(t, { ...configured('m', { speed: 'x' }) });
  fs.rmSync(path.join(index.repoRoot, 'modules', 'm', 'schemas', 'config.schema.json'));
  assert.deepEqual(checkConfigDefaults(index, v), []);
  for (const name of ['ok-discover', 'ok-compose']) assert.deepEqual(checkConfigDefaults(discover(repoRoot, `${FIXTURES}/${name}`, validator), validator), [], name);
});
