// Tests for tools/repo/lib/profile.ts: one failing schema per rule of plan 4.6, the record envelope, and the reference collectors.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isObject, readJson } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { checkProfile, checkRecordType, REF_FORM, schemaRefs, typeRefs } from '../lib/profile.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const FILE = 'x.schema.json';

// A valid object schema at the root with the given keywords added.
function root(extra: Record<string, Json> = {}): Json {
  return { $schema: DRAFT, type: 'object', additionalProperties: false, ...extra };
}

// A root whose only property `a` is the given node.
function withProperty(node: Json): Json {
  return root({ properties: { a: node } });
}

function pointers(schema: Json): string[] {
  return checkProfile(schema, FILE).map((p) => p.pointer).sort();
}

const CASES: [name: string, schema: Json, expected: string[]][] = [
  // rule 1: root $schema, $schema and $defs only at the root, $defs keys
  ['1 no $schema at the root', { type: 'object', additionalProperties: false }, ['']],
  ['1 another $schema at the root', { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false }, ['']],
  ['1 $schema below the root', withProperty({ $schema: DRAFT, type: 'string' }), ['/properties/a']],
  ['1 $defs below the root', withProperty({ type: 'string', $defs: {} }), ['/properties/a']],
  ['1 $defs keys with a dash or a leading digit', root({ $defs: { 'bad-name': { type: 'string' }, '1x': { type: 'string' } } }), ['/$defs/1x', '/$defs/bad-name']],
  ['1 $defs keys that follow the pattern', root({ $defs: { name: { type: 'string' }, Name_2: { type: 'string' } } }), []],
  // rule 2: allowed keywords
  ['2 an unknown keyword', withProperty({ type: 'string', foo: 1 }), ['/properties/a']],
  ['2 oneOf is rejected', withProperty({ oneOf: [{ type: 'string' }, { type: 'integer' }] }), ['/properties/a']],
  // rule 3: every node is an object; false only as additionalProperties
  ['3 true as a schema', withProperty(true), ['/properties/a']],
  ['3 false as a schema', withProperty(false), ['/properties/a']],
  ['3 a string as a schema', withProperty('string'), ['/properties/a']],
  ['3 items true', withProperty({ type: 'array', items: true }), ['/properties/a/items']],
  ['3 propertyNames true', withProperty({ type: 'object', propertyNames: true, additionalProperties: {} }), ['/properties/a/propertyNames']],
  ['3 a root that is no object', [] as Json, ['']],
  ['3 a root that is true', true, ['']],
  ['3 {} means any value, additionalProperties false is the one boolean', withProperty({}), []],
  // rule 4: type
  ['4 an unknown type', withProperty({ type: 'foo' }), ['/properties/a']],
  ['4 two types without null', withProperty({ type: ['string', 'integer'] }), ['/properties/a']],
  ['4 null first', withProperty({ type: ['null', 'string'] }), ['/properties/a']],
  ['4 null twice', withProperty({ type: ['null', 'null'] }), ['/properties/a']],
  ['4 an empty list', withProperty({ type: [] }), ['/properties/a']],
  ['4 a list of one', withProperty({ type: ['string'] }), ['/properties/a']],
  ['4 a number', withProperty({ type: 5 }), ['/properties/a']],
  ['4 a bad type reports once, not again as a missing type', withProperty({ type: 'foo', properties: {} }), ['/properties/a']],
  ['4 [T, "null"] and "null" are fine', withProperty({ type: ['object', 'null'], additionalProperties: false }), []],
  // rule 5: keywords that need a type
  ['5 properties without a type', withProperty({ properties: {} }), ['/properties/a']],
  ['5 items on a string', withProperty({ type: 'string', items: {} }), ['/properties/a']],
  ['5 pattern on an integer', withProperty({ type: 'integer', pattern: '^a' }), ['/properties/a']],
  ['5 minimum on a string', withProperty({ type: 'string', minimum: 1 }), ['/properties/a']],
  ['5 x-ref on an integer', withProperty({ type: 'integer', 'x-ref': 'a.b' }), ['/properties/a']],
  ['5 x-asset on an array', withProperty({ type: 'array', items: {}, 'x-asset': ['glb'] }), ['/properties/a']],
  ['5 a nullable array may carry array keywords', withProperty({ type: ['array', 'null'], items: { type: 'number' }, minItems: 3, maxItems: 3 }), []],
  ['5 integer and number take number keywords', withProperty({ type: 'integer', minimum: 0, exclusiveMaximum: 9, multipleOf: 2 }), []],
  // rule 6: objects state additionalProperties; maps need propertyNames
  ['6 an object without additionalProperties', { $schema: DRAFT, type: 'object' }, ['']],
  ['6 a nullable object without additionalProperties', withProperty({ type: ['object', 'null'] }), ['/properties/a']],
  ['6 properties with a schema as additionalProperties', withProperty({ type: 'object', properties: {}, additionalProperties: {} }), ['/properties/a']],
  ['6 properties and propertyNames with a schema as additionalProperties', withProperty({ type: 'object', properties: {}, propertyNames: {}, additionalProperties: {} }), ['/properties/a']],
  ['6 a map without propertyNames', withProperty({ type: 'object', additionalProperties: { type: 'string' } }), ['/properties/a']],
  ['6 additionalProperties true beside properties', root({ properties: {}, additionalProperties: true }), ['/additionalProperties']],
  ['6 additionalProperties true without properties', root({ additionalProperties: true }), ['/additionalProperties']],
  ['6 a map', withProperty({ type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'integer' } }), []],
  ['6 an empty object', withProperty({ type: 'object', additionalProperties: false }), []],
  // rule 7: required names are properties
  ['7 a required name that is no property', root({ required: ['a', 'b'], properties: { a: {} } }), ['']],
  ['7 required without properties', root({ required: ['a'] }), ['']],
  ['7 required names that are properties', root({ required: ['a'], properties: { a: {} } }), []],
  // rule 8: enum
  ['8 an empty enum', withProperty({ type: 'string', enum: [] }), ['/properties/a']],
  ['8 a number in enum', withProperty({ type: 'string', enum: ['a', 1] }), ['/properties/a']],
  ['8 a repeated value in enum', withProperty({ type: 'string', enum: ['a', 'a'] }), ['/properties/a']],
  ['8 enum that is no list', withProperty({ type: 'string', enum: 'a' }), ['/properties/a']],
  ['8 a list of distinct strings', withProperty({ type: 'string', enum: ['a', 'b'] }), []],
  // rule 9: items is one schema
  ['9 items as a list', withProperty({ type: 'array', items: [{ type: 'string' }] }), ['/properties/a']],
  ['9 items as one schema', withProperty({ type: 'array', items: { type: 'string' } }), []],
  // rule 11: annotations
  ['11 x-ref that is no qualified id', withProperty({ type: 'string', 'x-ref': 'item' }), ['/properties/a']],
  ['11 x-ref that is no string', withProperty({ type: 'string', 'x-ref': 5 }), ['/properties/a']],
  ['11 an empty x-asset', withProperty({ type: 'string', 'x-asset': [] }), ['/properties/a']],
  ['11 x-asset that is no list', withProperty({ type: 'string', 'x-asset': 'glb' }), ['/properties/a']],
  ['11 an upper-case extension', withProperty({ type: 'string', 'x-asset': ['GLB'] }), ['/properties/a']],
  ['11 a repeated extension', withProperty({ type: 'string', 'x-asset': ['glb', 'glb'] }), ['/properties/a']],
  ['11 x-asset with gltf', withProperty({ type: 'string', 'x-asset': ['gltf'] }), ['/properties/a']],
  ['11 x-asset with glb and gltf', withProperty({ type: 'string', 'x-asset': ['glb', 'gltf'] }), ['/properties/a']],
  ['11 an empty x-unit', withProperty({ type: 'number', 'x-unit': '' }), ['/properties/a']],
  ['11 x-unit that is no string', withProperty({ type: 'number', 'x-unit': 5 }), ['/properties/a']],
  ['11 valid annotations', withProperty({ type: 'string', 'x-ref': 'a.b', 'x-asset': ['glb', 'png'], 'x-unit': 'm' }), []],
  // rule 12: keyword values are left to Ajv
  ['12 minLength -1', withProperty({ type: 'string', minLength: -1 }), []],
  ['12 a pattern that is no regular expression', withProperty({ type: 'string', pattern: '[' }), []],
  ['12 minItems that is no number', withProperty({ type: 'array', items: {}, minItems: 'x' }), []],
];

for (const [name, schema, expected] of CASES) {
  test(`rule ${name}: ${expected.length === 0 ? 'no problem' : `[profile] at ${expected.map((p) => p || 'the root').join(', ')}`}`, () => {
    const problems = checkProfile(schema, FILE);
    assert.deepEqual(problems.map((p) => p.pointer).sort(), expected, problems.map((p) => p.message).join('\n'));
    for (const p of problems) assert.deepEqual([p.rule, p.severity, p.file], ['profile', 'error', FILE]);
  });
}

const BANNED = [
  'oneOf', 'allOf', 'anyOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties',
  'unevaluatedItems', 'contains', 'prefixItems', '$anchor', '$dynamicRef', '$dynamicAnchor', 'format', '$id', 'minProperties', 'maxProperties',
];

for (const keyword of BANNED) {
  test(`rule 2: ${keyword} is rejected and the message names it`, () => {
    const problems = checkProfile(root({ [keyword]: 1 }), FILE);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].pointer, '');
    assert.ok(problems[0].message.includes(keyword), problems[0].message);
  });
}

test('rule 2: a schema that uses every allowed keyword is clean', () => {
  const schema = root({
    $comment: 'c',
    title: 't',
    description: 'd',
    default: {},
    examples: [{}],
    deprecated: false,
    required: ['s'],
    properties: {
      s: { type: 'string', minLength: 1, maxLength: 5, pattern: '^a', enum: ['a', 'b'], 'x-ref': 'a.b', 'x-unit': 'm' },
      n: { type: ['number', 'null'], minimum: 0, maximum: 9, exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 1 },
      k: { const: 1 },
      r: { $ref: '#/$defs/d' },
      list: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 3, uniqueItems: true },
      asset: { type: 'string', 'x-asset': ['glb', 'png'] },
      map: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
    },
    $defs: { d: { type: 'boolean' } },
  });
  assert.deepEqual(checkProfile(schema, FILE), []);
});

test('a node with two banned keywords gives one problem per keyword at the same pointer', () => {
  const problems = checkProfile(withProperty({ oneOf: [], allOf: [] }), FILE);
  assert.deepEqual(problems.map((p) => p.pointer), ['/properties/a', '/properties/a']);
  assert.notEqual(problems[0].message, problems[1].message);
});

test('problems inside a banned keyword are not walked', () => {
  assert.deepEqual(pointers(withProperty({ oneOf: [{ type: 'foo' }, true] })), ['/properties/a']);
});

test('nodes are found below properties, items, additionalProperties, propertyNames and $defs', () => {
  const schema = root({
    properties: { list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { deep: { type: 'foo' } } } } },
    $defs: { d: { type: 'object', propertyNames: { type: 'string', pattern: 5, foo: 1 }, additionalProperties: { type: 'string', bar: 1 } } },
  });
  assert.deepEqual(pointers(schema), ['/$defs/d/additionalProperties', '/$defs/d/propertyNames', '/properties/list/items/properties/deep']);
});

test('property names that look like keywords are names, not keywords', () => {
  const schema = root({ properties: { $schema: { type: 'string' }, $ref: { type: 'string' }, oneOf: { type: 'string' }, 'x-ref': { type: 'string' } } });
  assert.deepEqual(checkProfile(schema, FILE), []);
});

test('rule 10: $ref forms', () => {
  const good = ['#/$defs/name', 'x.schema.json', 'a/b.schema.json', './x.schema.json', '../a/b.schema.json#/$defs/c', '../../geo/schemas/vec3.schema.json', 'module.schema.json#/$defs/name'];
  const bad = ['http://example.com/x.schema.json', 'x.json', '#/definitions/x', '#', '#/$defs/bad-name', 'x.schema.json#/definitions/y', '/abs/x.schema.json', 'x.schema.json#', 'x.schema.json#/$defs/1x'];
  for (const ref of good) {
    assert.ok(REF_FORM.test(ref), ref);
    assert.deepEqual(checkProfile(withProperty({ $ref: ref }), FILE), [], ref);
  }
  for (const ref of bad) {
    assert.ok(!REF_FORM.test(ref), ref);
    assert.deepEqual(pointers(withProperty({ $ref: ref })), ['/properties/a'], ref);
  }
});

test('the five foundation schemas follow the profile', () => {
  for (const name of ['module', 'game', 'bundle', 'trace', 'trace-bundle']) {
    const file = `schemas/${name}.schema.json`;
    const parsed = readJson(path.join(repoRoot, 'schemas', `${name}.schema.json`));
    assert.ok(parsed.ok, file);
    assert.deepEqual(checkProfile(parsed.value, file), [], file);
  }
});

function recordType(change: (schema: Record<string, Json>) => void = () => {}): Json {
  const schema: Record<string, Json> = {
    $schema: DRAFT,
    type: 'object',
    additionalProperties: false,
    required: ['$version', 'name'],
    properties: { $schema: { type: 'string' }, $version: { const: 1 }, $comment: { type: 'string' }, name: { type: 'string' } },
  };
  change(schema);
  return schema;
}

function props(schema: Record<string, Json>): Record<string, Json> {
  const properties = schema.properties;
  assert.ok(isObject(properties));
  return properties;
}

const ENVELOPE_CASES: [name: string, change: (schema: Record<string, Json>) => void, expected: string[]][] = [
  ['a complete envelope', () => {}, []],
  ['a root type that is not object', (s) => { s.type = 'array'; }, ['']],
  ['a nullable root type', (s) => { s.type = ['object', 'null']; }, ['']],
  ['additionalProperties not false', (s) => { s.additionalProperties = {}; }, ['']],
  ['no additionalProperties', (s) => { delete s.additionalProperties; }, ['']],
  ['no properties at all', (s) => { delete s.properties; }, ['', '', '']],
  ['no $schema property', (s) => { delete props(s).$schema; }, ['/properties']],
  ['$schema that is not a string', (s) => { props(s).$schema = { type: 'integer' }; }, ['/properties/$schema']],
  ['no $comment property', (s) => { delete props(s).$comment; }, ['/properties']],
  ['no $version property', (s) => { delete props(s).$version; }, ['/properties']],
  ['$version without const', (s) => { props(s).$version = { type: 'integer' }; }, ['/properties/$version']],
  ['$version const 0', (s) => { props(s).$version = { const: 0 }; }, ['/properties/$version']],
  ['$version const 1.5', (s) => { props(s).$version = { const: 1.5 }; }, ['/properties/$version']],
  ['$version const "1"', (s) => { props(s).$version = { const: '1' }; }, ['/properties/$version']],
  ['$version const 7', (s) => { props(s).$version = { const: 7 }; }, []],
  ['$version missing from required', (s) => { s.required = ['name']; }, ['']],
  ['no required', (s) => { delete s.required; }, ['']],
];

for (const [name, change, expected] of ENVELOPE_CASES) {
  test(`record type: ${name}`, () => {
    const problems = checkRecordType(recordType(change), FILE);
    assert.deepEqual(problems.map((p) => p.pointer), expected, problems.map((p) => p.message).join('\n'));
    for (const p of problems) assert.deepEqual([p.rule, p.severity, p.file], ['record-type', 'error', FILE]);
  });
}

test('record type: a schema that is no object is left to checkProfile', () => {
  assert.deepEqual(checkRecordType([] as Json, FILE), []);
});

test('schemaRefs lists every $ref with its pointer in document order', () => {
  const schema = root({
    properties: {
      first: { $ref: 'a.schema.json' },
      list: { type: 'array', items: { $ref: '#/$defs/d' } },
      map: { type: 'object', propertyNames: { $ref: '#/$defs/name' }, additionalProperties: { $ref: 'b.schema.json#/$defs/x' } },
    },
    $defs: { d: { type: 'string' }, other: { $ref: '../c.schema.json' } },
  });
  assert.deepEqual(schemaRefs(schema), [
    { pointer: '/properties/first/$ref', ref: 'a.schema.json' },
    { pointer: '/properties/list/items/$ref', ref: '#/$defs/d' },
    { pointer: '/properties/map/propertyNames/$ref', ref: '#/$defs/name' },
    { pointer: '/properties/map/additionalProperties/$ref', ref: 'b.schema.json#/$defs/x' },
    { pointer: '/$defs/other/$ref', ref: '../c.schema.json' },
  ]);
});

test('typeRefs lists every x-ref with its pointer, and neither collector reads data or property names', () => {
  const schema = root({
    properties: {
      body: { type: 'string', 'x-ref': 'geo.body' },
      'x-ref': { type: 'string' },
      $ref: { type: 'string', 'x-ref': 'a.b' },
      list: { type: 'array', items: { type: 'string', 'x-ref': 'c.d' } },
      properties: { type: 'string', 'x-ref': 'p.q' },
      default: { type: 'string', 'x-ref': 'd.e' },
      fixed: { const: { $ref: 'ignored.schema.json', 'x-ref': 'e.f' }, default: { $ref: 'ignored.schema.json' }, examples: [{ 'x-ref': 'g.h' }] },
      number: { type: 'string', 'x-ref': 5, enum: ['x-ref'] },
    },
  });
  assert.deepEqual(typeRefs(schema), [
    { pointer: '/properties/body/x-ref', type: 'geo.body' },
    { pointer: '/properties/$ref/x-ref', type: 'a.b' },
    { pointer: '/properties/list/items/x-ref', type: 'c.d' },
    { pointer: '/properties/properties/x-ref', type: 'p.q' },
    { pointer: '/properties/default/x-ref', type: 'd.e' },
  ]);
  assert.deepEqual(schemaRefs(schema), []);
});
