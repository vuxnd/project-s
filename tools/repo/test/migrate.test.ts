// Tests for tools/repo/lib/migrate.ts and tools/repo/commands/migrate.ts: the steps of a type, one record through them, the plan for a root and the command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { run } from '../commands/migrate.ts';
import { checkRecord, loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { walkFiles } from '../lib/fsx.ts';
import { getPointer, isObject, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { Json, JsonObject } from '../lib/json.ts';
import { migrateRecord, migrationSteps, planMigrations } from '../lib/migrate.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const OK = `${FIXTURES}/migrate-ok`;
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ONE = 'modules/pack/content/shapes.box/one.json';
const TRACE = 'modules/shapes/conformance/size.json';
const validator = createValidator(repoRoot);

// A temporary repository that has the real schemas/ folder, a package.json (so its .ts files load as modules) and the given files.
function tempRepo(t: TestContext, files: Record<string, Json | string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRoot, 'schemas'), path.join(dir, 'schemas'), { recursive: true });
  writeText(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(dir, ...file.split('/'));
    if (typeof content === 'string') writeText(abs, content);
    else writeJson(abs, content);
  }
  return dir;
}

// A temporary repository whose root '.' holds the modules of the named fixture roots.
function copyRoot(t: TestContext, ...names: string[]): string {
  const dir = tempRepo(t);
  for (const name of names) fs.cpSync(path.join(repoRoot, ...FIXTURES.split('/'), name, 'modules'), path.join(dir, 'modules'), { recursive: true });
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(walkFiles(dir).map((file) => [file, readText(path.join(dir, ...file.split('/')))]));
}

// A record type schema with the envelope, at the given version, requiring the given properties.
function recordType(version: number, properties: Record<string, Json> = {}): JsonObject {
  return {
    $schema: DRAFT,
    type: 'object',
    additionalProperties: false,
    required: ['$version', ...Object.keys(properties)],
    properties: { $schema: { type: 'string' }, $version: { const: version }, $comment: { type: 'string' }, ...properties },
  };
}

const step = (lines: string): string => `export default function migrate(record: Record<string, unknown>): Record<string, unknown> {\n${lines}\n}\n`;
const ADD_TAGS = step('  return { ...record, tags: [] };');
const RENAME = step('  const { name, ...rest } = record;\n  return { ...rest, label: name };');
const BROKEN = step('  const { name, ...rest } = record;\n  return { ...rest, label: 5 };');

// Module m with the record type item at version 3 (label and tags) and the given step files, by step number.
function itemRepo(t: TestContext, steps: Record<number, string>): string {
  return tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { item: 'schemas/item.schema.json' } },
    'modules/m/schemas/item.schema.json': recordType(3, { label: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }),
    ...Object.fromEntries(Object.entries(steps).map(([n, source]) => [`modules/m/migrations/item/${n}.ts`, source])),
  });
}

test('migrationSteps lists the three files of each step from 2 to the type version, and nothing for versions 1 and 0 or an unknown type', (t) => {
  const dir = `${OK}/modules/shapes/migrations/box`;
  assert.deepEqual(migrationSteps(discover(repoRoot, OK, validator), 'shapes.box'), [{ to: 2, file: `${dir}/2.ts`, before: `${dir}/2.before.json`, after: `${dir}/2.after.json` }]);

  const repo = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { one: 'schemas/one.schema.json', three: 'schemas/three.schema.json', bare: 'schemas/bare.schema.json' } },
    'modules/m/schemas/one.schema.json': recordType(1),
    'modules/m/schemas/three.schema.json': recordType(3),
    'modules/m/schemas/bare.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: {} },
  });
  const index = discover(repo, '.', createValidator(repo));
  assert.deepEqual(migrationSteps(index, 'm.three').map((s) => [s.to, s.file]), [[2, 'modules/m/migrations/three/2.ts'], [3, 'modules/m/migrations/three/3.ts']]);
  assert.deepEqual([migrationSteps(index, 'm.one'), migrationSteps(index, 'm.bare'), migrationSteps(index, 'm.nope')], [[], [], []]);
});

test('migrateRecord turns the 2.before.json sample into a record valid at version 2 with $version first', async () => {
  const index = discover(repoRoot, OK, validator);
  const [first] = migrationSteps(index, 'shapes.box');
  const sample = readJson(path.join(repoRoot, ...first.before.split('/')));
  assert.ok(sample.ok && isObject(sample.value));
  const migrated = await migrateRecord(repoRoot, index, 'shapes.box', sample.value);
  assert.deepEqual(Object.keys(migrated), ['$version', 'halfExtents']);
  assert.deepEqual(migrated, { $version: 2, halfExtents: [1, 2, 3] });
  assert.deepEqual(validator.validate(index.types.get('shapes.box')!.schema, migrated, first.after), []);
});

test('migrateRecord puts $schema, $version and $comment before the body whatever the order of the input, and leaves the input alone', async () => {
  const index = discover(repoRoot, OK, validator);
  const record = { size: [2, 2, 2], $comment: 'by hand', $version: 1, $schema: '../../../shapes/schemas/box.schema.json' };
  const text = JSON.stringify(record);
  assert.deepEqual(Object.keys(await migrateRecord(repoRoot, index, 'shapes.box', record)), ['$schema', '$version', '$comment', 'halfExtents']);
  assert.equal(JSON.stringify(record), text);
});

test('migrateRecord keeps the envelope of the input when a step returns only the body, and a step that edits its argument leaves the input alone', async (t) => {
  const dir = itemRepo(t, { 2: step('  record.tags = [];\n  return record;'), 3: step('  return { label: String(record.name), tags: record.tags };') });
  const index = discover(dir, '.', createValidator(dir));
  const record = { $schema: '../../schemas/item.schema.json', $version: 1, $comment: 'kept', name: 'a' };
  const text = JSON.stringify(record);
  assert.deepEqual(await migrateRecord(dir, index, 'm.item', record), { $schema: '../../schemas/item.schema.json', $version: 3, $comment: 'kept', label: 'a', tags: [] });
  assert.equal(JSON.stringify(record), text);
});

test('migrateRecord applies the steps after the record version up to `to`, and checks the schema only when `to` is the type version', async (t) => {
  const dir = itemRepo(t, { 2: ADD_TAGS, 3: RENAME });
  const index = discover(dir, '.', createValidator(dir));
  const migrate = (record: JsonObject, to?: number): Promise<JsonObject> => migrateRecord(dir, index, 'm.item', record, to);
  assert.deepEqual(await migrate({ $version: 1, name: 'a' }), { $version: 3, tags: [], label: 'a' });
  assert.deepEqual(await migrate({ $version: 1, name: 'a' }, 2), { $version: 2, name: 'a', tags: [] });   // not valid at version 3, and not checked
  assert.deepEqual(await migrate({ $version: 2, name: 'b', tags: ['x'] }), { $version: 3, tags: ['x'], label: 'b' });
  assert.deepEqual(await migrate({ $version: 3, label: 'c', tags: [] }), { $version: 3, label: 'c', tags: [] });
});

const FAILURES: [what: string, steps: Record<number, string>, message: RegExp][] = [
  ['a step that throws', { 2: step("  throw new Error('boom');"), 3: RENAME }, /modules\/m\/migrations\/item\/2\.ts: boom/],
  ['a second step that throws after the first succeeded', { 2: ADD_TAGS, 3: step("  throw new Error('late');") }, /modules\/m\/migrations\/item\/3\.ts: late/],
  ['a step that returns nothing', { 2: step('  void record;'), 3: RENAME }, /modules\/m\/migrations\/item\/2\.ts: returned a value that is not an object/],
  ['a step without a default export', { 2: 'export function migrate() { return {}; }\n', 3: RENAME }, /modules\/m\/migrations\/item\/2\.ts: no default export function/],
  ['a step file that is missing', { 3: RENAME }, /modules\/m\/migrations\/item\/2\.ts: does not exist$/],
  ['a result that fails the type schema', { 2: ADD_TAGS, 3: BROKEN }, /the result does not match modules\/m\/schemas\/item\.schema\.json: \/label: must be string/],
];

for (const [what, steps, message] of FAILURES) {
  test(`migrateRecord rejects with the cause for ${what}`, async (t) => {
    const dir = itemRepo(t, steps);
    const index = discover(dir, '.', createValidator(dir));
    await assert.rejects(migrateRecord(dir, index, 'm.item', { $version: 1, name: 'a' }), message);
  });
}

test('migrateRecord rejects a record without an integer $version and a type that is not declared', async () => {
  const index = discover(repoRoot, OK, validator);
  await assert.rejects(migrateRecord(repoRoot, index, 'shapes.box', { size: [1, 1, 1] }), /no integer \$version/);
  await assert.rejects(migrateRecord(repoRoot, index, 'shapes.box', { $version: '1' }), /no integer \$version/);
  await assert.rejects(migrateRecord(repoRoot, index, 'shapes.ghost', { $version: 1 }), /shapes\.ghost is not a declared record type/);
});

test('planMigrations on migrate-ok lists the content record and the trace, returns the new text of both files and writes nothing', async (t) => {
  const dir = copyRoot(t, 'migrate-ok');
  const before = snapshot(dir);
  const plan = await planMigrations(dir, '.', createValidator(dir));
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.changes, [
    { file: ONE, type: 'shapes.box', id: 'pack/one', from: 1, to: 2 },
    { file: TRACE, type: 'shapes.box', id: 'trace/unit', from: 1, to: 2 },
  ]);
  assert.deepEqual([...plan.files.keys()], [ONE, TRACE]);
  assert.equal(plan.files.get(ONE), '{\n  "$schema": "../../../shapes/schemas/box.schema.json",\n  "$version": 2,\n  "halfExtents": [2, 2, 2]\n}\n');
  assert.equal(plan.files.get(TRACE), before[TRACE].replace('"$version": 1,\n        "size": [2, 4, 6]', '"$version": 2,\n        "halfExtents": [1, 2, 3]'));   // the rest of the trace is as it was
  assert.deepEqual(snapshot(dir), before);

  for (const [file, text] of plan.files) writeText(path.join(dir, ...file.split('/')), text);
  const written = createValidator(dir);
  const index = discover(dir, '.', written);
  const loaded = loadRecords(index, written);
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.records.map((r) => [r.id, r.version, r.body]), [['pack/one', 2, { halfExtents: [2, 2, 2] }]]);
  const trace = readJson(path.join(dir, ...TRACE.split('/')));
  assert.ok(trace.ok);
  const unit = getPointer(trace.value, '/records/shapes.box/unit');
  assert.ok(isObject(unit));
  assert.deepEqual(checkRecord(index, written, { type: 'shapes.box', id: 'trace/unit', module: 'trace', file: TRACE, pointer: '/records/shapes.box/unit', value: unit }, new Set()).problems, []);
  assert.deepEqual(await planMigrations(dir, '.', written), { changes: [], files: new Map(), problems: [] });
});

test('migration-failed gives migration-failed at the record with the cause, and plans no change', async () => {
  const root = `${FIXTURES}/migration-failed`;
  const plan = await planMigrations(repoRoot, root, validator);
  assert.deepEqual([plan.changes, plan.files.size], [[], 0]);
  assert.deepEqual(plan.problems.map((p) => [p.rule, p.severity, p.file, p.pointer]), [['migration-failed', 'error', `${root}/modules/kinds/content/kinds.item/one.json`, '']]);
  assert.ok(plan.problems[0].message.endsWith('2.ts: no rule to rename "bow" to label'), plan.problems[0].message);
});

test('a failed record in a trace is migration-failed at its pointer, the trace is left alone and other files still migrate', async (t) => {
  const dir = tempRepo(t, {
    'modules/c/module.json': { id: 'c', summary: 'x', contract: true, types: { good: 'schemas/good.schema.json', bad: 'schemas/bad.schema.json' } },
    'modules/c/schemas/good.schema.json': recordType(2, { label: { type: 'string' } }),
    'modules/c/schemas/bad.schema.json': recordType(2, { label: { type: 'string' } }),
    'modules/c/migrations/good/2.ts': RENAME,
    'modules/c/migrations/bad/2.ts': BROKEN,
    'modules/c/conformance/t.json': { records: { 'c.good': { gr: { $version: 1, name: 'x' } }, 'c.bad': { br: { $version: 1, name: 'y' } } } },   // the plan reads only the records
    'modules/p/module.json': { id: 'p', summary: 'x', requires: ['c'] },
    'modules/p/content/c.good/g.json': { $version: 1, name: 'g' },
  });
  const plan = await planMigrations(dir, '.', createValidator(dir));
  assert.deepEqual(plan.changes, [{ file: 'modules/p/content/c.good/g.json', type: 'c.good', id: 'p/g', from: 1, to: 2 }]);
  assert.deepEqual([...plan.files.keys()], ['modules/p/content/c.good/g.json']);
  assert.deepEqual(plan.problems.map((p) => [p.rule, p.file, p.pointer]), [['migration-failed', 'modules/c/conformance/t.json', '/records/c.bad/br']]);
  assert.equal(plan.problems[0].message, 'trace/br: the result does not match modules/c/schemas/bad.schema.json: /label: must be string');
});

test('a step result that is not JSON is migration-failed at the record, and planMigrations still returns', async (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { item: 'schemas/item.schema.json' } },
    'modules/m/schemas/item.schema.json': { ...recordType(2, { label: { type: 'string' }, note: { type: 'string' } }), required: ['$version', 'label'] },
    'modules/m/migrations/item/2.ts': step('  const { name, old, ...rest } = record;\n  return { ...rest, label: name, note: old };'),   // note is undefined: the record has no old
    'modules/m/content/m.item/a.json': { $version: 1, name: 'a' },
  });
  const plan = await planMigrations(dir, '.', createValidator(dir));
  assert.deepEqual([plan.changes, plan.files.size], [[], 0]);
  assert.deepEqual(plan.problems.map((p) => [p.rule, p.file, p.pointer]), [['migration-failed', 'modules/m/content/m.item/a.json', '']]);
});

test('records that are current, newer, of a type without a version or without a type, and files that are no records give no change', async (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { item: 'schemas/item.schema.json', plain: 'schemas/plain.schema.json' } },
    'modules/m/schemas/item.schema.json': recordType(2, { label: { type: 'string' } }),
    'modules/m/schemas/plain.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: {} },
    'modules/m/migrations/item/2.ts': RENAME,
    'modules/m/content/m.item/current.json': { $version: 2, label: 'x' },
    'modules/m/content/m.item/newer.json': { $version: 3, label: 'x' },
    'modules/m/content/m.item/text.json': { $version: '1', name: 'x' },
    'modules/m/content/m.item/broken.json': '{\n  "a": \n}\n',
    'modules/m/content/m.item/list.json': [1],
    'modules/m/content/m.item/README.md': 'text\n',
    'modules/m/content/m.item/sub/deep.json': { $version: 1, name: 'x' },
    'modules/m/content/m.plain/x.json': { $version: 1 },
    'modules/m/content/m.ghost/x.json': { $version: 1 },
    'modules/m/content/stray.json': { $version: 1 },
  });
  assert.deepEqual(await planMigrations(dir, '.', createValidator(dir)), { changes: [], files: new Map(), problems: [] });
});

test('planMigrations returns the errors of discover, not its warnings', async () => {
  const missing = await planMigrations(repoRoot, `${FIXTURES}/root-missing`, validator);
  assert.deepEqual(missing.problems.map((p) => [p.rule, p.severity]), [['root-missing', 'error']]);
  assert.deepEqual(await planMigrations(repoRoot, `${FIXTURES}/optional-missing`, validator), { changes: [], files: new Map(), problems: [] });
});

function cli(...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'repo', 'cli.ts'), 'migrate', ...args], { encoding: 'utf8' });
  return { status, stdout, stderr };
}

test('migrate without --write on migrate-ok exits 0, prints both changes and writes nothing', () => {
  const files = [`${OK}/${ONE}`, `${OK}/${TRACE}`].map((file) => path.join(repoRoot, ...file.split('/')));
  const before = files.map((file) => readText(file));
  const r = cli('--root', OK);
  assert.deepEqual([r.status, r.stdout, r.stderr], [
    0,
    `${OK}/${ONE}: shapes.box 1 -> 2\n${OK}/${TRACE}: shapes.box 1 -> 2\nmigrate: 2 files would change; run npm run migrate -- --write\n`,
    '',
  ]);
  assert.deepEqual(files.map((file) => readText(file)), before);
});

test('migrate usage errors exit 2 with a message on stderr: no root, unknown option, positional, missing and outside roots', () => {
  for (const args of [[], ['--write'], ['--bogus', '--root', '.'], ['--root', '.', 'extra'], ['--root']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.notEqual(r.stderr, '', args.join(' '));
  }
  for (const root of ['nowhere', '../x', 'tools/..', '/etc', 'C:/x', 'a\\b']) {
    assert.deepEqual(cli('--root', root), { status: 2, stdout: '', stderr: `no such root: ${root}\n` }, root);
  }
});

// Runs the migrate command in this process against a temporary repository, collecting what it prints.
async function runMigrate(t: TestContext, dir: string, ...args: string[]): Promise<{ status: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (...parts: unknown[]) => { out.push(parts.join(' ')); });
  t.mock.method(console, 'error', (...parts: unknown[]) => { err.push(parts.join(' ')); });
  return { status: await run(args, dir), out, err };
}

test('migrate --write rewrites the files, says how many, and finds nothing to do the second time', async (t) => {
  const dir = copyRoot(t, 'migrate-ok');
  assert.deepEqual(await runMigrate(t, dir, '--write', '--root', '.'), { status: 0, out: ['migrate: rewrote 2 files'], err: [] });
  assert.equal(readText(path.join(dir, ...ONE.split('/'))), '{\n  "$schema": "../../../shapes/schemas/box.schema.json",\n  "$version": 2,\n  "halfExtents": [2, 2, 2]\n}\n');
  assert.deepEqual(await runMigrate(t, dir, '--root', '.'), { status: 0, out: ['migrate: 0 files would change; run npm run migrate -- --write'], err: [] });
});

test('migrate --write writes nothing when a record fails, not even the files that could migrate', async (t) => {
  const dir = copyRoot(t, 'migrate-ok', 'migration-failed');
  const before = snapshot(dir);
  const problem = 'modules/kinds/content/kinds.item/one.json#: kinds/one: modules/kinds/migrations/item/2.ts: no rule to rename "bow" to label [migration-failed]';

  assert.deepEqual(await runMigrate(t, dir, '--write', '--root', '.'), { status: 1, out: [problem], err: [] });
  assert.deepEqual(snapshot(dir), before);

  assert.deepEqual(await runMigrate(t, dir, '--root', '.'), {
    status: 1,
    out: [problem, `${ONE}: shapes.box 1 -> 2`, `${TRACE}: shapes.box 1 -> 2`, 'migrate: 2 files would change; run npm run migrate -- --write'],
    err: [],
  });
});

test('migrate over several roots counts files, not records, and prints the problems of every root sorted', async (t) => {
  const contract = (root: string, migration: string): Record<string, Json | string> => ({
    [`${root}/modules/c/module.json`]: { id: 'c', summary: 'x', contract: true, types: { item: 'schemas/item.schema.json' } },
    [`${root}/modules/c/schemas/item.schema.json`]: recordType(2, { label: { type: 'string' } }),
    [`${root}/modules/c/migrations/item/2.ts`]: migration,
  });
  const dir = tempRepo(t, {
    ...contract('two', RENAME),
    'two/modules/c/conformance/t.json': { records: { 'c.item': { a: { $version: 1, name: 'a' }, b: { $version: 1, name: 'b' } } } },
    ...contract('one', RENAME),
    'one/modules/c/content/c.item/x.json': { $version: 1, name: 'x' },
    ...contract('q', step("  throw new Error('q');")),
    'q/modules/c/content/c.item/x.json': { $version: 1, name: 'x' },
    ...contract('p', step("  throw new Error('p');")),
    'p/modules/c/content/c.item/x.json': { $version: 1, name: 'x' },
  });
  assert.deepEqual(await runMigrate(t, dir, '--root', 'two', '--root', 'one'), {
    status: 0,
    out: ['two/modules/c/conformance/t.json: c.item 1 -> 2', 'two/modules/c/conformance/t.json: c.item 1 -> 2', 'one/modules/c/content/c.item/x.json: c.item 1 -> 2', 'migrate: 2 files would change; run npm run migrate -- --write'],
    err: [],
  });
  const failed = await runMigrate(t, dir, '--root', 'q', '--root', 'p');
  assert.deepEqual([failed.status, failed.out.map((line) => line.replace(/: .* \[/, ' ['))], [1, ['p/modules/c/content/c.item/x.json# [migration-failed]', 'q/modules/c/content/c.item/x.json# [migration-failed]', 'migrate: 0 files would change; run npm run migrate -- --write']]);
  assert.deepEqual(await runMigrate(t, dir, '--write', '--root', 'two', '--root', 'one'), { status: 0, out: ['migrate: rewrote 2 files'], err: [] });
});
