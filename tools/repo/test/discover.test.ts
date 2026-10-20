// Tests for tools/repo/lib/discover.ts: the discover fixture roots, the exact index of ok-discover, and temporary roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { dataSees, discover, rootPath, sees } from '../lib/discover.ts';
import type { ModuleInfo } from '../lib/discover.ts';
import { isObject, readJson, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { formatProblem } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

const ROOTS = [
  'root-missing', 'json-parse', 'schema', 'bad-id', 'missing-file', 'duplicate-name', 'reserved-name', 'contract-shape', 'unknown-module',
  'implements-contract', 'require-contract', 'bad-dependency', 'deprecated', 'ok-discover', 'entry-host', 'optional-missing', 'schema-path',
];

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
function tempRepo(t: TestContext, files: Record<string, Json | string>): string {
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

function where(problems: readonly Problem[]): string[] {
  return [...new Set(problems.map((p) => `${p.rule} ${p.file}#${p.pointer}`))].sort();
}

for (const name of ROOTS) {
  test(`fixture root ${name} reports exactly the rule ids of its expect.json`, () => {
    const index = discover(repoRoot, `${FIXTURES}/${name}`, validator);
    const expected = expectOf(name);
    const shown = index.problems.map(formatProblem).join('\n');
    assert.deepEqual(ruleIds(index.problems, 'error'), expected.errors, shown);
    assert.deepEqual(ruleIds(index.problems, 'warning'), expected.warnings, shown);
  });
}

const LOCATIONS: [root: string, rule: string, file: string, pointer: string, severity: 'error' | 'warning'][] = [
  ['root-missing', 'root-missing', '', '', 'error'],
  ['schema', 'schema', 'modules/typo/module.json', '', 'error'],
  ['bad-id', 'bad-id', 'modules/wrong/module.json', '/id', 'error'],
  ['missing-file', 'missing-file', 'modules/holes/module.json', '/types/item', 'error'],
  ['duplicate-name', 'duplicate-name', 'modules/twice/module.json', '/systems/1/name', 'error'],
  ['reserved-name', 'reserved-name', 'modules/reserved/module.json', '/systems/0/name', 'error'],
  ['contract-shape', 'contract-shape', 'modules/shaped/module.json', '/systems', 'error'],
  ['unknown-module', 'unknown-module', 'modules/needy/module.json', '/requires/0', 'error'],
  ['implements-contract', 'implements-contract', 'modules/claims/module.json', '/implements/0', 'error'],
  ['require-contract', 'require-contract', 'modules/user/module.json', '/requires/0', 'error'],
  ['bad-dependency', 'bad-dependency', 'modules/both/module.json', '/optional/0', 'error'],
  ['deprecated', 'deprecated', 'modules/user/module.json', '/requires/0', 'warning'],
  ['entry-host', 'entry-host', 'games/demo/game.json', '/modules/pack/hosts/0', 'error'],
  ['optional-missing', 'unknown-module', 'modules/user/module.json', '/optional/0', 'warning'],
  ['schema-path', 'schema-path', 'modules/wrong/module.json', '/$schema', 'error'],
  ['schema-path', 'schema-path', 'games/demo/game.json', '/$schema', 'error'],
];

for (const [root, rule, file, pointer, severity] of LOCATIONS) {
  test(`fixture root ${root}: [${rule}] ${severity} at ${file || 'the root'}#${pointer}`, () => {
    const base = `${FIXTURES}/${root}`;
    const found = discover(repoRoot, base, validator).problems.filter((p) => p.rule === rule && p.file === (file === '' ? base : `${base}/${file}`) && p.pointer === pointer);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].severity, severity);
  });
}

test('json-parse reports the line of the first bad character, and the module is skipped', () => {
  const index = discover(repoRoot, `${FIXTURES}/json-parse`, validator);
  assert.equal(index.problems.length, 1);
  const [problem] = index.problems;
  assert.equal(problem.file, `${FIXTURES}/json-parse/modules/broken/module.json`);
  assert.equal(problem.line, 4);
  assert.equal(problem.pointer, '');
  assert.match(problem.message, /column 3/);
  assert.equal(index.modules.size, 0);
});

test('root-missing returns an empty index and one problem at the root', () => {
  const index = discover(repoRoot, `${FIXTURES}/root-missing`, validator);
  assert.equal(index.problems.length, 1);
  assert.equal(index.problems[0].file, `${FIXTURES}/root-missing`);
  assert.deepEqual([index.modules.size, index.types.size, index.games.size], [0, 0, 0]);
  assert.equal(index.root, `${FIXTURES}/root-missing`);
  assert.equal(index.repoRoot, repoRoot);
});

test('modules skipped for a schema, id or parse error stay out of the index; others stay in', () => {
  const skipped = ['schema', 'bad-id', 'json-parse'];
  for (const name of skipped) assert.equal(discover(repoRoot, `${FIXTURES}/${name}`, validator).modules.size, 0, name);
  const kept = ['missing-file', 'duplicate-name', 'reserved-name', 'contract-shape', 'unknown-module', 'implements-contract', 'bad-dependency', 'schema-path'];
  for (const name of kept) assert.ok(discover(repoRoot, `${FIXTURES}/${name}`, validator).modules.size > 0, name);
});

test('require-contract and optional-missing messages follow the plan', () => {
  const required = discover(repoRoot, `${FIXTURES}/require-contract`, validator).problems;
  assert.equal(required[0].message, 'impl implements contract api; require api');
  const optional = discover(repoRoot, `${FIXTURES}/optional-missing`, validator).problems;
  assert.equal(optional[0].message, 'ghost is not a module of this root; treated as absent');
  const deprecated = discover(repoRoot, `${FIXTURES}/deprecated`, validator).problems;
  assert.match(deprecated[0].message, /Use new\./);
});

test('ok-discover gives the exact ModuleInfo values', () => {
  const base = `${FIXTURES}/ok-discover`;
  const index = discover(repoRoot, base, validator);
  assert.deepEqual(index.problems, []);
  assert.deepEqual([...index.modules.keys()], ['api', 'feature', 'impl']);
  assert.deepEqual(index.modules.get('api'), {
    id: 'api',
    dir: `${base}/modules/api`,
    file: `${base}/modules/api/module.json`,
    contract: true,
    code: false,
    implements: [],
    requires: [],
    optional: [],
    types: {},
    events: { ping: `${base}/modules/api/schemas/ping.schema.json` },
    operations: { echo: { params: `${base}/modules/api/schemas/echo_params.schema.json`, result: `${base}/modules/api/schemas/echo_result.schema.json` } },
    config: { schema: `${base}/modules/api/schemas/config.schema.json`, defaults: { greeting: 'hello' } },
    systems: [],
    hosts: {},
    packages: [],
  });
  assert.deepEqual(index.modules.get('impl'), {
    id: 'impl',
    dir: `${base}/modules/impl`,
    file: `${base}/modules/impl/module.json`,
    contract: false,
    code: true,
    implements: ['api'],
    requires: [],
    optional: [],
    types: {},
    events: {},
    operations: {},
    state: `${base}/modules/impl/schemas/state.schema.json`,
    systems: [{ name: 'run', loop: 'fixed', after: [], before: [], index: 0 }],
    hosts: { node: `${base}/modules/impl/ts/index.ts` },
    packages: [],
  });
  assert.deepEqual(index.modules.get('feature'), {
    id: 'feature',
    dir: `${base}/modules/feature`,
    file: `${base}/modules/feature/module.json`,
    contract: false,
    code: true,
    implements: [],
    requires: ['api'],
    optional: [],
    types: {},
    events: {},
    operations: {},
    systems: [{ name: 'use', loop: 'fixed', after: ['api'], before: [], index: 0 }],
    hosts: { node: `${base}/modules/feature/ts/index.ts` },
    packages: [],
  });
});

test('ok-discover gives the exact GameInfo values and no record types', () => {
  const base = `${FIXTURES}/ok-discover`;
  const index = discover(repoRoot, base, validator);
  assert.equal(index.types.size, 0);
  assert.deepEqual([...index.games.keys()], ['demo']);
  assert.deepEqual(index.games.get('demo'), {
    id: 'demo',
    dir: `${base}/games/demo`,
    file: `${base}/games/demo/game.json`,
    summary: 'Runs impl and feature on node.',
    hosts: ['node'],
    fixedHz: 60,
    modules: { impl: {}, feature: {} },
  });
});

test('a manifest with every field gives the matching ModuleInfo with repo-relative paths', (t) => {
  const dir = tempRepo(t, {
    'modules/api/module.json': { id: 'api', summary: 'A contract.', contract: true },
    'modules/base/module.json': { id: 'base', summary: 'Plain.' },
    'modules/extra/module.json': { id: 'extra', summary: 'Plain.' },
    'modules/full/module.json': {
      id: 'full',
      summary: 'Every field.',
      deprecated: 'Use other.',
      implements: ['api'],
      requires: ['base'],
      optional: ['extra'],
      types: { item: 'schemas/item.schema.json' },
      events: { fired: 'schemas/fired.schema.json' },
      operations: { both: { params: 'schemas/p.schema.json', result: 'schemas/r.schema.json' }, only_result: { result: 'schemas/r.schema.json' }, none: {} },
      state: 'schemas/state.schema.json',
      config: { schema: 'schemas/config.schema.json', defaults: { a: 1 } },
      systems: [{ name: 'a', loop: 'fixed', after: ['base'], before: ['api.x'] }, { name: 'b', loop: 'frame' }],
      hosts: { node: 'ts/index.ts', python: 'python/full.py' },
      packages: ['node:fs', 'left-pad'],
    },
    ...Object.fromEntries(['item', 'fired', 'p', 'r', 'state', 'config'].map((n) => [`modules/full/schemas/${n}.schema.json`, {}])),
    'modules/full/ts/index.ts': 'export {};\n',
    'modules/full/python/full.py': '',
  });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual(index.problems, []);
  assert.deepEqual(index.modules.get('full'), {
    id: 'full',
    dir: 'modules/full',
    file: 'modules/full/module.json',
    contract: false,
    code: true,
    deprecated: 'Use other.',
    implements: ['api'],
    requires: ['base'],
    optional: ['extra'],
    types: { item: 'modules/full/schemas/item.schema.json' },
    events: { fired: 'modules/full/schemas/fired.schema.json' },
    operations: {
      both: { params: 'modules/full/schemas/p.schema.json', result: 'modules/full/schemas/r.schema.json' },
      only_result: { result: 'modules/full/schemas/r.schema.json' },
      none: {},
    },
    state: 'modules/full/schemas/state.schema.json',
    config: { schema: 'modules/full/schemas/config.schema.json', defaults: { a: 1 } },
    systems: [
      { name: 'a', loop: 'fixed', after: ['base'], before: ['api.x'], index: 0 },
      { name: 'b', loop: 'frame', after: [], before: [], index: 1 },
    ],
    hosts: { node: 'modules/full/ts/index.ts', python: 'modules/full/python/full.py' },
    packages: ['node:fs', 'left-pad'],
  });
});

test('types are indexed in id order with the version of properties.$version.const, or 0', (t) => {
  const version = (n: Json): Json => ({ properties: { $version: { const: n } } });
  const dir = tempRepo(t, {
    'modules/geo/module.json': {
      id: 'geo',
      summary: 'Types.',
      types: { zeta: 'schemas/zeta.schema.json', alpha: 'schemas/alpha.schema.json', loose: 'schemas/loose.schema.json', gone: 'schemas/gone.schema.json', text: 'schemas/text.schema.json', zero: 'schemas/zero.schema.json', bad: 'schemas/bad.schema.json' },
    },
    'modules/geo/schemas/zeta.schema.json': version(3),
    'modules/geo/schemas/alpha.schema.json': version(1),
    'modules/geo/schemas/loose.schema.json': { properties: {} },
    'modules/geo/schemas/text.schema.json': version('x'),
    'modules/geo/schemas/zero.schema.json': version(0),
    'modules/geo/schemas/bad.schema.json': '{ nope',
    'modules/abc/module.json': { id: 'abc', summary: 'More types.', types: { item: 'schemas/item.schema.json' } },
    'modules/abc/schemas/item.schema.json': version(2),
  });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual([...index.types.keys()], ['abc.item', 'geo.alpha', 'geo.bad', 'geo.gone', 'geo.loose', 'geo.text', 'geo.zero', 'geo.zeta']);
  assert.deepEqual(index.types.get('geo.zeta'), { id: 'geo.zeta', module: 'geo', name: 'zeta', schema: 'modules/geo/schemas/zeta.schema.json', version: 3 });
  assert.deepEqual([...index.types.values()].map((type) => type.version), [2, 1, 0, 0, 0, 0, 0, 3]);
  assert.deepEqual(where(index.problems), ['missing-file modules/geo/module.json#/types/gone']);
});

test('types are sorted by the JavaScript default string order of their ids', (t) => {
  const dir = tempRepo(t, {
    'modules/geo/module.json': { id: 'geo', summary: 'x', types: { bx: 'schemas/a.schema.json', b_x: 'schemas/a.schema.json', b1: 'schemas/a.schema.json' } },
    'modules/geo/schemas/a.schema.json': {},
  });
  assert.deepEqual([...discover(dir, '.', createValidator(dir)).types.keys()], ['geo.b1', 'geo.b_x', 'geo.bx']);
});

test('a folder without module.json, with a bad name, with another id, with the id trace, with bad JSON or a bad shape is skipped', (t) => {
  const dir = tempRepo(t, {
    'modules/Bad_Name/module.json': { id: 'bad_name', summary: 'x' },
    'modules/other/module.json': { id: 'another', summary: 'x' },
    'modules/trace/module.json': { id: 'trace', summary: 'x' },
    'modules/notjson/module.json': '[1',
    'modules/wrongshape/module.json': { id: 'wrongshape' },
    'modules/good/module.json': { id: 'good', summary: 'x' },
  });
  fs.mkdirSync(path.join(dir, 'modules', 'empty'));
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual([...index.modules.keys()], ['good']);
  assert.deepEqual(where(index.problems), [
    'bad-id modules/Bad_Name#',
    'bad-id modules/other/module.json#/id',
    'bad-id modules/trace/module.json#/id',
    'json-parse modules/notjson/module.json#',
    'missing-file modules/empty#',
    'schema modules/wrongshape/module.json#',
  ]);
});

test('game folders get the same checks, and a valid game enters the index', (t) => {
  const game = (id: string): Json => ({ id, summary: 'x', hosts: ['node'], fixedHz: 60, modules: {} });
  const dir = tempRepo(t, {
    'modules/pack/module.json': { id: 'pack', summary: 'x' },
    'games/Bad/game.json': game('bad'),
    'games/mismatch/game.json': game('other'),
    'games/notjson/game.json': '{',
    'games/shape/game.json': { id: 'shape' },
    'games/good/game.json': game('good'),
  });
  fs.mkdirSync(path.join(dir, 'games', 'empty'));
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual([...index.games.keys()], ['good']);
  assert.deepEqual(where(index.problems), [
    'bad-id games/Bad#',
    'bad-id games/mismatch/game.json#/id',
    'json-parse games/notjson/game.json#',
    'missing-file games/empty#',
    'schema games/shape/game.json#',
  ]);
});

test('a root without a games folder is fine, and a root that does not exist is root-missing', (t) => {
  const dir = tempRepo(t, { 'modules/pack/module.json': { id: 'pack', summary: 'x' } });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual([index.modules.size, index.games.size, index.problems.length], [1, 0, 0]);
  assert.deepEqual(where(discover(dir, 'nowhere', createValidator(dir)).problems), ['root-missing nowhere#']);
});

test('a contract that declares systems, hosts, state, implements, optional or packages breaks contract-shape per field', (t) => {
  const dir = tempRepo(t, {
    'modules/c/module.json': {
      id: 'c', summary: 'x', contract: true, systems: [], hosts: {}, state: 'schemas/state.schema.json', implements: [], optional: [], packages: [],
    },
    'modules/c/schemas/state.schema.json': {},
  });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual(where(index.problems), ['/systems', '/hosts', '/state', '/implements', '/optional', '/packages'].map((pointer) => `contract-shape modules/c/module.json#${pointer}`).sort());
});

test('operation names clash across implemented contracts and with own operations', (t) => {
  const dir = tempRepo(t, {
    'modules/c1/module.json': { id: 'c1', summary: 'x', contract: true, operations: { go: {}, stop: {} } },
    'modules/c2/module.json': { id: 'c2', summary: 'x', contract: true, operations: { go: {} } },
    'modules/both/module.json': { id: 'both', summary: 'x', implements: ['c1', 'c2'] },
    'modules/own/module.json': { id: 'own', summary: 'x', implements: ['c1'], operations: { go: {} } },
    'modules/fine/module.json': { id: 'fine', summary: 'x', implements: ['c1'], operations: { other: {} } },
  });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual(where(index.problems), ['duplicate-name modules/both/module.json#/implements/1', 'duplicate-name modules/own/module.json#/operations/go']);
});

test('a module that lists itself in requires or optional breaks bad-dependency', (t) => {
  const dir = tempRepo(t, { 'modules/selfish/module.json': { id: 'selfish', summary: 'x', requires: ['selfish'], optional: ['selfish'] } });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual(where(index.problems), ['bad-dependency modules/selfish/module.json#/optional/0', 'bad-dependency modules/selfish/module.json#/requires/0']);
});

test('an id in both requires and optional breaks bad-dependency also when it names no module', (t) => {
  const dir = tempRepo(t, { 'modules/user/module.json': { id: 'user', summary: 'x', requires: ['ghost'], optional: ['ghost'] } });
  assert.deepEqual(where(discover(dir, '.', createValidator(dir)).problems), [
    'bad-dependency modules/user/module.json#/optional/0',
    'unknown-module modules/user/module.json#/optional/0',
    'unknown-module modules/user/module.json#/requires/0',
  ]);
});

test('implements naming no module is an unknown-module error', (t) => {
  const dir = tempRepo(t, { 'modules/claims/module.json': { id: 'claims', summary: 'x', implements: ['ghost'] } });
  const problems = discover(dir, '.', createValidator(dir)).problems;
  assert.deepEqual(problems.map((p) => [p.rule, p.severity, p.file, p.pointer]), [['unknown-module', 'error', 'modules/claims/module.json', '/implements/0']]);
});

test('a folder with a bad name and no manifest is missing-file, the first check of step 2', (t) => {
  const dir = tempRepo(t, {});
  fs.mkdirSync(path.join(dir, 'modules', 'Bad'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'games', 'Bad'), { recursive: true });
  assert.deepEqual(where(discover(dir, '.', createValidator(dir)).problems), ['missing-file games/Bad#', 'missing-file modules/Bad#']);
});

test('every kind of manifest path that names no file is a missing-file problem at its pointer', (t) => {
  const dir = tempRepo(t, {
    'modules/holes/module.json': {
      id: 'holes',
      summary: 'x',
      types: { t: 'schemas/t.schema.json' },
      events: { e: 'schemas/e.schema.json' },
      operations: { o: { params: 'schemas/p.schema.json', result: 'schemas/r.schema.json' } },
      state: 'schemas/s.schema.json',
      config: { schema: 'schemas/c.schema.json', defaults: {} },
      hosts: { node: 'ts/index.ts' },
    },
  });
  const index = discover(dir, '.', createValidator(dir));
  assert.deepEqual(where(index.problems), ['/config/schema', '/events/e', '/hosts/node', '/operations/o/params', '/operations/o/result', '/state', '/types/t'].map((pointer) => `missing-file modules/holes/module.json#${pointer}`));
});

test('a path that names a folder instead of a file is a missing-file problem', (t) => {
  const dir = tempRepo(t, { 'modules/odd/module.json': { id: 'odd', summary: 'x', state: 'schemas' } });
  fs.mkdirSync(path.join(dir, 'modules', 'odd', 'schemas'));
  assert.deepEqual(where(discover(dir, '.', createValidator(dir)).problems), ['missing-file modules/odd/module.json#/state']);
});

test('code is true for systems, state, operations or hosts, and false for contracts and content packs', (t) => {
  const dir = tempRepo(t, {
    'modules/pack/module.json': { id: 'pack', summary: 'x', types: {}, events: {} },
    'modules/stateful/module.json': { id: 'stateful', summary: 'x', state: 'schemas/s.schema.json' },
    'modules/ops/module.json': { id: 'ops', summary: 'x', operations: { go: {} } },
    'modules/hosted/module.json': { id: 'hosted', summary: 'x', hosts: { node: 'ts/index.ts' } },
    'modules/sys/module.json': { id: 'sys', summary: 'x', systems: [{ name: 'run', loop: 'fixed' }] },
    'modules/contractor/module.json': { id: 'contractor', summary: 'x', contract: true, operations: { go: {} } },
  });
  const index = discover(dir, '.', createValidator(dir));
  const flags = Object.fromEntries([...index.modules.values()].map((m) => [m.id, [m.contract, m.code]]));
  assert.deepEqual(flags, {
    contractor: [true, false], hosted: [false, true], ops: [false, true], pack: [false, false], stateful: [false, true], sys: [false, true],
  });
});

function sample(overrides: Partial<ModuleInfo>): ModuleInfo {
  return {
    id: 'm', dir: 'modules/m', file: 'modules/m/module.json', contract: false, code: false, implements: [], requires: [], optional: [],
    types: {}, events: {}, operations: {}, systems: [], hosts: {}, packages: [], ...overrides,
  };
}

test('sees is the sorted id, implements, requires and optional; dataSees leaves optional out', () => {
  const m = sample({ id: 'm', implements: ['b'], requires: ['a', 'b'], optional: ['a', 'c'] });
  assert.deepEqual(sees(m), ['a', 'b', 'c', 'm']);
  assert.deepEqual(dataSees(m), ['a', 'b', 'm']);
  assert.deepEqual(sees(sample({})), ['m']);
  assert.deepEqual(dataSees(sample({})), ['m']);
});

test('sees and dataSees on discovered modules keep optional ids that are not modules', () => {
  const user = discover(repoRoot, `${FIXTURES}/optional-missing`, validator).modules.get('user');
  assert.ok(user);
  assert.deepEqual(sees(user), ['ghost', 'user']);
  assert.deepEqual(dataSees(user), ['user']);
  const feature = discover(repoRoot, `${FIXTURES}/ok-discover`, validator).modules.get('feature');
  assert.ok(feature);
  assert.deepEqual(sees(feature), ['api', 'feature']);
  assert.deepEqual(dataSees(feature), ['api', 'feature']);
});

test('rootPath joins a root and parts as a posix path and drops a leading dot', () => {
  assert.equal(rootPath('.', 'modules'), 'modules');
  assert.equal(rootPath('examples', 'modules', 'physics'), 'examples/modules/physics');
  assert.equal(rootPath('hosts/conformance', 'games'), 'hosts/conformance/games');
  assert.equal(rootPath('.'), '.');
});
