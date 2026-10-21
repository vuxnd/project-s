// Tests that every <N>.before.json sample of the repository, its example and probe roots and migrate-ok migrates to its <N>.after.json (D36).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { discover } from '../lib/discover.ts';
import type { RootIndex } from '../lib/discover.ts';
import { toPosix } from '../lib/fsx.ts';
import { isObject, jsonEqual, readJson } from '../lib/json.ts';
import type { JsonObject } from '../lib/json.ts';
import { migrateRecord } from '../lib/migrate.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const MIGRATE_OK = 'tools/repo/test/fixtures/roots/migrate-ok';
const PATTERNS = [
  'modules/*/migrations/*/*.before.json',
  'examples/modules/*/migrations/*/*.before.json',
  'hosts/conformance/modules/*/migrations/*/*.before.json',
  `${MIGRATE_OK}/modules/*/migrations/*/*.before.json`,
];
const SAMPLE = /^(?:(.+)\/)?modules\/([^/]+)\/migrations\/([^/]+)\/(\d+)\.before\.json$/;   // root (absent for '.'), module, type name, step

const validator = createValidator(repoRoot);
const indexes = new Map<string, RootIndex>();
const samples = fs.globSync(PATTERNS, { cwd: repoRoot }).map(toPosix).sort();

function readObject(file: string): JsonObject {
  const parsed = readJson(path.join(repoRoot, ...file.split('/')));
  assert.ok(parsed.ok && isObject(parsed.value), `${file} must hold a JSON object`);
  return parsed.value;
}

test('the search for samples finds the step of migrate-ok', () => {
  assert.ok(samples.includes(`${MIGRATE_OK}/modules/shapes/migrations/box/2.before.json`), samples.join('\n'));
});

for (const sample of samples) {
  test(`${sample} migrates to its after sample`, async () => {
    const match = SAMPLE.exec(sample);
    assert.ok(match, sample);
    const [, root = '.', moduleId, typeName, step] = match;
    const n = Number(step);
    const index = indexes.get(root) ?? discover(repoRoot, root, validator);
    indexes.set(root, index);
    const type = index.types.get(`${moduleId}.${typeName}`);
    assert.ok(type, `${moduleId}.${typeName} is not a declared record type of ${root}`);

    const before = readObject(sample);
    assert.equal(before.$version, n - 1, `${sample} must hold a version ${n - 1} record`);
    const migrated = await migrateRecord(repoRoot, index, type.id, before, n);
    const after = readObject(sample.replace('.before.', '.after.'));
    assert.ok(jsonEqual(migrated, after), `${JSON.stringify(migrated)} is not ${JSON.stringify(after)}`);
    if (n === type.version) assert.deepEqual(validator.validate(type.schema, migrated, sample), []);
  });
}
