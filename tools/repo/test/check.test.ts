// Tests for tools/repo/lib/check.ts: every fixture root through checkRoot against its expect.json, and every checker wired into one root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkRoot } from '../lib/check.ts';
import { listDirs } from '../lib/fsx.ts';
import { isObject, readJson, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { formatProblem, sortProblems } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { RULES } from '../lib/rules.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const validator = createValidator(repoRoot);
const ROOTS = listDirs(path.join(repoRoot, ...FIXTURES.split('/')));

function ruleIds(problems: readonly Problem[], severity: 'error' | 'warning'): string[] {
  return [...new Set(problems.filter((p) => p.severity === severity).map((p) => p.rule))].sort();
}

function expectOf(name: string): { errors: string[]; warnings: string[]; generated: boolean } {
  const parsed = readJson(path.join(repoRoot, ...FIXTURES.split('/'), name, 'expect.json'));
  assert.ok(parsed.ok && isObject(parsed.value), `${name} needs an expect.json`);
  const { errors, warnings, generated } = parsed.value;
  return { errors: [...(errors as string[])].sort(), warnings: [...((warnings ?? []) as string[])].sort(), generated: generated === true };
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
  test(`fixture root ${name} reports exactly the rule ids of its expect.json through checkRoot`, () => {
    const expected = expectOf(name);
    const problems = checkRoot(repoRoot, `${FIXTURES}/${name}`, validator, { generated: expected.generated });
    const shown = problems.map(formatProblem).join('\n');
    assert.deepEqual(ruleIds(problems, 'error'), expected.errors, shown);
    assert.deepEqual(ruleIds(problems, 'warning'), expected.warnings, shown);
  });
}

test('every rule id except game-host and migration-failed appears in some expect.json, and every listed id is a rule', () => {
  const listed = new Set(ROOTS.flatMap((name) => [...expectOf(name).errors, ...expectOf(name).warnings]));
  assert.deepEqual(Object.keys(RULES).filter((rule) => !listed.has(rule) && rule !== 'game-host' && rule !== 'migration-failed'), []);
  assert.deepEqual([...listed].filter((rule) => !Object.hasOwn(RULES, rule)), []);
});

test('the repository root itself checks clean', () => {
  assert.deepEqual(checkRoot(repoRoot, '.', validator).map(formatProblem), []);
});

test('generated: false leaves out gen-stale; the default and true include it', () => {
  const root = `${FIXTURES}/gen-stale`;
  assert.deepEqual(where(checkRoot(repoRoot, root, validator)), [`gen-stale ${root}/modules/a/types.gen.ts#`]);
  assert.deepEqual(where(checkRoot(repoRoot, root, validator, { generated: true })), [`gen-stale ${root}/modules/a/types.gen.ts#`]);
  assert.deepEqual(checkRoot(repoRoot, root, validator, { generated: false }), []);
});

test('a root without a modules folder gives the one root-missing problem and nothing else', () => {
  const root = `${FIXTURES}/root-missing`;
  assert.deepEqual(checkRoot(repoRoot, root, validator).map((p) => [p.rule, p.severity, p.file, p.pointer]), [['root-missing', 'error', root, '']]);
});

test('the problems come back sorted and without duplicates', () => {
  for (const name of ['ok-content', 'schema-path', 'asset-missing', 'unknown-ref']) {
    const problems = checkRoot(repoRoot, `${FIXTURES}/${name}`, validator);
    assert.ok(problems.length > 0, name);
    assert.deepEqual(problems, sortProblems(problems), name);
  }
});

test('discover, schemas, records, migrations, config defaults, bundles, imports and traces all report through one call', (t) => {
  const dir = tempRepo(t, {
    'modules/api/module.json': {
      id: 'api',
      summary: 'x',
      contract: true,
      types: { item: 'schemas/item.schema.json' },
      events: { ping: 'schemas/ping.schema.json' },
      operations: { go: {} },
      config: { schema: 'schemas/config.schema.json', defaults: { speed: 'fast' } },
    },
    'modules/api/schemas/item.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['$version'],
      properties: { $schema: { type: 'string' }, $version: { const: 2 }, $comment: { type: 'string' } },
    },
    'modules/api/schemas/ping.schema.json': { $schema: DRAFT, anyOf: [{ type: 'string' }] },
    'modules/api/schemas/config.schema.json': {
      $schema: DRAFT, type: 'object', additionalProperties: false, required: ['speed'], properties: { speed: { type: 'integer' } },
    },
    'modules/api/conformance/t.json': { summary: 'x', fixedHz: 60, ticks: 1, expect: [{ at: 1, call: 'api.nothing', equals: 0 }] },
    'modules/impl/module.json': { id: 'impl', summary: 'x', implements: ['api'], hosts: { node: 'ts/index.ts' } },
    'modules/impl/ts/index.ts': "import pad from 'left-pad';\n",
    'modules/pack/module.json': { id: 'pack', summary: 'x' },
    'modules/pack/content/ghost.thing/one.json': { $version: 1 },
    'games/demo/game.json': { id: 'demo', summary: 'x', hosts: ['node', 'python'], fixedHz: 60, modules: { impl: {} } },
  });
  assert.deepEqual(where(checkRoot(dir, '.', createValidator(dir), { generated: false })), [
    'bad-config games/demo/game.json#/modules/api/config',
    'bad-config modules/api/conformance/t.json#/config/api',
    'bad-config modules/api/module.json#/config/defaults',
    'migration-missing modules/api/schemas/item.schema.json#/properties/$version/const',
    'no-host-entry modules/impl/module.json#/hosts',
    'profile modules/api/schemas/ping.schema.json#',
    'trace-unknown modules/api/conformance/t.json#/expect/0/call',
    'undeclared-package modules/impl/ts/index.ts#',
    'unknown-type modules/pack/content/ghost.thing/one.json#',
  ]);
});
