// Extension walkthroughs as tests: each applies a change to a temporary copy of schemas/ and the frozen sandbox root and checks the result (plan.md 4.18).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runTraceBundle } from '../../../hosts/js/conformance.ts';
import { load } from '../../../hosts/js/runtime.ts';
import { buildBundle } from '../lib/bundle.ts';
import { checkRoot } from '../lib/check.ts';
import { gameComposition } from '../lib/composition.ts';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { writeGenerated } from '../lib/gen.ts';
import { isObject, jsonEqual, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { Json, JsonObject } from '../lib/json.ts';
import { migrateRecord, planMigrations } from '../lib/migrate.ts';
import { formatProblem } from '../lib/problems.ts';
import { compileTraces, listTraces } from '../lib/traces.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const SANDBOX = 'tools/repo/test/fixtures/roots/sandbox';
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
  const dir = copyToTemp(['schemas', SANDBOX]);
  const modules = path.join(dir, ...SANDBOX.split('/'), 'modules');
  fs.cpSync(path.join(modules, 'physics_basic'), path.join(modules, 'physics_alt'), { recursive: true });
  editJson(dir, `${SANDBOX}/modules/physics_alt/module.json`, (manifest) => {
    manifest.id = 'physics_alt';
  });
  editJson(dir, `${SANDBOX}/games/sandbox/game.json`, (game) => {
    game.modules = Object.fromEntries(Object.entries(game.modules as JsonObject).map(([id, entry]) => [id === 'physics_basic' ? 'physics_alt' : id, entry]));
  });

  assert.deepEqual(errorRules(dir, SANDBOX), []);
  assert.deepEqual(warningRules(dir, SANDBOX), []);
  const implementations = compileContract(dir, SANDBOX, 'physics', 'node').bundles.map((b) => b.value.implementation);
  assert.deepEqual([...new Set(implementations)].sort(), ['physics_alt', 'physics_basic']);
  assert.deepEqual(await runContractTraces(dir, SANDBOX, 'physics', 'node'), []);

  const built = buildGame(dir, SANDBOX, 'sandbox', 'node');
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
  const dir = copyToTemp(['schemas', SANDBOX]);
  editJson(dir, `${SANDBOX}/modules/physics/schemas/body.schema.json`, (schema) => {
    const properties = schema.properties as JsonObject;
    (properties.$version as JsonObject).const = 2;
    schema.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => (key === 'size' ? ['halfExtents', { ...(value as JsonObject), description: 'Half extents.' }] : [key, value])));
    schema.required = (schema.required as string[]).map((key) => (key === 'size' ? 'halfExtents' : key));
  });
  const steps = path.join(dir, ...SANDBOX.split('/'), 'modules', 'physics', 'migrations', 'body');
  writeText(path.join(steps, '2.ts'), MIGRATE_2);
  writeJson(path.join(steps, '2.before.json'), { $version: 1, size: [2, 2, 2], mass: 1 });
  writeJson(path.join(steps, '2.after.json'), { $version: 2, mass: 1, halfExtents: [1, 1, 1] });
  const reader = path.join(dir, ...SANDBOX.split('/'), 'modules', 'physics_basic', 'ts', 'index.ts');
  const source = readText(reader);
  assert.ok(source.includes(SIZE_READER), `${SIZE_READER} is not in physics_basic/ts/index.ts`);
  writeText(reader, source.replace(SIZE_READER, HALF_EXTENTS_READER));

  assert.deepEqual(errorRules(dir, SANDBOX), ['outdated-record']);
  const plan = await planMigrations(dir, SANDBOX, createValidator(dir));
  assert.deepEqual(plan.problems, []);
  assert.deepEqual([...plan.files.keys()], [
    `${SANDBOX}/modules/physics/conformance/fall.json`,
    `${SANDBOX}/modules/physics/conformance/rest.json`,
    `${SANDBOX}/modules/sandbox_rules/content/physics.body/crate.json`,
    `${SANDBOX}/modules/sandbox_rules/content/physics.body/plank.json`,
  ]);
  for (const [file, text] of plan.files) writeText(path.join(dir, ...file.split('/')), text);

  assert.deepEqual(errorRules(dir, SANDBOX), []);
  assert.deepEqual(await runContractTraces(dir, SANDBOX, 'physics', 'node'), []);
  const before = readJson(path.join(steps, '2.before.json'));
  const after = readJson(path.join(steps, '2.after.json'));
  assert.ok(before.ok && isObject(before.value) && after.ok);
  const migrated = await migrateRecord(dir, discover(dir, SANDBOX, createValidator(dir)), 'physics.body', before.value);
  assert.ok(jsonEqual(migrated, after.value), `${JSON.stringify(migrated)} is not ${JSON.stringify(after.value)}`);
});

// Writes the files below <sandbox root>/modules/<id>/ of dir: a string as the text it is, anything else as JSON.
function addModule(dir: string, id: string, files: Record<string, string | JsonObject>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...SANDBOX.split('/'), 'modules', id, ...rel.split('/'));
    if (typeof content === 'string') writeText(file, content);
    else writeJson(file, content);
  }
}

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const TICKS = 300;

// health: a body has the hp of the health/default record; each physics.contact costs it one, and at zero it has died (health.died). sandbox lists python too, so python/health.py repeats the algorithm (D33).
const HEALTH_TS = `\
// health on JavaScript hosts: a physics.contact costs its body one hit point, and at zero the body has died.
import type { Ctx, Profile, State, physics } from '../types.gen.ts';

export function init(): State {
  return { hp: {} };
}

export function damage(ctx: Ctx): void {
  const start = ctx.records<Profile>('health.profile')['health/default'].hp;
  for (const contact of ctx.events<physics.ContactEvent>('physics.contact')) {
    const left = (ctx.state.hp[contact.id] ?? start) - 1;
    ctx.state.hp[contact.id] = left;
    if (left === 0) ctx.emit('health.died', { id: contact.id });
  }
}
`;
const HEALTH_PY = `\
"""health on Python hosts: hit points that physics.contact events use up."""
from typing import Any


def init(ctx: Any) -> dict[str, Any]:
    """Return the initial state: no hit points recorded yet."""
    return {'hp': {}}


def damage(ctx: Any) -> None:
    """Take one hit point for each physics.contact; emit health.died at zero."""
    start = ctx.records('health.profile')['health/default']['hp']
    hp = ctx.state['hp']
    for contact in ctx.events('physics.contact'):
        left = hp.get(contact['id'], start) - 1
        hp[contact['id']] = left
        if left == 0:
            ctx.emit('health.died', {'id': contact['id']})
`;

// Like jsonEqual, but two numbers are equal when they differ by at most 1e-9.
function closeEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => closeEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && closeEqual(a[key], b[key]));
  }
  return jsonEqual(a, b);
}

test('walkthrough (a) add a feature', async (t) => {
  const dir = copyToTemp(['schemas', SANDBOX]);
  addModule(dir, 'health', {
    'module.json': {
      $schema: '../../../../../../../../schemas/module.schema.json',
      id: 'health',
      summary: 'Gives bodies hit points: a physics.contact costs one, and at zero health.died is emitted.',
      requires: ['physics'],
      types: { profile: 'schemas/profile.schema.json' },
      events: { died: 'schemas/died.schema.json' },
      state: 'schemas/state.schema.json',
      systems: [{ name: 'damage', loop: 'fixed', after: ['physics'] }],
      hosts: { node: 'ts/index.ts', web: 'ts/index.ts', python: 'python/health.py' },
    },
    'schemas/profile.schema.json': {
      $schema: DRAFT,
      title: 'Profile',
      description: 'The hit points a body starts with.',
      type: 'object',
      additionalProperties: false,
      required: ['$version', 'hp'],
      properties: {
        $schema: { type: 'string' },
        $version: { const: 1 },
        $comment: { type: 'string' },
        hp: { type: 'integer', minimum: 1 },
      },
    },
    'schemas/died.schema.json': {
      $schema: DRAFT,
      title: 'Died',
      description: 'A body lost its last hit point.',
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    'schemas/state.schema.json': {
      $schema: DRAFT,
      title: 'State',
      type: 'object',
      additionalProperties: false,
      required: ['hp'],
      properties: {
        hp: { description: 'Hit points left per body id, for the bodies that had a contact.', type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'integer' } },
      },
    },
    'content/health.profile/default.json': { $schema: '../../schemas/profile.schema.json', $version: 1, hp: 1 },
    'ts/index.ts': HEALTH_TS,
    'python/health.py': HEALTH_PY,
  });
  editJson(dir, `${SANDBOX}/games/sandbox/game.json`, (game) => {
    (game.modules as JsonObject).health = {};
  });
  assert.deepEqual(errorRules(dir, SANDBOX), []);

  const validator = createValidator(dir);
  const built = buildGame(dir, SANDBOX, 'sandbox', 'node');
  assert.deepEqual(built.problems, []);
  const game = await load(built.bundle!, {
    root: pathToFileURL(dir + path.sep).href,
    debug: true,
    validate: (schema, value) => {
      const errors = validator.errors(schema, value);
      return errors.length === 0 ? null : errors.join('; ');
    },
    host: {},
  });
  const events: Record<string, number> = {};
  for (let i = 0; i < TICKS; i++) {
    for (const { event } of game.tick()) events[event] = (events[event] ?? 0) + 1;
  }
  assert.equal(events['health.died'], 3);
  const nodeResult = { snapshot: game.snapshot(), events };

  // 300 ticks pass every contact, so this runs health.py's damage and its died events; play.py loads the entries from its working directory, the copy.
  await t.test('python ends where node does', (t) => {
    const builtPython = buildGame(dir, SANDBOX, 'sandbox', 'python');
    assert.deepEqual(builtPython.problems, []);
    const file = path.join(dir, 'python.bundle.json');
    writeJson(file, builtPython.bundle as unknown as Json);
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'hosts', 'python', 'run.ts'), path.join(repoRoot, 'hosts', 'python', 'play.py'), file, String(TICKS)], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const last = run.stdout.split(/\r?\n/).filter((line) => line !== '').at(-1) ?? '';
    if (last === 'SKIPPED python (not found)') return t.skip('python not found');
    const pythonResult = JSON.parse(last);
    assert.ok(closeEqual(nodeResult, pythonResult), `node and python differ:\n${JSON.stringify(nodeResult)}\n${last}`);
  });
});

// stats counts fixed ticks, and the ones in which the optional audio module is present.
const STATS_TS = `\
// stats on JavaScript hosts: counts the fixed ticks, and the ones in which the optional audio module is present.
import type { Ctx, State } from '../types.gen.ts';

export function init(): State {
  return { ticks: 0, withAudio: 0 };
}

export function count(ctx: Ctx): void {
  ctx.state.ticks += 1;
  if (ctx.has('audio')) ctx.state.withAudio += 1;
}
`;

test('walkthrough (c) remove audio', () => {
  const dir = copyToTemp(['schemas', SANDBOX]);
  addModule(dir, 'stats', {
    'module.json': {
      $schema: '../../../../../../../../schemas/module.schema.json',
      id: 'stats',
      summary: 'Counts the fixed ticks, and the ones in which the optional audio module is present.',
      optional: ['audio'],
      state: 'schemas/state.schema.json',
      systems: [{ name: 'count', loop: 'fixed', after: ['audio'] }],
      hosts: { node: 'ts/index.ts' },
    },
    'schemas/state.schema.json': {
      $schema: DRAFT,
      title: 'State',
      type: 'object',
      additionalProperties: false,
      required: ['ticks', 'withAudio'],
      properties: { ticks: { type: 'integer' }, withAudio: { type: 'integer' } },
    },
    'ts/index.ts': STATS_TS,
  });
  const editSandbox = (edit: (modules: JsonObject) => void): void => editJson(dir, `${SANDBOX}/games/sandbox/game.json`, (game) => edit(game.modules as JsonObject));
  editSandbox((modules) => {
    modules.stats = { hosts: ['node'] };
  });
  const generate = () => writeGenerated(discover(dir, SANDBOX, createValidator(dir)));
  assert.deepEqual(generate(), { written: [`${SANDBOX}/modules/stats/types.gen.ts`], problems: [] });

  // Removing audio changes nothing in stats, which lists it as optional (D35, D60).
  fs.rmSync(path.join(dir, ...SANDBOX.split('/'), 'modules', 'audio'), { recursive: true });
  editSandbox((modules) => {
    delete modules.audio;
  });

  const problems = checkRoot(dir, SANDBOX, createValidator(dir), { generated: true });
  assert.deepEqual(problems.filter((p) => p.severity === 'error').map(formatProblem), []);
  assert.deepEqual([...new Set(problems.filter((p) => p.severity === 'warning').map((p) => p.rule))], ['unknown-module']);
  assert.deepEqual(generate(), { written: [], problems: [] });
  const built = buildGame(dir, SANDBOX, 'sandbox', 'node');
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.bundle!.modules.find((m) => m.id === 'stats')?.absent, ['audio']);

  editSandbox((modules) => {
    delete modules.physics_basic;
  });
  assert.deepEqual(errorRules(dir, SANDBOX), ['no-provider']);
});
