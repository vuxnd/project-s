// Tests for tools/repo/lib/schedule.ts: the ok-compose schedules, the scheduling fixture roots, and temporary roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { gameComposition } from '../lib/composition.ts';
import { discover } from '../lib/discover.ts';
import type { RootIndex } from '../lib/discover.ts';
import { writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import type { Problem } from '../lib/problems.ts';
import { resolve } from '../lib/resolve.ts';
import { schedule } from '../lib/schedule.ts';
import type { Schedule } from '../lib/schedule.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

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

function load(t: TestContext, files: Files): RootIndex {
  const dir = tempRepo(t, files);
  return discover(dir, '.', createValidator(dir));
}

// A code module for node with the given systems and manifest fields.
function code(id: string, systems: Json[] = [], fields: Record<string, Json> = {}): Files {
  return {
    [`modules/${id}/module.json`]: { id, summary: 'x', hosts: { node: 'ts/index.ts' }, ...(systems.length > 0 ? { systems } : {}), ...fields },
    [`modules/${id}/ts/index.ts`]: 'export {};\n',
  };
}

function contract(id: string): Files {
  return { [`modules/${id}/module.json`]: { id, summary: 'x', contract: true } };
}

function system(name: string, loop: 'fixed' | 'frame', fields: Record<string, Json> = {}): Json {
  return { name, loop, ...fields };
}

function game(modules: Record<string, Json>): Files {
  return { 'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node'], fixedHz: 60, modules } };
}

function scheduleOf(index: RootIndex, gameId = 'demo', host = 'node'): Schedule {
  return schedule(index, resolve(index, gameComposition(index.games.get(gameId)!), host));
}

function describeAll(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}: ${p.message}`);
}

// Message text is asserted only where section 4 fixes it; for the rest the test pins rule, severity, file and pointer.
function where(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`);
}

const OK_COMPOSE: [game: string, host: string, fixed: string[], frame: string[]][] = [
  ['with_extra', 'node', ['extra.tick_extra', 'impl.step', 'feature.act'], ['view.draw']],
  ['without_extra', 'node', ['impl.step', 'feature.act'], ['view.draw']],
  ['limited', 'node', ['impl.step', 'feature.act'], []],
  ['limited', 'web', ['impl.step', 'feature.act'], ['view.draw']],
];

for (const [name, host, fixed, frame] of OK_COMPOSE) {
  test(`ok-compose game ${name} on host ${host} schedules fixed ${fixed.join(', ') || 'nothing'} and frame ${frame.join(', ') || 'nothing'}`, () => {
    const index = discover(repoRoot, `${FIXTURES}/ok-compose`, validator);
    assert.deepEqual(scheduleOf(index, name, host), { fixed, frame, problems: [] });
    const back: RootIndex = { ...index, modules: new Map([...index.modules].reverse()) };
    assert.deepEqual(scheduleOf(back, name, host), { fixed, frame, problems: [] });
  });
}

const LOCATIONS: [root: string, rule: string, file: string, pointer: string, message: string | RegExp][] = [
  ['cycle-systems', 'cycle', 'modules/a/module.json', '/systems/0', 'system cycle: a.x -> b.y -> a.x'],
  ['unknown-ref', 'unknown-ref', 'modules/a/module.json', '/systems/0/after/0', /ghost\.y/],
  ['loop-mismatch', 'loop-mismatch', 'modules/a/module.json', '/systems/1/after/0', /a\.step.*a\.draw/],
];

for (const [root, rule, file, pointer, message] of LOCATIONS) {
  test(`fixture root ${root}: [${rule}] at ${file}#${pointer}`, () => {
    const base = `${FIXTURES}/${root}`;
    const found = scheduleOf(discover(repoRoot, base, validator)).problems;
    assert.deepEqual(where(found), [`error ${rule} ${base}/${file}#${pointer}`]);
    if (typeof message === 'string') assert.equal(found[0].message, message);
    else assert.match(found[0].message, message);
  });
}

test('systems of one module run in manifest order within a loop, and the loops do not mix', (t) => {
  const index = load(t, {
    ...code('a', [system('s1', 'fixed'), system('s2', 'frame'), system('s3', 'fixed'), system('s4', 'frame')]),
    ...code('b', [system('zeta', 'fixed'), system('alpha', 'fixed')]),
    ...game({ a: {}, b: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['a.s1', 'a.s3', 'b.zeta', 'b.alpha'], frame: ['a.s2', 'a.s4'], problems: [] });
});

test('an after or before entry that names a module orders against every system of that module in the loop', (t) => {
  const index = load(t, {
    ...code('a', [system('a1', 'fixed'), system('a2', 'fixed')]),
    ...code('b', [system('first', 'fixed', { before: ['a'] }), system('late', 'fixed', { after: ['a'] })]),
    ...game({ a: {}, b: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['b.first', 'a.a1', 'a.a2', 'b.late'], frame: [], problems: [] });
});

test('a module entry orders against the systems of its own loop only', (t) => {
  const index = load(t, {
    ...code('late', [system('e', 'frame', { after: ['early'] })]),
    ...code('early', [system('s', 'fixed'), system('d', 'frame')], { requires: ['late'] }),
    ...game({ early: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['early.s'], frame: ['early.d', 'late.e'], problems: [] });
});

test('an entry that names one system orders against that system', (t) => {
  const index = load(t, {
    ...code('a', [system('x', 'fixed'), system('y', 'fixed')]),
    ...code('b', [system('w', 'fixed', { before: ['a.x'] }), system('z', 'fixed', { after: ['a.y'] })]),
    ...game({ a: {}, b: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['b.w', 'a.x', 'a.y', 'b.z'], frame: [], problems: [] });
});

test('the schedule follows the load order of the modules and then the manifest order, not ids', (t) => {
  const index = load(t, {
    ...code('z', [system('z1', 'fixed')]),
    ...code('a', [system('a1', 'fixed'), system('a2', 'fixed')], { requires: ['z'] }),
    ...game({ a: {} }),
  });
  assert.deepEqual(scheduleOf(index).fixed, ['z.z1', 'a.a1', 'a.a2']);
});

test('a module named like a method of Object is ordered against like any other', (t) => {
  const index = load(t, {
    ...code('constructor', [system('c', 'fixed')]),
    ...code('aaa', [system('w', 'fixed', { after: ['constructor'] })]),
    ...game({ aaa: {}, constructor: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['constructor.c', 'aaa.w'], frame: [], problems: [] });
});

test('a contract entry orders against the systems of its implementation, before as well as after', (t) => {
  const base = { ...contract('api'), ...code('impl', [system('step', 'fixed')], { implements: ['api'] }), ...game({ impl: {}, feature: {} }) };
  const before = load(t, { ...base, ...code('feature', [system('act', 'fixed', { before: ['api'] })], { requires: ['api'] }) });
  assert.deepEqual(scheduleOf(before), { fixed: ['feature.act', 'impl.step'], frame: [], problems: [] });
  const after = load(t, { ...base, ...code('feature', [system('act', 'fixed', { after: ['api'] })], { requires: ['api'] }) });
  assert.deepEqual(scheduleOf(after), { fixed: ['impl.step', 'feature.act'], frame: [], problems: [] });
});

test('a contract entry without a selected implementation orders against nothing', (t) => {
  const index = load(t, { ...contract('api'), ...code('feature', [system('act', 'fixed', { after: ['api'] })], { requires: ['api'] }), ...game({ feature: {} }) });
  assert.deepEqual(scheduleOf(index), { fixed: ['feature.act'], frame: [], problems: [] });
});

test('entries that name existing modules, contracts and systems outside the selection are ignored; others are unknown-ref', (t) => {
  const index = load(t, {
    ...code('a', [system('x', 'fixed', { after: ['b', 'b.y', 'c', 'cimpl.z', 'pack'] }), system('y', 'fixed', { after: ['b.nope', 'c.z'] })]),
    ...code('b', [system('y', 'fixed')]),
    ...contract('c'),
    ...code('cimpl', [system('z', 'frame')], { implements: ['c'] }),
    'modules/pack/module.json': { id: 'pack', summary: 'x' },
    ...game({ a: {}, pack: {} }),
  });
  const result = scheduleOf(index);
  assert.deepEqual(where(result.problems), ['error unknown-ref modules/a/module.json#/systems/1/after/0', 'error unknown-ref modules/a/module.json#/systems/1/after/1']);
  assert.deepEqual(result.fixed, ['a.x', 'a.y']);
});

test('an entry for an optional module that is not in the root is ignored, with or without a system name; any other id is unknown-ref', (t) => {
  const stats = (optional: string[]): Files => code('stats', [system('count', 'fixed', { after: ['audio', 'audio.play', 'audio.nope', 'ghost'] })], { optional });
  const kept = scheduleOf(load(t, { ...stats(['audio']), ...game({ stats: {} }) }));
  assert.deepEqual(where(kept.problems), ['error unknown-ref modules/stats/module.json#/systems/0/after/3']);
  assert.match(kept.problems[0].message, /ghost/);
  assert.deepEqual(kept.fixed, ['stats.count']);
  const plain = scheduleOf(load(t, { ...stats([]), ...game({ stats: {} }) }));
  assert.deepEqual(plain.problems.map((p) => p.pointer), ['/systems/0/after/0', '/systems/0/after/1', '/systems/0/after/2', '/systems/0/after/3']);
});

test('an optional module that is in the root is ordered against when selected, and ignored when not', (t) => {
  const files = {
    ...code('stats', [system('count', 'fixed', { after: ['audio.play'] })], { optional: ['audio'] }),
    ...code('audio', [system('play', 'fixed')]),
  };
  const withAudio = scheduleOf(load(t, { ...files, ...game({ stats: {}, audio: {} }) }));
  assert.deepEqual(withAudio, { fixed: ['audio.play', 'stats.count'], frame: [], problems: [] });
  const without = scheduleOf(load(t, { ...files, ...game({ stats: {} }) }));
  assert.deepEqual(without, { fixed: ['stats.count'], frame: [], problems: [] });
});

test('a before entry that names a system of the other loop is loop-mismatch at its own pointer, once', (t) => {
  const index = load(t, { ...code('a', [system('draw', 'frame'), system('step', 'fixed', { before: ['a.draw'] })]), ...game({ a: {} }) });
  const result = scheduleOf(index);
  assert.deepEqual(where(result.problems), ['error loop-mismatch modules/a/module.json#/systems/1/before/0']);
  assert.match(result.problems[0].message, /a\.draw.*a\.step/);
  assert.deepEqual([result.fixed, result.frame], [['a.step'], ['a.draw']]);
});

test('a loop-mismatch entry in a module that is not selected is not reported, and one for an unselected system is ignored', (t) => {
  const index = load(t, {
    ...code('a', [system('x', 'fixed')]),
    ...code('away', [system('draw', 'frame', { after: ['a.x'] })]),
    ...code('b', [system('y', 'fixed', { after: ['away.draw'] })]),
    ...game({ a: {}, b: {} }),
  });
  assert.deepEqual(scheduleOf(index), { fixed: ['a.x', 'b.y'], frame: [], problems: [] });
});

test('a system that waits for a system declared after it in its own module is a cycle', (t) => {
  const index = load(t, { ...code('a', [system('x', 'fixed', { after: ['a.y'] }), system('y', 'fixed')]), ...game({ a: {} }) });
  assert.deepEqual(describeAll(scheduleOf(index).problems), ['error cycle modules/a/module.json#/systems/0: system cycle: a.x -> a.y -> a.x']);
});

test('a cycle in one loop is one error and leaves the other loop alone', (t) => {
  const index = load(t, {
    ...code('a', [system('s', 'fixed'), system('p', 'frame', { after: ['a.q'] }), system('q', 'frame')]),
    ...game({ a: {} }),
  });
  const result = scheduleOf(index);
  assert.deepEqual(describeAll(result.problems), ['error cycle modules/a/module.json#/systems/1: system cycle: a.p -> a.q -> a.p']);
  assert.deepEqual(result.fixed, ['a.s']);
});

test('a cycle error sits at the smallest system held back and prints the loop it walks into', (t) => {
  const index = load(t, {
    ...code('a', [system('w', 'fixed', { after: ['b.x'] })]),
    ...code('b', [system('x', 'fixed', { after: ['c.y'] })]),
    ...code('c', [system('y', 'fixed', { after: ['b.x'] })]),
    ...game({ a: {}, b: {}, c: {} }),
  });
  const result = scheduleOf(index);
  assert.deepEqual(describeAll(result.problems), ['error cycle modules/a/module.json#/systems/0: system cycle: b.x -> c.y -> b.x']);
  assert.deepEqual(result.fixed, ['a.w', 'b.x', 'c.y']);
});

test('a system that orders itself after its own module is a cycle', (t) => {
  const index = load(t, { ...code('a', [system('x', 'fixed', { after: ['a'] })]), ...game({ a: {} }) });
  assert.deepEqual(describeAll(scheduleOf(index).problems), ['error cycle modules/a/module.json#/systems/0: system cycle: a.x -> a.x']);
});
