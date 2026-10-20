// Tests for tools/repo/lib/composition.ts and resolve.ts: the compose fixture roots, the exact ok-compose resolutions, and temporary roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveConfig } from '../lib/config.ts';
import { gameComposition, traceComposition } from '../lib/composition.ts';
import type { TraceDoc } from '../lib/composition.ts';
import { discover } from '../lib/discover.ts';
import type { RootIndex } from '../lib/discover.ts';
import { isObject, readJson, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { formatProblem } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { resolve, topoSort } from '../lib/resolve.ts';
import type { Resolution } from '../lib/resolve.ts';
import { schedule } from '../lib/schedule.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

const ROOTS = [
  'no-provider', 'one-provider', 'cycle-requires', 'cycle-systems', 'no-host-entry', 'unknown-module-game', 'unknown-ref', 'loop-mismatch', 'bad-config', 'ok-compose',
];

type Files = Record<string, Json | string>;

function ruleIds(problems: readonly Problem[], severity: 'error' | 'warning'): string[] {
  return [...new Set(problems.filter((p) => p.severity === severity).map((p) => p.rule))].sort();
}

function expectOf(name: string): { errors: string[]; warnings: string[] } {
  const parsed = readJson(path.join(repoRoot, ...FIXTURES.split('/'), name, 'expect.json'));
  assert.ok(parsed.ok && isObject(parsed.value));
  const { errors, warnings } = parsed.value;
  return { errors: [...(errors as string[])].sort(), warnings: [...((warnings ?? []) as string[])].sort() };
}

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

function load(t: TestContext, files: Files): RootIndex {
  const dir = tempRepo(t, files);
  return discover(dir, '.', createValidator(dir));
}

// A code module: host entries default to node, and each entry gets its file.
function code(id: string, fields: Record<string, Json> = {}): Files {
  const hosts = (fields.hosts ?? { node: 'ts/index.ts' }) as Record<string, string>;
  const files: Files = { [`modules/${id}/module.json`]: { id, summary: 'x', hosts, ...fields } };
  for (const entry of Object.values(hosts)) files[`modules/${id}/${entry}`] = 'export {};\n';
  return files;
}

function contract(id: string, fields: Record<string, Json> = {}): Files {
  return { [`modules/${id}/module.json`]: { id, summary: 'x', contract: true, ...fields } };
}

function game(hosts: string[], modules: Record<string, Json>): Files {
  return { 'games/demo/game.json': { id: 'demo', summary: 'x', hosts, fixedHz: 60, modules } };
}

function resolveDemo(index: RootIndex, host = 'node'): Resolution {
  return resolve(index, gameComposition(index.games.get('demo')!), host);
}

function describeAll(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}: ${p.message}`);
}

// Message text is asserted only where section 4 fixes it; for the rest the test pins rule, severity, file and pointer.
function where(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`);
}

// Everything discover, resolve, schedule and resolveConfig report for every game of a root on every host the game lists.
function compose(index: RootIndex): Problem[] {
  const problems = [...index.problems];
  for (const g of index.games.values()) {
    const composition = gameComposition(g);
    for (const host of g.hosts) {
      const resolution = resolve(index, composition, host);
      problems.push(...resolution.problems, ...schedule(index, resolution).problems, ...resolveConfig(index, resolution, composition, validator).problems);
    }
  }
  return problems;
}

function reversed(index: RootIndex): RootIndex {
  return { ...index, modules: new Map([...index.modules].reverse()) };
}

for (const name of ROOTS) {
  test(`fixture root ${name} reports exactly the rule ids of its expect.json through discover, resolve, schedule and resolveConfig`, () => {
    const problems = compose(discover(repoRoot, `${FIXTURES}/${name}`, validator));
    const expected = expectOf(name);
    const shown = problems.map(formatProblem).join('\n');
    assert.deepEqual(ruleIds(problems, 'error'), expected.errors, shown);
    assert.deepEqual(ruleIds(problems, 'warning'), expected.warnings, shown);
  });
}

const LOCATIONS: [root: string, rule: string, file: string, pointer: string, message: string | undefined][] = [
  ['no-provider', 'no-provider', 'games/demo/game.json', '/modules', 'contract api has no implementation selected; add one of: impl'],
  ['one-provider', 'one-provider', 'games/demo/game.json', '/modules', 'contract api has 2 implementations selected: impl_a, impl_b; keep one'],
  ['cycle-requires', 'cycle', 'games/demo/game.json', '/modules', 'requires cycle: a -> b -> a'],
  ['no-host-entry', 'no-host-entry', 'modules/web_only/module.json', '/hosts', 'web_only has no entry for host node'],
  ['unknown-module-game', 'unknown-module', 'games/demo/game.json', '/modules/ghost', undefined],
];

for (const [root, rule, file, pointer, message] of LOCATIONS) {
  test(`fixture root ${root}: [${rule}] at ${file}#${pointer}${message === undefined ? '' : ` says "${message}"`}`, () => {
    const base = `${FIXTURES}/${root}`;
    const found = resolveDemo(discover(repoRoot, base, validator)).problems;
    assert.deepEqual(where(found), [`error ${rule} ${base}/${file}#${pointer}`]);
    if (message === undefined) assert.match(found[0].message, /ghost/);
    else assert.equal(found[0].message, message);
  });
}

const OK_COMPOSE: [game: string, host: string, expected: Omit<Resolution, 'problems'>][] = [
  ['with_extra', 'node', {
    selected: ['api', 'extra', 'feature', 'impl', 'view'],
    order: ['extra', 'impl', 'feature', 'view'],
    contracts: { api: 'impl' },
    sees: { extra: ['extra'], impl: ['api', 'impl'], feature: ['api', 'extra', 'feature'], view: ['api', 'view'] },
    absent: { extra: [], impl: [], feature: [], view: [] },
  }],
  ['without_extra', 'node', {
    selected: ['api', 'feature', 'impl', 'view'],
    order: ['impl', 'feature', 'view'],
    contracts: { api: 'impl' },
    sees: { impl: ['api', 'impl'], feature: ['api', 'feature'], view: ['api', 'view'] },
    absent: { impl: [], feature: ['extra'], view: [] },
  }],
  ['limited', 'node', {
    selected: ['api', 'feature', 'impl'],
    order: ['impl', 'feature'],
    contracts: { api: 'impl' },
    sees: { impl: ['api', 'impl'], feature: ['api', 'feature'] },
    absent: { impl: [], feature: ['extra'] },
  }],
  ['limited', 'web', {
    selected: ['api', 'feature', 'impl', 'view'],
    order: ['impl', 'feature', 'view'],
    contracts: { api: 'impl' },
    sees: { impl: ['api', 'impl'], feature: ['api', 'feature'], view: ['api', 'view'] },
    absent: { impl: [], feature: ['extra'], view: [] },
  }],
];

for (const [name, host, expected] of OK_COMPOSE) {
  test(`ok-compose game ${name} on host ${host} resolves to the exact selection, order, contracts, sees and absent`, () => {
    const index = discover(repoRoot, `${FIXTURES}/ok-compose`, validator);
    const { problems, ...resolution } = resolve(index, gameComposition(index.games.get(name)!), host);
    assert.deepEqual(problems, []);
    assert.deepEqual(resolution, expected);
  });
}

test('every compose fixture root gives the same resolution, schedule, config and problems from an index built in reverse order', () => {
  for (const name of ROOTS) {
    const index = discover(repoRoot, `${FIXTURES}/${name}`, validator);
    const back = reversed(index);
    assert.deepEqual([...back.modules.keys()], [...index.modules.keys()].reverse());
    for (const g of index.games.values()) {
      const composition = gameComposition(g);
      for (const host of g.hosts) {
        const resolution = resolve(index, composition, host);
        const again = resolve(back, composition, host);
        assert.deepEqual(again, resolution, `${name} ${g.id} ${host}`);
        assert.deepEqual(schedule(back, again), schedule(index, resolution), `${name} ${g.id} ${host}`);
        assert.deepEqual(resolveConfig(back, again, composition, validator), resolveConfig(index, resolution, composition, validator), `${name} ${g.id} ${host}`);
      }
    }
  }
});

test('a composition key that is not a module is unknown-module whatever its hosts, and a deprecated key is a warning, both at the key', (t) => {
  const index = load(t, {
    ...code('a'),
    ...code('old', { deprecated: 'Use a.' }),
    ...game(['node', 'web'], { a: {}, old: {}, ghost: {}, away: { hosts: ['web'] } }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(where(resolution.problems), [
    'warning deprecated games/demo/game.json#/modules/old',
    'error unknown-module games/demo/game.json#/modules/ghost',
    'error unknown-module games/demo/game.json#/modules/away',
  ]);
  assert.equal(resolution.problems[0].message, 'old is deprecated: Use a.');
  assert.deepEqual(resolution.selected, ['a', 'old']);
});

test('selection follows requires and implements, never optional', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl', { implements: ['api'] }),
    ...code('user', { requires: ['api'] }),
    ...code('lib'),
    ...code('top', { requires: ['user'], optional: ['lib'] }),
    ...game(['node'], { top: {}, impl: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(resolution.problems, []);
  assert.deepEqual(resolution.selected, ['api', 'impl', 'top', 'user']);
  assert.deepEqual(resolution.order, ['impl', 'user', 'top']);
  assert.deepEqual(resolution.absent.top, ['lib']);
  assert.deepEqual(resolution.sees.top, ['top', 'user']);
});

test('an entry for another host selects nothing, and what it requires stays out', (t) => {
  const index = load(t, {
    ...code('core', { hosts: { node: 'ts/index.ts', web: 'ts/index.ts' } }),
    ...code('helper', { hosts: { node: 'ts/index.ts', web: 'ts/index.ts' } }),
    ...code('webui', { requires: ['helper'], hosts: { web: 'web/index.ts' } }),
    ...game(['node', 'web'], { core: {}, webui: { hosts: ['web'] } }),
  });
  assert.deepEqual(resolveDemo(index, 'node').selected, ['core']);
  assert.deepEqual(resolveDemo(index, 'node').problems, []);
  const web = resolveDemo(index, 'web');
  assert.deepEqual(web.selected, ['core', 'helper', 'webui']);
  assert.deepEqual(web.order, ['core', 'helper', 'webui']);
  assert.deepEqual(web.problems, []);
});

test('no-provider lists the root modules that implement the contract and have an entry for the host', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl_b', { implements: ['api'] }),
    ...code('impl_a', { implements: ['api'] }),
    ...code('impl_w', { implements: ['api'], hosts: { web: 'web/index.ts' } }),
    ...code('user', { requires: ['api'] }),
    ...game(['node'], { user: {} }),
  });
  assert.deepEqual(describeAll(resolveDemo(index).problems), [
    'error no-provider games/demo/game.json#/modules: contract api has no implementation selected; add one of: impl_a, impl_b',
  ]);
});

test('no-provider says so when no module implements the contract for the host', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl_w', { implements: ['api'], hosts: { web: 'web/index.ts' } }),
    ...code('user', { requires: ['api'] }),
    ...game(['node'], { user: {} }),
  });
  assert.deepEqual(describeAll(resolveDemo(index).problems), [
    'error no-provider games/demo/game.json#/modules: contract api has no implementation selected; no module implements it for host node',
  ]);
});

test('one-provider counts and sorts the implementations, picks none, and keeps them all selected', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl_c', { implements: ['api'] }),
    ...code('impl_a', { implements: ['api'] }),
    ...code('impl_b', { implements: ['api'] }),
    ...game(['node'], { impl_c: {}, impl_a: {}, impl_b: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(describeAll(resolution.problems), [
    'error one-provider games/demo/game.json#/modules: contract api has 3 implementations selected: impl_a, impl_b, impl_c; keep one',
  ]);
  assert.deepEqual(resolution.contracts, {});
  assert.deepEqual(resolution.order, ['impl_a', 'impl_b', 'impl_c']);
});

test('provider candidates are the entries built for the host only, so one implementation per host is no conflict', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl_n', { implements: ['api'] }),
    ...code('impl_w', { implements: ['api'], hosts: { web: 'web/index.ts' } }),
    ...code('user', { requires: ['api'], hosts: { node: 'ts/index.ts', web: 'ts/index.ts' } }),
    ...game(['node', 'web'], { user: {}, impl_n: { hosts: ['node'] }, impl_w: { hosts: ['web'] } }),
  });
  const node = resolveDemo(index, 'node');
  assert.deepEqual(node.problems, []);
  assert.deepEqual(node.selected, ['api', 'impl_n', 'user']);
  assert.deepEqual(node.contracts, { api: 'impl_n' });
  const web = resolveDemo(index, 'web');
  assert.deepEqual(web.problems, []);
  assert.deepEqual(web.selected, ['api', 'impl_w', 'user']);
  assert.deepEqual(web.contracts, { api: 'impl_w' });
});

test('a contract listed in the composition only sets its config and is selected once an implementation is', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl', { implements: ['api'] }),
    ...game(['node'], { api: { config: { level: 1 } }, impl: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(resolution.problems, []);
  assert.deepEqual(resolution.selected, ['api', 'impl']);
  assert.deepEqual(resolution.contracts, { api: 'impl' });
});

test('no-host-entry also names a code module selected through requires, and spares contracts and content packs', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl', { implements: ['api'] }),
    ...code('helper', { hosts: { web: 'web/index.ts' } }),
    ...code('user', { requires: ['api', 'helper', 'pack'] }),
    'modules/pack/module.json': { id: 'pack', summary: 'x' },
    ...game(['node'], { user: {}, impl: {} }),
  });
  assert.deepEqual(describeAll(resolveDemo(index).problems), ['error no-host-entry modules/helper/module.json#/hosts: helper has no entry for host node']);
  assert.deepEqual(resolveDemo(index).order, ['helper', 'impl', 'pack', 'user']);
});

test('load order takes the smallest ready id first', (t) => {
  const index = load(t, { ...code('m'), ...code('a'), ...code('z'), ...game(['node'], { z: {}, m: {}, a: {} }) });
  assert.deepEqual(resolveDemo(index).order, ['a', 'm', 'z']);
});

test('a module loads after what it requires, even when its id sorts first', (t) => {
  const index = load(t, { ...code('z'), ...code('a', { requires: ['z'] }), ...code('m'), ...game(['node'], { a: {}, m: {} }) });
  assert.deepEqual(resolveDemo(index).order, ['m', 'z', 'a']);
});

test('a contract stands for its implementation in the load order, and its own requires apply to that implementation', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...contract('wire', { requires: ['zbase'] }),
    ...code('zbase'),
    ...code('zimpl', { implements: ['api'] }),
    ...code('aimpl', { implements: ['wire'] }),
    ...code('user', { requires: ['api'] }),
    ...game(['node'], { user: {}, zimpl: {}, aimpl: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(resolution.problems, []);
  assert.deepEqual(resolution.contracts, { api: 'zimpl', wire: 'aimpl' });
  assert.deepEqual(resolution.order, ['zbase', 'aimpl', 'zimpl', 'user']);
});

test('an optional module that is selected loads first; one that is not selected adds no edge', (t) => {
  const files = { ...code('a_feature', { optional: ['z_extra', 'ghost'] }), ...code('z_extra') };
  const withExtra = resolveDemo(load(t, { ...files, ...game(['node'], { a_feature: {}, z_extra: {} }) }));
  assert.deepEqual(withExtra.order, ['z_extra', 'a_feature']);
  assert.deepEqual(withExtra.absent, { z_extra: [], a_feature: ['ghost'] });
  assert.deepEqual(withExtra.sees.a_feature, ['a_feature', 'z_extra']);
  const without = resolveDemo(load(t, { ...files, ...game(['node'], { a_feature: {} }) }));
  assert.deepEqual(without.order, ['a_feature']);
  assert.deepEqual(without.absent, { a_feature: ['ghost', 'z_extra'] });
  assert.deepEqual(without.sees.a_feature, ['a_feature']);
});

test('a requires cycle is one error that walks from the smallest module held back along requires', (t) => {
  const index = load(t, {
    ...code('a', { requires: ['b'] }),
    ...code('b', { requires: ['c'] }),
    ...code('c', { requires: ['a'] }),
    ...game(['node'], { c: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(describeAll(resolution.problems), ['error cycle games/demo/game.json#/modules: requires cycle: a -> b -> c -> a']);
  assert.deepEqual(resolution.order, ['a', 'b', 'c']);
});

test('a module that only waits on a cycle is not part of the printed path', (t) => {
  const index = load(t, {
    ...code('a', { requires: ['x'] }),
    ...code('x', { requires: ['y'] }),
    ...code('y', { requires: ['x'] }),
    ...game(['node'], { a: {} }),
  });
  const resolution = resolveDemo(index);
  assert.deepEqual(describeAll(resolution.problems), ['error cycle games/demo/game.json#/modules: requires cycle: x -> y -> x']);
  assert.deepEqual(resolution.order, ['a', 'x', 'y']);
});

test('a cycle through a contract is a requires cycle between its users and its implementation', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl', { implements: ['api'], requires: ['a'] }),
    ...code('a', { requires: ['api'] }),
    ...game(['node'], { a: {}, impl: {} }),
  });
  assert.deepEqual(describeAll(resolveDemo(index).problems), ['error cycle games/demo/game.json#/modules: requires cycle: a -> impl -> a']);
});

test('a module that requires itself adds no edge', (t) => {
  const index = load(t, { ...code('a', { requires: ['a'] }), ...game(['node'], { a: {} }) });
  const resolution = resolveDemo(index);
  assert.deepEqual(resolution.problems, []);
  assert.deepEqual(resolution.order, ['a']);
});

test('the problems and every field are the same for an index built in reverse order, with errors in the composition', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl_c', { implements: ['api'] }),
    ...code('impl_a', { implements: ['api'] }),
    ...code('helper', { hosts: { web: 'web/index.ts' } }),
    ...code('b', { requires: ['c', 'helper'] }),
    ...code('c', { requires: ['b'] }),
    ...game(['node'], { b: {}, impl_c: {}, impl_a: {}, ghost: {} }),
  });
  const resolution = resolveDemo(index);
  assert.equal(resolution.problems.length, 4, describeAll(resolution.problems).join('\n'));
  assert.deepEqual(resolveDemo(reversed(index)), resolution);
});

test('traceComposition keys are the contract, the implementation, then the trace modules; config comes from the trace', (t) => {
  const index = load(t, {
    ...contract('api'),
    ...code('impl', { implements: ['api'] }),
    ...code('peer'),
    ...code('other'),
  });
  const trace: TraceDoc = { summary: 'x', fixedHz: 60, ticks: 1, modules: ['peer', 'other'], config: { peer: { level: 2 } }, expect: [] };
  const composition = traceComposition(index.modules.get('api')!, index.modules.get('impl')!, trace, 'modules/api/conformance/t.json');
  assert.deepEqual(composition, { file: 'modules/api/conformance/t.json', pointer: '', modules: { api: {}, impl: {}, peer: { config: { level: 2 } }, other: {} } });
  assert.deepEqual(Object.keys(composition.modules), ['api', 'impl', 'peer', 'other']);
  const resolution = resolve(index, composition, 'node');
  assert.deepEqual(resolution.problems, []);
  assert.deepEqual(resolution.selected, ['api', 'impl', 'other', 'peer']);
  assert.deepEqual(resolution.contracts, { api: 'impl' });
  const bare = traceComposition(index.modules.get('api')!, index.modules.get('impl')!, { summary: 'x', fixedHz: 60, ticks: 1, expect: [] }, 'f.json');
  assert.deepEqual(bare.modules, { api: {}, impl: {} });
});

test('a trace composition reports its problems at the trace file', (t) => {
  const index = load(t, { ...contract('api'), ...code('impl', { implements: ['api'] }), ...code('peer', { hosts: { web: 'web/index.ts' } }) });
  const trace: TraceDoc = { summary: 'x', fixedHz: 60, ticks: 1, modules: ['ghost', 'peer'], expect: [] };
  const file = 'modules/api/conformance/t.json';
  const resolution = resolve(index, traceComposition(index.modules.get('api')!, index.modules.get('impl')!, trace, file), 'node');
  assert.deepEqual(where(resolution.problems), [`error unknown-module ${file}#/ghost`, 'error no-host-entry modules/peer/module.json#/hosts']);
  assert.equal(resolution.problems[1].message, 'peer has no entry for host node');
});

test('traceComposition does not share config with the trace, and gameComposition does not share entries with the game', (t) => {
  const index = load(t, { ...contract('api'), ...code('impl', { implements: ['api'] }), ...code('peer'), ...game(['node', 'web'], { impl: { config: { a: [1] }, hosts: ['node'] } }) });
  const trace: TraceDoc = { summary: 'x', fixedHz: 60, ticks: 1, modules: ['peer'], config: { peer: { a: [1] } }, expect: [] };
  const fromTrace = traceComposition(index.modules.get('api')!, index.modules.get('impl')!, trace, 'f.json');
  (fromTrace.modules.peer.config!.a as Json[]).push(2);
  assert.deepEqual(trace.config, { peer: { a: [1] } });
  const info = index.games.get('demo')!;
  const fromGame = gameComposition(info);
  assert.deepEqual(fromGame, { file: 'games/demo/game.json', pointer: '/modules', modules: { impl: { config: { a: [1] }, hosts: ['node'] } } });
  (fromGame.modules.impl.config!.a as Json[]).push(2);
  fromGame.modules.impl.hosts!.push('web');
  assert.deepEqual(info.modules, { impl: { config: { a: [1] }, hosts: ['node'] } });
});

test('topoSort takes the smallest ready node first and reports the loop of a cycle', () => {
  assert.deepEqual(topoSort(4, [[3, 0], [2, 1]]), { placed: [2, 1, 3, 0], left: [], cycle: [] });
  assert.deepEqual(topoSort(3, []), { placed: [0, 1, 2], left: [], cycle: [] });
  assert.deepEqual(topoSort(4, [[1, 2], [2, 1], [0, 3]]), { placed: [0, 3], left: [1, 2], cycle: [1, 2, 1] });
  assert.deepEqual(topoSort(2, [[1, 1]]), { placed: [0], left: [1], cycle: [1, 1] });
  assert.deepEqual(topoSort(3, [[0, 1], [1, 2], [2, 0]]), { placed: [], left: [0, 1, 2], cycle: [0, 2, 1, 0] });
});
