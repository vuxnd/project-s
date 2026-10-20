// Tests for tools/repo/lib/validate.ts: schema files linked by relative $ref, error messages and schema-load failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { createValidator, SCHEMA_BASE } from '../lib/validate.ts';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const vec: Json = {
  $schema: DRAFT,
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  $defs: { unit: { type: 'string', pattern: '^[a-z]+$' } },
};

const thing: Json = {
  $schema: DRAFT,
  type: 'object',
  additionalProperties: false,
  required: ['size'],
  properties: {
    size: { $ref: 'vec.schema.json' },
    unit: { $ref: 'vec.schema.json#/$defs/unit', 'x-unit': 'm' },
    model: { type: 'string', 'x-asset': ['glb'] },
    parent: { type: 'string', 'x-ref': 'thing.thing' },
    kind: { type: 'string', enum: ['a', 'b'] },
    version: { const: 1 },
  },
};

const validThing = { size: [1, 2], unit: 'm', model: 'a.glb', parent: 'x/y', kind: 'a', version: 1 };

// A temporary repository root holding the given schema files (repo-relative path -> schema).
function tempRoot(t: TestContext, schemas: Record<string, Json>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, schema] of Object.entries(schemas)) writeJson(path.join(dir, ...file.split('/')), schema);
  return dir;
}

function linked(t: TestContext): string {
  return tempRoot(t, { 'schemas/vec.schema.json': vec, 'schemas/thing.schema.json': thing });
}

test('the schema base is the reserved repo.invalid origin', () => {
  assert.equal(SCHEMA_BASE, 'https://repo.invalid/');
});

test('two files linked by a relative $ref, with x-ref, x-asset and x-unit, load with no problems', (t) => {
  const validator = createValidator(linked(t));
  assert.deepEqual(validator.load('schemas/thing.schema.json'), []);
  assert.deepEqual(validator.load('schemas/vec.schema.json'), []);
});

test('a valid value gives no problems', (t) => {
  assert.deepEqual(createValidator(linked(t)).validate('schemas/thing.schema.json', validThing, 'case.json'), []);
});

test('an invalid value gives one schema problem per Ajv error, with pointer and extra text', (t) => {
  const validator = createValidator(linked(t));
  const problems = validator.validate('schemas/thing.schema.json', { size: [1], unit: 'M', extra: true, kind: 'z', version: 2 }, 'case.json');
  assert.ok(problems.every((p) => p.rule === 'schema' && p.severity === 'error' && p.file === 'case.json'));
  assert.deepEqual(problems.map((p) => p.pointer).sort(), ['', '/kind', '/size', '/unit', '/version']);
  const byPointer = new Map(problems.map((p) => [p.pointer, p.message]));
  assert.ok(byPointer.get('')?.endsWith('(unknown property "extra")'), byPointer.get(''));
  assert.ok(byPointer.get('/kind')?.endsWith('(one of: a, b)'), byPointer.get('/kind'));
  assert.ok(byPointer.get('/version')?.endsWith('(expected 1)'), byPointer.get('/version'));
  assert.match(byPointer.get('/size') ?? '', /fewer than 2 items/);
  assert.match(byPointer.get('/unit') ?? '', /pattern/);
});

test('a missing required property is reported at the object', (t) => {
  const problems = createValidator(linked(t)).validate('schemas/thing.schema.json', {}, 'case.json');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].pointer, '');
  assert.match(problems[0].message, /required property 'size'/);
});

test('basePointer is put in front of every pointer', (t) => {
  const problems = createValidator(linked(t)).validate('schemas/thing.schema.json', { size: [1], kind: 'z' }, 'case.json', '/records/0');
  assert.deepEqual(problems.map((p) => p.pointer).sort(), ['/records/0/kind', '/records/0/size']);
});

test('a #/$defs fragment of a schema file can be loaded and validated against', (t) => {
  const validator = createValidator(linked(t));
  assert.deepEqual(validator.load('schemas/vec.schema.json#/$defs/unit'), []);
  assert.deepEqual(validator.validate('schemas/vec.schema.json#/$defs/unit', 'abc', 'case.json'), []);
  const problems = validator.validate('schemas/vec.schema.json#/$defs/unit', 'ABC', 'case.json');
  assert.deepEqual(problems.map((p) => [p.rule, p.pointer]), [['schema', '']]);
});

test('a missing schema file is a schema-load problem at that file', (t) => {
  const validator = createValidator(linked(t));
  for (const problems of [validator.load('schemas/nope.schema.json'), validator.validate('schemas/nope.schema.json', {}, 'case.json')]) {
    assert.equal(problems.length, 1);
    assert.deepEqual([problems[0].rule, problems[0].file, problems[0].pointer, problems[0].severity], ['schema-load', 'schemas/nope.schema.json', '', 'error']);
  }
});

test('a missing #/$defs fragment is a schema-load problem at the file', (t) => {
  const problems = createValidator(linked(t)).load('schemas/vec.schema.json#/$defs/missing');
  assert.equal(problems.length, 1);
  assert.deepEqual([problems[0].rule, problems[0].file, problems[0].pointer], ['schema-load', 'schemas/vec.schema.json', '']);
});

test('a $ref to a missing file or to a missing fragment is a schema-load problem at the referring file', (t) => {
  const root = tempRoot(t, {
    'schemas/vec.schema.json': vec,
    'schemas/gone.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { a: { $ref: 'nope.schema.json' } } },
    'schemas/hole.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { a: { $ref: 'vec.schema.json#/$defs/missing' } } },
  });
  const validator = createValidator(root);
  const gone = validator.load('schemas/gone.schema.json');
  assert.deepEqual(gone.map((p) => [p.rule, p.file]), [['schema-load', 'schemas/gone.schema.json']]);
  assert.match(gone[0].message, /nope\.schema\.json/);
  const hole = validator.load('schemas/hole.schema.json');
  assert.deepEqual(hole.map((p) => [p.rule, p.file]), [['schema-load', 'schemas/hole.schema.json']]);
  assert.match(hole[0].message, /\$defs\/missing/);
});

test('x-other is not a keyword and is rejected', (t) => {
  const root = tempRoot(t, { 'schemas/other.schema.json': { $schema: DRAFT, type: 'string', 'x-other': 1 } });
  const problems = createValidator(root).load('schemas/other.schema.json');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, 'schema-load');
  assert.match(problems[0].message, /x-other/);
});

test('a schema that breaks the meta-schema, and a file that is not JSON, are schema-load problems', (t) => {
  const root = tempRoot(t, { 'schemas/meta.schema.json': { $schema: DRAFT, type: 'string', minLength: -1 } });
  writeText(path.join(root, 'schemas', 'broken.schema.json'), '{ "type": ');
  const validator = createValidator(root);
  const meta = validator.load('schemas/meta.schema.json');
  assert.deepEqual(meta.map((p) => p.rule), ['schema-load']);
  assert.match(meta[0].message, /minLength/);
  const broken = validator.load('schemas/broken.schema.json');
  assert.deepEqual(broken.map((p) => p.rule), ['schema-load']);
  assert.match(broken[0].message, /line 1: unexpected end of input/);
});

test('errors lists "<pointer>: <message>" strings, "/" for the root, and throws for an unloadable schema', (t) => {
  const validator = createValidator(linked(t));
  assert.deepEqual(validator.errors('schemas/thing.schema.json', validThing), []);
  const nested = validator.errors('schemas/thing.schema.json', { size: [1] });
  assert.equal(nested.length, 1);
  assert.ok(nested[0].startsWith('/size: '), nested[0]);
  assert.deepEqual(validator.errors('schemas/thing.schema.json', {}), ["/: must have required property 'size'"]);
  assert.throws(() => validator.errors('schemas/nope.schema.json', {}), /file not found/);
});

test('compiled validators are cached per schema path', (t) => {
  const root = linked(t);
  const validator = createValidator(root);
  assert.deepEqual(validator.validate('schemas/thing.schema.json', validThing, 'case.json'), []);
  writeJson(path.join(root, 'schemas', 'thing.schema.json'), { $schema: DRAFT, type: 'string' });
  assert.deepEqual(validator.validate('schemas/thing.schema.json', validThing, 'case.json'), []);
  assert.equal(createValidator(root).validate('schemas/thing.schema.json', validThing, 'case.json').length, 1);
});

test('files that $ref each other, and refs through ../ folders, resolve', (t) => {
  const root = tempRoot(t, {
    'schemas/vec.schema.json': vec,
    'schemas/a.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { b: { $ref: 'b.schema.json' } } },
    'schemas/b.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { a: { $ref: 'a.schema.json' } } },
    'schemas/sub/c.schema.json': { $schema: DRAFT, type: 'object', additionalProperties: false, properties: { u: { $ref: '../vec.schema.json#/$defs/unit' } } },
  });
  const validator = createValidator(root);
  assert.deepEqual(validator.load('schemas/a.schema.json'), []);
  assert.deepEqual(validator.validate('schemas/a.schema.json', { b: { a: { b: {} } } }, 'case.json'), []);
  assert.equal(validator.validate('schemas/a.schema.json', { b: { a: { b: 1 } } }, 'case.json').length, 1);
  assert.deepEqual(validator.validate('schemas/sub/c.schema.json', { u: 'abc' }, 'case.json'), []);
  assert.equal(validator.validate('schemas/sub/c.schema.json', { u: 'ABC' }, 'case.json')[0].pointer, '/u');
});
