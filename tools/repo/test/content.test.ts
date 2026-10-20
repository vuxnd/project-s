// Tests for tools/repo/lib/content.ts: the content fixture roots, the exact records of ok-content, and temporary roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkMigrationFiles, checkRecord, checkSchemas, loadRecords } from '../lib/content.ts';
import type { RecordInfo, RecordSource } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import type { RootIndex } from '../lib/discover.ts';
import { isObject, readJson, writeJson, writeText } from '../lib/json.ts';
import type { Json, JsonObject } from '../lib/json.ts';
import { formatProblem } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const ROOTS = [
  'profile', 'record-type', 'ref-missing', 'invisible-ref', 'unknown-type', 'outdated-record', 'schema-path-record', 'dangling-ref', 'asset-missing',
  'migration-missing', 'schema-load', 'ok-content',
];

// Every problem of discover, checkSchemas, loadRecords and checkMigrationFiles for one root.
function run(repo: string, root = '.'): { index: RootIndex; records: RecordInfo[]; problems: Problem[] } {
  const validator = createValidator(repo);
  const index = discover(repo, root, validator);
  const loaded = loadRecords(index, validator);
  return { index, records: loaded.records, problems: [...index.problems, ...checkSchemas(index, validator), ...loaded.problems, ...checkMigrationFiles(index)] };
}

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

const mod = (id: string, extra: Record<string, Json> = {}): Json => ({ id, summary: 'x', ...extra });

// A record type schema with the envelope; the given properties are required unless `required` says otherwise.
function recordType(properties: Record<string, Json>, options: { version?: number; required?: string[] } = {}): JsonObject {
  const { version = 1, required = Object.keys(properties) } = options;
  return {
    $schema: DRAFT,
    type: 'object',
    additionalProperties: false,
    required: ['$version', ...required],
    properties: { $schema: { type: 'string' }, $version: { const: version }, $comment: { type: 'string' }, ...properties },
  };
}

const LOCATIONS: [root: string, rule: string, file: string, pointer: string, severity: 'error' | 'warning', count?: number][] = [
  ['profile', 'profile', 'modules/loose/schemas/thing.schema.json', '/properties/value', 'error'],
  ['record-type', 'record-type', 'modules/shapeless/schemas/item.schema.json', '/properties', 'error'],
  ['record-type', 'record-type', 'modules/shapeless/schemas/item.schema.json', '', 'error'],
  ['ref-missing', 'ref-missing', 'modules/dangling/schemas/item.schema.json', '/properties/extra/$ref', 'error'],
  ['invisible-ref', 'invisible-ref', 'modules/stranger/schemas/thing.schema.json', '/properties/owned/$ref', 'error'],
  ['invisible-ref', 'invisible-ref', 'modules/stranger/schemas/thing.schema.json', '/properties/target/x-ref', 'error'],
  ['invisible-ref', 'invisible-ref', 'modules/stranger/content/owner.item/one.json', '', 'error'],
  ['unknown-type', 'unknown-type', 'modules/pack/content/ghost.item/one.json', '', 'error'],
  ['outdated-record', 'outdated-record', 'modules/kinds/content/kinds.item/old.json', '/$version', 'error'],
  ['schema-path-record', 'schema-path', 'modules/kinds/content/kinds.item/one.json', '/$schema', 'error'],
  ['dangling-ref', 'dangling-ref', 'modules/kinds/content/kinds.link/one.json', '/target', 'error'],
  ['asset-missing', 'asset-missing', 'modules/art/content/art.model/missing.json', '/file', 'error'],
  ['asset-missing', 'asset-missing', 'modules/art/content/art.model/wrong_ext.json', '/file', 'error'],
  ['asset-missing', 'asset-missing', 'modules/art/content/art.model/outside.json', '/file', 'error'],
  ['migration-missing', 'migration-missing', 'modules/kinds/schemas/item.schema.json', '/properties/$version/const', 'error', 3],
  ['schema-load', 'schema-load', 'modules/bad/schemas/item.schema.json', '', 'error'],
  ['ok-content', 'deprecated', 'modules/pack/content/geo.body/crate.json', '/legacy', 'warning'],
];

for (const name of ROOTS) {
  test(`fixture root ${name} reports exactly the rule ids of its expect.json, at the places listed here`, () => {
    const { problems } = run(repoRoot, `${FIXTURES}/${name}`);
    const expected = expectOf(name);
    const shown = problems.map(formatProblem).join('\n');
    assert.deepEqual(ruleIds(problems, 'error'), expected.errors, shown);
    assert.deepEqual(ruleIds(problems, 'warning'), expected.warnings, shown);
    const places = LOCATIONS.filter((l) => l[0] === name);
    for (const [, rule, file, pointer, severity, count = 1] of places) {
      const found = problems.filter((p) => p.rule === rule && p.file === `${FIXTURES}/${name}/${file}` && p.pointer === pointer);
      assert.equal(found.length, count, `${rule} ${file}#${pointer}\n${shown}`);
      assert.ok(found.every((p) => p.severity === severity));
    }
    assert.equal(problems.length, places.reduce((sum, l) => sum + (l[5] ?? 1), 0), shown);
  });
}

test('ok-content gives the exact RecordInfo list with x-asset rewritten to a repository path', () => {
  const base = `${FIXTURES}/ok-content`;
  const asset = `${base}/modules/pack/assets/box.glb`;
  const { records } = run(repoRoot, base);
  assert.deepEqual(records, [
    { type: 'geo.body', id: 'geo/box', module: 'geo', file: `${base}/modules/geo/content/geo.body/box.json`, pointer: '', version: 1, body: { size: [1, 1, 1] }, assets: [] },
    {
      type: 'geo.body',
      id: 'pack/crate',
      module: 'pack',
      file: `${base}/modules/pack/content/geo.body/crate.json`,
      pointer: '',
      version: 1,
      body: { size: [2, 2, 2], model: asset, legacy: 'wooden crate' },
      assets: [asset],
    },
    { type: 'pack.spawn', id: 'pack/one', module: 'pack', file: `${base}/modules/pack/content/pack.spawn/one.json`, pointer: '', version: 1, body: { body: 'pack/crate', position: [0, 5, 0] }, assets: [] },
  ]);
});

test('outdated-record says which type, which version and how to fix it', () => {
  const { problems } = run(repoRoot, `${FIXTURES}/outdated-record`);
  assert.deepEqual(problems.map((p) => p.message), ['kinds/old: $version 1 is older than kinds.item 2; run npm run migrate -- --write']);
});

test('a missing 2.after.json is migration-missing and names the file; the complete fixture has none', (t) => {
  const dir = tempRepo(t, {});
  fs.cpSync(path.join(repoRoot, ...FIXTURES.split('/'), 'outdated-record', 'modules'), path.join(dir, 'modules'), { recursive: true });
  const validator = createValidator(dir);
  assert.deepEqual(checkMigrationFiles(discover(dir, '.', validator)), []);
  fs.rmSync(path.join(dir, 'modules', 'kinds', 'migrations', 'item', '2.after.json'));
  const problems = checkMigrationFiles(discover(dir, '.', validator));
  assert.deepEqual(problems.map((p) => [p.rule, p.file, p.pointer]), [['migration-missing', 'modules/kinds/schemas/item.schema.json', '/properties/$version/const']]);
  assert.ok(problems[0].message.includes('modules/kinds/migrations/item/2.after.json'), problems[0].message);
});

test('checkMigrationFiles wants every step from 2 to N, and nothing for a type at version 1', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { one: 'schemas/one.schema.json', three: 'schemas/three.schema.json' } }),
    'modules/m/schemas/one.schema.json': recordType({}),
    'modules/m/schemas/three.schema.json': recordType({}, { version: 3 }),
    'modules/m/migrations/three/2.ts': 'export default (record: Record<string, unknown>) => record;\n',
    'modules/m/migrations/three/2.before.json': { $version: 1 },
    'modules/m/migrations/three/2.after.json': { $version: 2 },
    'modules/m/migrations/three/3.ts': 'export default (record: Record<string, unknown>) => record;\n',
  });
  const problems = checkMigrationFiles(discover(dir, '.', createValidator(dir)));
  assert.deepEqual(problems.map((p) => [p.file, p.pointer]), [['modules/m/schemas/three.schema.json', '/properties/$version/const'], ['modules/m/schemas/three.schema.json', '/properties/$version/const']]);
  assert.deepEqual(problems.map((p) => p.message.split('/').pop()), ['3.before.json does not exist', '3.after.json does not exist']);
});

test('every schema file a manifest names is checked: types, events, operation params and results, state and config', (t) => {
  const bad: Json = { $schema: DRAFT, oneOf: [] };
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', {
      types: { item: 'schemas/t.schema.json' },
      events: { e: 'schemas/e.schema.json' },
      operations: { o: { params: 'schemas/p.schema.json', result: 'schemas/r.schema.json' } },
      state: 'schemas/s.schema.json',
      config: { schema: 'schemas/c.schema.json', defaults: {} },
    }),
    ...Object.fromEntries(['t', 'e', 'p', 'r', 's', 'c'].map((n) => [`modules/m/schemas/${n}.schema.json`, bad])),
  });
  assert.deepEqual(where(run(dir).problems), [
    ...['c', 'e', 'p', 'r', 's', 't'].map((n) => `profile modules/m/schemas/${n}.schema.json#`),
    'record-type modules/m/schemas/t.schema.json#',
  ]);
});

test('a manifest path that names no file is left to discover, and a schema that is not JSON is json-parse with its line', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { events: { gone: 'schemas/gone.schema.json', broken: 'schemas/broken.schema.json' } }),
    'modules/m/schemas/broken.schema.json': '{\n  "type": \n}\n',
  });
  const problems = run(dir).problems;
  assert.deepEqual(problems.map((p) => [p.rule, p.file, p.pointer, p.line]), [
    ['missing-file', 'modules/m/module.json', '/events/gone', undefined],
    ['json-parse', 'modules/m/schemas/broken.schema.json', '', 3],
  ]);
});

test('a file reached through $ref is checked once, as part of the module whose folder holds it', (t) => {
  const user = (ref: string): Json => ({ $schema: DRAFT, type: 'object', additionalProperties: false, properties: { s: { $ref: ref } } });
  const dir = tempRepo(t, {
    'modules/a/module.json': mod('a', { events: { e0: 'schemas/e0.schema.json' } }),
    'modules/a/schemas/e0.schema.json': user('shared.schema.json'),
    'modules/a/schemas/shared.schema.json': { $schema: DRAFT, type: 'string', 'x-ref': 'b.thing' },
    'modules/b/module.json': mod('b', { requires: ['a'], types: { thing: 'schemas/thing.schema.json' }, events: { e1: 'schemas/e1.schema.json', e2: 'schemas/e2.schema.json' } }),
    'modules/b/schemas/thing.schema.json': recordType({}),
    'modules/b/schemas/e1.schema.json': user('../../a/schemas/shared.schema.json'),
    'modules/b/schemas/e2.schema.json': user('../../a/schemas/shared.schema.json'),
  });
  const problems = run(dir).problems;
  assert.deepEqual(problems.map((p) => `${p.rule} ${p.file}#${p.pointer}`), ['invisible-ref modules/a/schemas/shared.schema.json#/x-ref']);
});

test('profile errors in a file reached only through $ref are reported at that file and pointer', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { events: { e: 'schemas/e.schema.json' } }),
    'modules/m/schemas/e.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { x: { $ref: 'extra.schema.json' } } },
    'modules/m/schemas/extra.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { v: { anyOf: [{ type: 'string' }] }, w: { type: 'string', 'x-asset': ['gltf'] } } },
  });
  assert.deepEqual(where(run(dir).problems), ['profile modules/m/schemas/extra.schema.json#/properties/v', 'profile modules/m/schemas/extra.schema.json#/properties/w']);
});

test('a $ref to a missing file, a missing $defs entry or a file outside the repository is ref-missing at the $ref', (t) => {
  const object = (properties: Record<string, Json>): Json => ({ $schema: DRAFT, type: 'object', additionalProperties: false, properties, $defs: { yes: { type: 'string' } } });
  const outside = `repo-outside-${process.pid}.schema.json`;   // exists, next to the temporary repository
  fs.writeFileSync(path.join(os.tmpdir(), outside), '{}\n');
  t.after(() => fs.rmSync(path.join(os.tmpdir(), outside), { force: true }));
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', {
      events: { file: 'schemas/file.schema.json', frag: 'schemas/frag.schema.json', local: 'schemas/local.schema.json', ok: 'schemas/ok.schema.json', out: 'schemas/out.schema.json' },
    }),
    'modules/m/schemas/other.schema.json': { $schema: DRAFT, $defs: { yes: { type: 'string' } } },
    'modules/m/schemas/file.schema.json': { $schema: DRAFT, $ref: 'nope.schema.json' },
    'modules/m/schemas/frag.schema.json': { $schema: DRAFT, $ref: 'other.schema.json#/$defs/nope' },
    'modules/m/schemas/local.schema.json': object({ a: { $ref: '#/$defs/nope' } }),
    'modules/m/schemas/ok.schema.json': object({ a: { $ref: '#/$defs/yes' }, b: { $ref: 'other.schema.json#/$defs/yes' } }),
    'modules/m/schemas/out.schema.json': { $schema: DRAFT, $ref: `../../../../${outside}` },
  });
  assert.deepEqual(where(run(dir).problems), [
    'ref-missing modules/m/schemas/file.schema.json#/$ref',
    'ref-missing modules/m/schemas/frag.schema.json#/$ref',
    'ref-missing modules/m/schemas/local.schema.json#/properties/a/$ref',
    'ref-missing modules/m/schemas/out.schema.json#/$ref',
  ]);
});

test('a $ref reaches the folders of the module, its implements and its requires, not optional or foreign ones', (t) => {
  const user = (ref: string): Json => ({ $schema: DRAFT, type: 'object', additionalProperties: false, properties: { s: { $ref: ref } } });
  const lib = '../../lib/schemas/shape.schema.json';
  const dir = tempRepo(t, {
    'modules/lib/module.json': mod('lib', { contract: true, events: { shape: 'schemas/shape.schema.json' } }),
    'modules/lib/schemas/shape.schema.json': { $schema: DRAFT, type: 'string' },
    ...Object.fromEntries([['plain', {}, lib], ['req', { requires: ['lib'] }, lib], ['opt', { optional: ['lib'] }, lib], ['impl', { implements: ['lib'] }, lib], ['outside', {}, '../../../schemas/module.schema.json']]
      .flatMap(([id, extra, ref]) => [
        [`modules/${id as string}/module.json`, mod(id as string, { ...(extra as Record<string, Json>), events: { e: 'schemas/e.schema.json' } })],
        [`modules/${id as string}/schemas/e.schema.json`, user(ref as string)],
      ])),
  });
  assert.deepEqual(where(run(dir).problems), [
    'invisible-ref modules/opt/schemas/e.schema.json#/properties/s/$ref',
    'invisible-ref modules/outside/schemas/e.schema.json#/properties/s/$ref',
    'invisible-ref modules/plain/schemas/e.schema.json#/properties/s/$ref',
  ]);
});

test('an x-ref names a declared type whose module the schema requires or implements', (t) => {
  const event = (properties: Record<string, string>): Json => ({
    $schema: DRAFT,
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type: 'string', 'x-ref': type }])),
  });
  const dir = tempRepo(t, {
    'modules/kinds/module.json': mod('kinds', { types: { item: 'schemas/item.schema.json' } }),
    'modules/kinds/schemas/item.schema.json': recordType({}),
    'modules/re/module.json': mod('re'),   // its name is a prefix of req
    ...Object.fromEntries([['req', { requires: ['kinds'] }, { t: 'kinds.item' }], ['opt', { optional: ['kinds'] }, { t: 'kinds.item' }], ['none', {}, { t: 'kinds.item' }], ['unk', {}, { a: 'kinds.ghost', b: 'nomod.item' }]]
      .flatMap(([id, extra, properties]) => [
        [`modules/${id as string}/module.json`, mod(id as string, { ...(extra as Record<string, Json>), events: { e: 'schemas/e.schema.json' } })],
        [`modules/${id as string}/schemas/e.schema.json`, event(properties as Record<string, string>)],
      ])),
  });
  assert.deepEqual(where(run(dir).problems), [
    'invisible-ref modules/none/schemas/e.schema.json#/properties/t/x-ref',
    'invisible-ref modules/opt/schemas/e.schema.json#/properties/t/x-ref',
    'unknown-type modules/unk/schemas/e.schema.json#/properties/a/x-ref',
    'unknown-type modules/unk/schemas/e.schema.json#/properties/b/x-ref',
  ]);
});

test('a schema with a profile error is not loaded again: Ajv would only repeat the mistake', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { events: { e: 'schemas/e.schema.json' } }),
    'modules/m/schemas/e.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, required: ['a'] },
  });
  assert.equal(createValidator(dir).load('modules/m/schemas/e.schema.json')[0]?.rule, 'schema-load');
  assert.deepEqual(where(run(dir).problems), ['profile modules/m/schemas/e.schema.json#']);
});

const itemRepo = (extra: Record<string, Json | string> = {}): Record<string, Json | string> => ({
  'modules/m/module.json': mod('m', { types: { item: 'schemas/item.schema.json' } }),
  'modules/m/schemas/item.schema.json': recordType({ name: { type: 'string' } }),
  ...extra,
});

test('content files must be <type id>/<name>.json with a name that follows the pattern', (t) => {
  const record = { $version: 1, name: 'x' };
  const dir = tempRepo(t, itemRepo({
    'modules/m/content/m.item/good.json': record,
    'modules/m/content/m.item/Bad.json': record,
    'modules/m/content/m.item/README.md': 'text\n',
    'modules/m/content/m.item/sub/deep.json': record,
    'modules/m/content/stray.json': record,
  }));
  const { records, problems } = run(dir);
  assert.deepEqual(where(problems), ['Bad.json', 'README.md', 'sub/deep.json'].map((f) => `bad-id modules/m/content/m.item/${f}#`).concat('bad-id modules/m/content/stray.json#').sort());
  assert.deepEqual(records.map((r) => r.id), ['m/good']);
});

test('a record that is not JSON is json-parse with its line, and one that is no object is a schema problem', (t) => {
  const dir = tempRepo(t, itemRepo({
    'modules/m/content/m.item/broken.json': '{\n  "a": \n}\n',
    'modules/m/content/m.item/list.json': '[1]\n',
    'modules/m/content/m.item/nothing.json': 'null\n',
  }));
  const { records, problems } = run(dir);
  assert.deepEqual(problems.map((p) => [p.rule, p.file, p.pointer, p.line]), [
    ['json-parse', 'modules/m/content/m.item/broken.json', '', 3],
    ['schema', 'modules/m/content/m.item/list.json', '', undefined],
    ['schema', 'modules/m/content/m.item/nothing.json', '', undefined],
  ]);
  assert.deepEqual(records, []);
});

test('a record missing $version, newer than its type, or with a text or fractional $version fails the schema; unknown properties too', (t) => {
  const dir = tempRepo(t, itemRepo({
    'modules/m/content/m.item/missing.json': { name: 'x' },
    'modules/m/content/m.item/newer.json': { $version: 2, name: 'x' },
    'modules/m/content/m.item/text.json': { $version: '1', name: 'x' },
    'modules/m/content/m.item/fraction.json': { $version: 0.5, name: 'x' },
    'modules/m/content/m.item/extra.json': { $version: 1, name: 'x', other: 1 },
  }));
  const { records, problems } = run(dir);
  assert.deepEqual(where(problems), [
    'schema modules/m/content/m.item/extra.json#',
    'schema modules/m/content/m.item/fraction.json#/$version',
    'schema modules/m/content/m.item/missing.json#',
    'schema modules/m/content/m.item/newer.json#/$version',
    'schema modules/m/content/m.item/text.json#/$version',
  ]);
  assert.ok(problems.every((p) => p.severity === 'error'));
  assert.deepEqual(records, []);
});

test('loadRecords sorts by type, then id, and a reference may name a record that is read later', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { b: 'schemas/b.schema.json', a: 'schemas/a.schema.json' } }),
    'modules/m/schemas/a.schema.json': recordType({ link: { type: 'string', 'x-ref': 'm.b' } }, { required: [] }),
    'modules/m/schemas/b.schema.json': recordType({}),
    'modules/m/content/m.b/z.json': { $version: 1 },
    'modules/m/content/m.a/y.json': { $version: 1 },
    'modules/m/content/m.a/x.json': { $version: 1, link: 'm/z' },
    'modules/n/module.json': mod('n', { requires: ['m'] }),
    'modules/n/content/m.a/w.json': { $version: 1 },
  });
  const { records, problems } = run(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(records.map((r) => `${r.type} ${r.id}`), ['m.a m/x', 'm.a m/y', 'm.a n/w', 'm.b m/z']);
  assert.deepEqual(records[0], { type: 'm.a', id: 'm/x', module: 'm', file: 'modules/m/content/m.a/x.json', pointer: '', version: 1, body: { link: 'm/z' }, assets: [] });
});

test('records of a type without a valid $version are skipped: checkSchemas reports the type once', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { item: 'schemas/item.schema.json' } }),
    'modules/m/schemas/item.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } },
    'modules/m/content/m.item/one.json': { name: 'x' },
  });
  const { records, problems, index } = run(dir);
  assert.deepEqual(loadRecords(index, createValidator(dir)), { records: [], problems: [] });
  assert.deepEqual(records, []);
  assert.deepEqual(ruleIds(problems, 'error'), ['record-type']);
});

test('an x-ref to a record that fails its own checks is not dangling', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { item: 'schemas/item.schema.json', link: 'schemas/link.schema.json' } }),
    'modules/m/schemas/item.schema.json': recordType({ name: { type: 'string' } }),
    'modules/m/schemas/link.schema.json': recordType({ target: { type: 'string', 'x-ref': 'm.item' } }),
    'modules/m/content/m.item/bad.json': { $version: 1 },
    'modules/m/content/m.link/one.json': { $version: 1, target: 'm/bad' },
  });
  const { records, problems } = run(dir);
  assert.deepEqual(where(problems), ['schema modules/m/content/m.item/bad.json#']);
  assert.deepEqual(records.map((r) => r.id), ['m/one']);
});

test('annotations are checked only after the record validates', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { link: 'schemas/link.schema.json' } }),
    'modules/m/schemas/link.schema.json': recordType({ target: { type: 'string', 'x-ref': 'm.link' }, pic: { type: 'string', 'x-asset': ['png'] } }, { required: [] }),
    'modules/m/content/m.link/one.json': { $version: 1, target: 'm/ghost', pic: 'assets/none.png', other: 1 },
  });
  const { records, problems } = run(dir);
  assert.deepEqual(where(problems), ['schema modules/m/content/m.link/one.json#']);
  assert.deepEqual(records, []);
});

test('x-ref targets must lie in a module the record requires or implements; optional is not enough', (t) => {
  const dir = tempRepo(t, {
    'modules/b/module.json': mod('b', { types: { thing: 'schemas/thing.schema.json' } }),
    'modules/b/schemas/thing.schema.json': recordType({}),
    'modules/b/content/b.thing/one.json': { $version: 1 },
    'modules/a/module.json': mod('a', { requires: ['b'], types: { item: 'schemas/item.schema.json' } }),
    'modules/a/schemas/item.schema.json': recordType({ ref: { type: 'string', 'x-ref': 'b.thing' } }),
    ...Object.fromEntries([['c', { requires: ['a'] }], ['d', { requires: ['a', 'b'] }], ['e', { requires: ['a'], optional: ['b'] }]].flatMap(([id, extra]) => [
      [`modules/${id as string}/module.json`, mod(id as string, extra as Record<string, Json>)],
      [`modules/${id as string}/content/a.item/r.json`, { $version: 1, ref: 'b/one' }],
    ])),
  });
  assert.deepEqual(where(run(dir).problems), ['invisible-ref modules/c/content/a.item/r.json#/ref', 'invisible-ref modules/e/content/a.item/r.json#/ref']);
});

test('x-asset values stay inside the module, carry a listed extension in any case and name a file', (t) => {
  const values: [value: string, ok: boolean][] = [
    ['assets/ok.png', true], ['assets/UP.PNG', true], ['/assets/ok.png', false], ['assets\\ok.png', false], ['assets/../assets/ok.png', false], ['..', false],
    ['assets/ok.gif', false], ['assets/ok', false], ['assets/dir.png', false], ['assets/none.png', false], ['', false],
  ];
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { art: 'schemas/art.schema.json' } }),
    'modules/m/schemas/art.schema.json': recordType({ pic: { type: 'string', 'x-asset': ['png'] } }),
    'modules/m/assets/ok.png': 'png\n',
    'modules/m/assets/UP.PNG': 'png\n',
    'modules/m/assets/dir.png/inner.txt': 'x\n',
    ...Object.fromEntries(values.map(([value], i) => [`modules/m/content/m.art/r${i}.json`, { $version: 1, pic: value }])),
  });
  const { records, problems } = run(dir);
  assert.deepEqual(where(problems), values.flatMap(([, ok], i) => (ok ? [] : [`asset-missing modules/m/content/m.art/r${i}.json#/pic`])).sort());
  assert.deepEqual(records.map((r) => r.body.pic), ['modules/m/assets/ok.png', 'modules/m/assets/UP.PNG']);
});

test('the annotation walk follows properties, items, map values and $ref; errors drop the record, warnings keep it', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { thing: 'schemas/thing.schema.json', legacy: 'schemas/legacy.schema.json' } }),
    'modules/m/schemas/thing.schema.json': {
      ...recordType({
        list: { type: 'array', items: { type: 'string', 'x-asset': ['png'] } },
        map: { type: 'object', propertyNames: { $ref: '#/$defs/id' }, additionalProperties: { $ref: '#/$defs/target' } },
        deep: { $ref: '#/$defs/wrapper' },
        old: { $ref: '#/$defs/oldText', deprecated: true },
      }, { required: [] }),
      $defs: {
        id: { type: 'string', pattern: '^[a-z]+$' },
        target: { type: 'string', 'x-ref': 'm.thing' },
        wrapper: { type: 'object', additionalProperties: false, properties: { pic: { type: 'string', 'x-asset': ['png', 'jpg'] } } },
        oldText: { type: 'string', deprecated: true, description: 'Use new.' },
      },
    },
    'modules/m/schemas/legacy.schema.json': { ...recordType({}), deprecated: true },
    'modules/m/assets/x.PNG': 'x\n',
    'modules/m/assets/y.png': 'x\n',
    'modules/m/assets/z.jpg': 'x\n',
    'modules/m/content/m.thing/a.json': { $version: 1, deep: { pic: 'assets/z.jpg' }, list: ['assets/y.png', 'assets/x.PNG', 'assets/y.png'], map: { k: 'm/b' } },
    'modules/m/content/m.thing/b.json': { $version: 1 },
    'modules/m/content/m.thing/c.json': { $version: 1, map: { k: 'm/ghost' } },
    'modules/m/content/m.thing/d.json': { $version: 1, old: 'x', list: ['assets/none.png'] },
    'modules/m/content/m.thing/e.json': { $version: 1, old: 'x' },
    'modules/m/content/m.legacy/one.json': { $version: 1 },
  });
  const { records, problems } = run(dir);
  assert.deepEqual(problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`).sort(), [
    'error asset-missing modules/m/content/m.thing/d.json#/list/0',
    'error dangling-ref modules/m/content/m.thing/c.json#/map/k',
    'warning deprecated modules/m/content/m.legacy/one.json#',
    'warning deprecated modules/m/content/m.thing/d.json#/old',
    'warning deprecated modules/m/content/m.thing/e.json#/old',
  ]);
  assert.deepEqual(records.map((r) => r.id), ['m/one', 'm/a', 'm/b', 'm/e']);
  const a = records.find((r) => r.id === 'm/a');
  assert.deepEqual(a?.body, {
    deep: { pic: 'modules/m/assets/z.jpg' },
    list: ['modules/m/assets/y.png', 'modules/m/assets/x.PNG', 'modules/m/assets/y.png'],
    map: { k: 'm/b' },
  });
  assert.deepEqual(a?.assets, ['modules/m/assets/x.PNG', 'modules/m/assets/y.png', 'modules/m/assets/z.jpg']);
});

test('the annotation walk follows a $ref into another file and the $refs inside that file', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': mod('m', { types: { item: 'schemas/item.schema.json', thing: 'schemas/thing.schema.json' } }),
    'modules/m/schemas/item.schema.json': recordType({ name: { type: 'string' } }),
    'modules/m/schemas/thing.schema.json': recordType({
      pic: { $ref: 'other.schema.json#/$defs/pic' },
      model: { $ref: 'model.schema.json' },
      link: { $ref: 'other.schema.json#/$defs/link' },
      old: { $ref: 'other.schema.json#/$defs/old' },
    }, { required: [] }),
    'modules/m/schemas/other.schema.json': { $schema: DRAFT, $defs: { pic: { type: 'string', 'x-asset': ['png'] }, link: { type: 'string', 'x-ref': 'm.item' }, old: { type: 'string', deprecated: true } } },
    'modules/m/schemas/model.schema.json': { $schema: DRAFT, $ref: '#/$defs/m', $defs: { m: { type: 'string', 'x-asset': ['glb'] } } },
    'modules/m/assets/a.png': 'x\n',
    'modules/m/assets/b.glb': 'x\n',
    'modules/m/content/m.item/i.json': { $version: 1, name: 'i' },
    'modules/m/content/m.thing/good.json': { $version: 1, pic: 'assets/a.png', model: 'assets/b.glb', link: 'm/i', old: 'x' },
    'modules/m/content/m.thing/bad.json': { $version: 1, pic: 'assets/none.png', model: 'assets/none.glb', link: 'm/ghost' },
  });
  const { records, problems } = run(dir);
  assert.deepEqual(problems.map((p) => `${p.severity} ${p.rule} ${p.file}#${p.pointer}`).sort(), [
    'error asset-missing modules/m/content/m.thing/bad.json#/model',
    'error asset-missing modules/m/content/m.thing/bad.json#/pic',
    'error dangling-ref modules/m/content/m.thing/bad.json#/link',
    'warning deprecated modules/m/content/m.thing/good.json#/old',
  ]);
  assert.deepEqual(records.find((r) => r.id === 'm/good')?.body, { pic: 'modules/m/assets/a.png', model: 'modules/m/assets/b.glb', link: 'm/i', old: 'x' });
});

function traceSource(type: string, name: string, value: JsonObject): RecordSource {
  return { type, id: `trace/${name}`, module: 'trace', file: 'tools/trace.json', pointer: `/records/${type}/${name}`, value };
}

test('checkRecord with module trace skips visibility, $schema paths and module folders; pointers start at the record', () => {
  const validator = createValidator(repoRoot);
  const content = discover(repoRoot, `${FIXTURES}/ok-content`, validator);
  const known = new Set(['geo.body trace/ball', 'geo.body geo/box']);

  const spawn = { $version: 1, body: 'trace/ball', position: [0, 1, 0] };
  const fromTrace = checkRecord(content, validator, traceSource('pack.spawn', 's', spawn), known);
  assert.deepEqual(fromTrace.problems, []);
  assert.deepEqual(fromTrace.record, {
    type: 'pack.spawn', id: 'trace/s', module: 'trace', file: 'tools/trace.json', pointer: '/records/pack.spawn/s', version: 1, body: { body: 'trace/ball', position: [0, 1, 0] }, assets: [],
  });
  const fromPack = checkRecord(content, validator, { type: 'pack.spawn', id: 'pack/s', module: 'pack', file: 'x/s.json', pointer: '', value: spawn }, known);
  assert.deepEqual(fromPack.problems.map((p) => [p.rule, p.pointer]), [['invisible-ref', '/body']]);
  assert.equal(fromPack.record, undefined);

  const dangling = checkRecord(content, validator, traceSource('pack.spawn', 's', { ...spawn, body: 'trace/none' }), known);
  assert.deepEqual(dangling.problems.map((p) => [p.rule, p.pointer]), [['dangling-ref', '/records/pack.spawn/s/body']]);

  const wrongPath = { $schema: 'wrong', $version: 1, size: [1, 1, 1] };
  assert.deepEqual(checkRecord(content, validator, traceSource('geo.body', 'b', wrongPath), known).problems, []);
  const inGeo = checkRecord(content, validator, { type: 'geo.body', id: 'geo/b', module: 'geo', file: 'x/b.json', pointer: '', value: wrongPath }, known);
  assert.deepEqual(inGeo.problems.map((p) => [p.rule, p.pointer]), [['schema-path', '/$schema']]);

  const withModel = { $version: 1, size: [1, 1, 1], model: 'assets/box.glb' };
  const existing = { ...withModel, model: `${FIXTURES}/ok-content/modules/pack/assets/box.glb` };   // a GLB file relative to the repository root
  const traceAsset = checkRecord(content, validator, traceSource('geo.body', 'c', existing), known);
  assert.deepEqual(traceAsset.problems.map((p) => [p.rule, p.pointer]), [['asset-missing', '/records/geo.body/c/model']]);
  assert.equal(traceAsset.record, undefined);
  const packAsset = checkRecord(content, validator, { type: 'geo.body', id: 'pack/c', module: 'pack', file: 'x/c.json', pointer: '', value: withModel }, known);
  assert.deepEqual(packAsset.problems, []);

  const invalid = checkRecord(content, validator, traceSource('geo.body', 'd', { $version: 1 }), known);
  assert.deepEqual(invalid.problems.map((p) => [p.rule, p.pointer]), [['schema', '/records/geo.body/d']]);
});

test('checkRecord with module trace reaches a type of a module nobody requires, an outdated trace record and an unknown type', () => {
  const validator = createValidator(repoRoot);
  const invisible = discover(repoRoot, `${FIXTURES}/invisible-ref`, validator);
  const item = { $version: 1, name: 'one' };
  const known = new Set<string>();
  assert.equal(checkRecord(invisible, validator, traceSource('owner.item', 'i', item), known).record?.id, 'trace/i');
  assert.equal(checkRecord(invisible, validator, { type: 'owner.item', id: 'owner/i', module: 'owner', file: 'x/i.json', pointer: '', value: item }, known).record?.id, 'owner/i');
  const stranger = checkRecord(invisible, validator, { type: 'owner.item', id: 'stranger/i', module: 'stranger', file: 'x/i.json', pointer: '', value: item }, known);
  assert.deepEqual(stranger.problems.map((p) => p.rule), ['invisible-ref']);

  const outdated = discover(repoRoot, `${FIXTURES}/outdated-record`, validator);
  const old = checkRecord(outdated, validator, traceSource('kinds.item', 'r', { $version: 1, name: 'x', garbage: true }), known);
  assert.deepEqual(old.problems.map((p) => [p.rule, p.pointer]), [['outdated-record', '/records/kinds.item/r/$version']]);
  assert.equal(old.record, undefined);
  const current = checkRecord(outdated, validator, traceSource('kinds.item', 'r', { $version: 2, label: 'x' }), known);
  assert.deepEqual(current.problems, []);

  const unknown = checkRecord(outdated, validator, traceSource('ghost.item', 'g', { $version: 1 }), known);
  assert.deepEqual(unknown.problems.map((p) => [p.rule, p.pointer]), [['unknown-type', '/records/ghost.item/g']]);
});

test('checkRecord does not change the value it is given', () => {
  const validator = createValidator(repoRoot);
  const content = discover(repoRoot, `${FIXTURES}/ok-content`, validator);
  const value = { $schema: '../../../geo/schemas/body.schema.json', $version: 1, size: [2, 2, 2], model: 'assets/box.glb' };
  const before = JSON.stringify(value);
  const { record } = checkRecord(content, validator, { type: 'geo.body', id: 'pack/c', module: 'pack', file: `${FIXTURES}/ok-content/modules/pack/content/geo.body/c.json`, pointer: '', value }, new Set());
  assert.deepEqual(record?.body, { size: [2, 2, 2], model: `${FIXTURES}/ok-content/modules/pack/assets/box.glb` });
  assert.equal(JSON.stringify(value), before);
});
