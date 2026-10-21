// Smoke tests: every game of the repository and of the examples root runs 300 ticks on Node and on Python, and the two results agree (plan.md 4.18).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { load } from '../../../hosts/js/runtime.ts';
import type { Bundle, Game } from '../../../hosts/js/runtime.ts';
import { buildBundle } from '../lib/bundle.ts';
import { gameComposition } from '../lib/composition.ts';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { isObject, jsonEqual, writeJson } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const validator = createValidator(repoRoot);
const TICKS = 300;
const HOSTS = ['node', 'python'];

interface Result { snapshot: Record<string, unknown>; events: Record<string, number> }

function build(root: string, game: string, host: string): Bundle {
  const index = discover(repoRoot, root, validator);
  const info = index.games.get(game)!;
  const built = buildBundle({ index, records: loadRecords(index, validator).records, composition: gameComposition(info), host, game, fixedHz: info.fixedHz, validator });
  assert.deepEqual(built.problems, []);
  assert.ok(built.bundle);
  return built.bundle;
}

const options = {
  root: pathToFileURL(repoRoot + path.sep).href,
  debug: true,
  validate(schema: string, value: unknown): string | null {
    const errors = validator.errors(schema, value);
    return errors.length === 0 ? null : errors.join('; ');
  },
  host: {},
};

// Loads the bundle on the Node runtime and runs it for TICKS ticks with no inputs; the events are what tick() returned, counted by id.
async function playNode(bundle: Bundle): Promise<{ game: Game; result: Result }> {
  const game = await load(bundle, options);
  const events: Record<string, number> = {};
  for (let i = 0; i < TICKS; i++) {
    for (const { event } of game.tick()) events[event] = (events[event] ?? 0) + 1;
  }
  return { game, result: { snapshot: game.snapshot(), events } };
}

// The result hosts/python/play.py prints for the bundle, or null when run.ts found no Python and skipped (with REQUIRE_HOSTS=python it exits 1 instead).
function playPython(bundle: Bundle): Result | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  try {
    const file = path.join(dir, 'bundle.json');
    writeJson(file, bundle as unknown as Json);
    const run = spawnSync(process.execPath, ['hosts/python/run.ts', 'hosts/python/play.py', file, String(TICKS)], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const last = run.stdout.split(/\r?\n/).filter((line) => line !== '').at(-1) ?? '';
    return last === 'SKIPPED python (not found)' ? null : (JSON.parse(last) as Result);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

for (const root of ['.', 'examples']) {
  for (const game of discover(repoRoot, root, validator).games.values()) {
    test(`smoke ${root} ${game.id}`, async (t) => {
      const results: Partial<Record<string, Result>> = {};
      for (const host of HOSTS.filter((h) => game.hosts.includes(h))) {
        await t.test(host, async (t) => {
          const bundle = build(root, game.id, host);
          if (host === 'node') {
            results.node = (await playNode(bundle)).result;
          } else {
            const result = playPython(bundle);
            if (result === null) return t.skip('python not found');
            results.python = result;
          }
        });
      }
      if (results.node && results.python) {
        assert.ok(closeEqual(results.node, results.python), `node and python differ:\n${JSON.stringify(results.node)}\n${JSON.stringify(results.python)}`);
      }
    });
  }
}

test('smoke examples sandbox: the plank lies on the ground, crate_a on the plank and crate_b on crate_a, with three contacts', async () => {
  const { game, result } = await playNode(build('examples', 'sandbox', 'node'));
  const bodies = game.call('physics.bodies') as { id: string; position: number[] }[];
  assert.deepEqual(bodies.map((body) => body.id), ['crate_a', 'crate_b', 'plank']);
  for (const [body, y] of [['plank', 0.25], ['crate_a', 1.0], ['crate_b', 2.0]] as const) {
    const found = bodies.find((b) => b.id === body)!;
    assert.ok(Math.abs(found.position[1] - y) <= 1e-9, `${body} is at y ${found.position[1]}, not ${y}`);
  }
  assert.equal(result.events['physics.contact'], 3);
});

test('smoke examples sandbox: two games loaded in one process, ticked in turn, each end as the single run does', async () => {
  const bundle = build('examples', 'sandbox', 'node');
  const single = (await playNode(bundle)).result.snapshot;
  const a = await load(bundle, options);
  const b = await load(bundle, options);
  for (let i = 0; i < TICKS; i++) {
    a.tick();
    b.tick();
  }
  assert.deepEqual(a.snapshot(), single);
  assert.deepEqual(b.snapshot(), single);
});
