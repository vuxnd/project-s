// Walkthroughs of ARCHITECTURE.md as tests: each applies a change to a temporary copy of schemas/ and examples/ and checks the result (plan.md 4.18).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runTraceBundle } from '../../../hosts/js/conformance.ts';
import { buildBundle } from '../lib/bundle.ts';
import { checkRoot } from '../lib/check.ts';
import { gameComposition } from '../lib/composition.ts';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { isObject, jsonEqual, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { JsonObject } from '../lib/json.ts';
import { migrateRecord, planMigrations } from '../lib/migrate.ts';
import { formatProblem } from '../lib/problems.ts';
import { compileTraces, listTraces } from '../lib/traces.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const temps: string[] = [];

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

// A new temporary directory with copies of the given repo-relative files and folders, and a package.json so that its .ts files load as modules.
function copyToTemp(paths: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  temps.push(dir);
  for (const rel of paths) fs.cpSync(path.join(repoRoot, ...rel.split('/')), path.join(dir, ...rel.split('/')), { recursive: true });
  writeText(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

// Reads the JSON object in dir/rel, lets `edit` change it in place and writes it back with formatJson.
function editJson(dir: string, rel: string, edit: (value: JsonObject) => void): void {
  const file = path.join(dir, ...rel.split('/'));
  const parsed = readJson(file);
  assert.ok(parsed.ok && isObject(parsed.value), `${rel} must hold a JSON object`);
  edit(parsed.value);
  writeJson(file, parsed.value);
}

// The distinct rule ids of the problems of one severity that checkRoot reports for dir/root, sorted.
function rules(dir: string, root: string, severity: 'error' | 'warning'): string[] {
  const problems = checkRoot(dir, root, createValidator(dir), { generated: false });
  return [...new Set(problems.filter((p) => p.severity === severity).map((p) => p.rule))].sort();
}

function errorRules(dir: string, root: string): string[] {
  return rules(dir, root, 'error');
}

function warningRules(dir: string, root: string): string[] {
  return rules(dir, root, 'warning');
}

// The traces of one contract compiled in memory for one host, and one line for every error in listing and compiling them.
function compileContract(dir: string, root: string, contract: string, host: string) {
  const validator = createValidator(dir);
  const index = discover(dir, root, validator);
  const listed = listTraces(index, validator);
  const own = `${index.modules.get(contract)!.dir}/conformance/`;
  const compiled = compileTraces(index, loadRecords(index, validator).records, listed.traces.filter((trace) => trace.contract === contract), [host], validator);
  const errors = [...listed.problems.filter((p) => p.file.startsWith(own)), ...compiled.problems].filter((p) => p.severity === 'error').map(formatProblem);
  return { bundles: compiled.bundles, errors };
}

// Runs every trace of the contract on every implementation in the root; returns the lines of what failed, or [] when all pass.
async function runContractTraces(dir: string, root: string, contract: string, host: 'node'): Promise<string[]> {
  const { bundles, errors } = compileContract(dir, root, contract, host);
  const failures = [...errors];
  for (const { path: file, value } of bundles) {
    const result = await runTraceBundle(file, value, dir);
    if (!result.ok) failures.push(...result.lines);
  }
  return failures;
}

function buildGame(dir: string, root: string, game: string, host: string) {
  const validator = createValidator(dir);
  const index = discover(dir, root, validator);
  const info = index.games.get(game)!;
  return buildBundle({ index, records: loadRecords(index, validator).records, composition: gameComposition(info), host, game, fixedHz: info.fixedHz, validator });
}

test('walkthrough (b) replace physics', async () => {
  const dir = copyToTemp(['schemas', 'examples']);
  const modules = path.join(dir, 'examples', 'modules');
  fs.cpSync(path.join(modules, 'physics_basic'), path.join(modules, 'physics_alt'), { recursive: true });
  editJson(dir, 'examples/modules/physics_alt/module.json', (manifest) => {
    manifest.id = 'physics_alt';
  });
  editJson(dir, 'examples/games/sandbox/game.json', (game) => {
    game.modules = Object.fromEntries(Object.entries(game.modules as JsonObject).map(([id, entry]) => [id === 'physics_basic' ? 'physics_alt' : id, entry]));
  });

  assert.deepEqual(errorRules(dir, 'examples'), []);
  assert.deepEqual(warningRules(dir, 'examples'), []);
  const implementations = compileContract(dir, 'examples', 'physics', 'node').bundles.map((b) => b.value.implementation);
  assert.deepEqual([...new Set(implementations)].sort(), ['physics_alt', 'physics_basic']);
  assert.deepEqual(await runContractTraces(dir, 'examples', 'physics', 'node'), []);

  const built = buildGame(dir, 'examples', 'sandbox', 'node');
  assert.deepEqual(built.problems, []);
  assert.equal(built.bundle!.contracts.physics, 'physics_alt');
});

// physics.body at version 2 stores halfExtents where version 1 stored size.
const MIGRATE_2 = `\
export default function migrate(record: Record<string, unknown>): Record<string, unknown> {
  const { size, ...rest } = record as { size: number[] };
  return { ...rest, halfExtents: size.map((v) => v / 2) };
}
`;
const SIZE_READER = '[...records[spawn.body].size]';
const HALF_EXTENTS_READER = 'records[spawn.body].halfExtents.map((half) => half * 2)';   // the TS reader only: this walkthrough runs the node host

test('walkthrough (e) bump physics.body', async () => {
  const dir = copyToTemp(['schemas', 'examples']);
  editJson(dir, 'examples/modules/physics/schemas/body.schema.json', (schema) => {
    const properties = schema.properties as JsonObject;
    (properties.$version as JsonObject).const = 2;
    schema.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => (key === 'size' ? ['halfExtents', { ...(value as JsonObject), description: 'Half extents.' }] : [key, value])));
    schema.required = (schema.required as string[]).map((key) => (key === 'size' ? 'halfExtents' : key));
  });
  const steps = path.join(dir, 'examples', 'modules', 'physics', 'migrations', 'body');
  writeText(path.join(steps, '2.ts'), MIGRATE_2);
  writeJson(path.join(steps, '2.before.json'), { $version: 1, size: [2, 2, 2], mass: 1 });
  writeJson(path.join(steps, '2.after.json'), { $version: 2, mass: 1, halfExtents: [1, 1, 1] });
  const reader = path.join(dir, 'examples', 'modules', 'physics_basic', 'ts', 'index.ts');
  const source = readText(reader);
  assert.ok(source.includes(SIZE_READER), `${SIZE_READER} is not in physics_basic/ts/index.ts`);
  writeText(reader, source.replace(SIZE_READER, HALF_EXTENTS_READER));

  assert.deepEqual(errorRules(dir, 'examples'), ['outdated-record']);
  const plan = await planMigrations(dir, 'examples', createValidator(dir));
  assert.deepEqual(plan.problems, []);
  assert.deepEqual([...plan.files.keys()], [
    'examples/modules/physics/conformance/fall.json',
    'examples/modules/physics/conformance/rest.json',
    'examples/modules/sandbox_rules/content/physics.body/crate.json',
    'examples/modules/sandbox_rules/content/physics.body/plank.json',
  ]);
  for (const [file, text] of plan.files) writeText(path.join(dir, ...file.split('/')), text);

  assert.deepEqual(errorRules(dir, 'examples'), []);
  assert.deepEqual(await runContractTraces(dir, 'examples', 'physics', 'node'), []);
  const before = readJson(path.join(steps, '2.before.json'));
  const after = readJson(path.join(steps, '2.after.json'));
  assert.ok(before.ok && isObject(before.value) && after.ok);
  const migrated = await migrateRecord(dir, discover(dir, 'examples', createValidator(dir)), 'physics.body', before.value);
  assert.ok(jsonEqual(migrated, after.value), `${JSON.stringify(migrated)} is not ${JSON.stringify(after.value)}`);
});
