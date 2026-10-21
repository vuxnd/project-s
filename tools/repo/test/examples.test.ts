// Bundle tests: every game of the repository, of the examples root and of the frozen sandbox root builds the same bytes twice and validates; the repository and the sandbox root are also pinned by snapshot (plan.md 4.18).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { buildBundle, bundlePath } from '../lib/bundle.ts';
import { gameComposition } from '../lib/composition.ts';
import { loadRecords } from '../lib/content.ts';
import { discover } from '../lib/discover.ts';
import { formatJson } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const validator = createValidator(repoRoot);
const SNAPSHOT_ROOTS = ['.', 'tools/repo/test/fixtures/roots/sandbox'];

// Builds the bundle of one game for one host from the files, with nothing carried over from an earlier build.
function build(root: string, game: string, host: string) {
  const index = discover(repoRoot, root, validator);
  const info = index.games.get(game)!;
  const built = buildBundle({ index, records: loadRecords(index, validator).records, composition: gameComposition(info), host, game, fixedHz: info.fixedHz, validator });
  assert.deepEqual(built.problems, []);
  assert.ok(built.bundle);
  return built.bundle;
}

for (const root of [...SNAPSHOT_ROOTS, 'examples']) {
  for (const game of discover(repoRoot, root, validator).games.values()) {
    for (const host of game.hosts) {
      test(`bundle ${root} ${game.id} ${host}`, (t) => {
        const bundle = build(root, game.id, host);
        const text = formatJson(bundle as unknown as Json);
        assert.equal(formatJson(build(root, game.id, host) as unknown as Json), text);
        assert.deepEqual(validator.validate('schemas/bundle.schema.json', bundle, bundlePath(root, game.id, host)), []);
        if (SNAPSHOT_ROOTS.includes(root)) t.assert.snapshot(text, { serializers: [String] });   // the JSON as lines, so a review sees which line changed
      });
    }
  }
}
