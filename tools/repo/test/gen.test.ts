// Tests for tools/repo/lib/gen.ts and tools/repo/commands/gen.ts: each mapping rule of types.gen.ts, the drift check and the command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { run } from '../commands/gen.ts';
import { discover } from '../lib/discover.ts';
import { checkGenerated, generateModule, writeGenerated } from '../lib/gen.ts';
import { checkImports } from '../lib/imports.ts';
import { isObject, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';
import { formatProblem } from '../lib/problems.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

const lines = (...parts: string[]): string => parts.join('\n');

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

function indexOf(dir: string, root = '.') {
  return discover(dir, root, createValidator(dir));
}

function generate(dir: string, id = 'm', root = '.') {
  const index = indexOf(dir, root);
  const module = index.modules.get(id);
  assert.ok(module, `module ${id} is not in the index: ${index.problems.map(formatProblem).join('; ')}`);
  return generateModule(index, module);
}

function textOf(dir: string, id = 'm', root = '.'): string {
  const { file, problems } = generate(dir, id, root);
  assert.deepEqual(problems.map(formatProblem), []);
  assert.ok(file);
  return file.text;
}

const where = (problems: readonly Problem[]): string[] => problems.map((p) => `${p.rule} ${p.file}#${p.pointer}`);

// The expression generated for `schema` as the config schema of module m; `more` holds files it refers to.
function configType(t: TestContext, schema: Json, more: Record<string, Json | string> = {}): string {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', config: { schema: 'schemas/c.schema.json', defaults: {} } },
    'modules/m/schemas/c.schema.json': schema,
    ...more,
  });
  const match = /export type Config = ([\s\S]*?);\n\nexport type State/.exec(textOf(dir));
  assert.ok(match);
  return match[1];
}

const STR: Json = { type: 'string' };
const NUM: Json = { type: 'number' };
const obj = (properties: Record<string, Json>, required: string[] = []): Json => ({ type: 'object', additionalProperties: false, required, properties });

const MAPPINGS: [name: string, schema: Json, expected: string][] = [
  ['string', STR, 'string'],
  ['number', NUM, 'number'],
  ['integer is number', { type: 'integer' }, 'number'],
  ['boolean', { type: 'boolean' }, 'boolean'],
  ['null', { type: 'null' }, 'null'],
  ['[T, "null"] is T | null', { type: ['string', 'null'] }, 'string | null'],
  ['{} is unknown', {}, 'unknown'],
  ['a schema with only annotations is unknown', { title: 'T', description: 'D', default: 1, 'x-unit': 'm' }, 'unknown'],
  ['x-ref and x-asset leave a string a string', { type: 'string', 'x-ref': 'm.item' }, 'string'],
  ['const string', { const: 'a"b' }, '"a\\"b"'],
  ['const number', { const: -1.5 }, '-1.5'],
  ['const boolean', { const: false }, 'false'],
  ['const null', { const: null }, 'null'],
  ['const object is unknown', { const: { a: 1 } }, 'unknown'],
  ['const array is unknown', { const: [1] }, 'unknown'],
  ['const wins over type', { type: 'string', const: 'a' }, '"a"'],
  ['enum is a union of string literals in order', { type: 'string', enum: ['b', 'a', 'c'] }, '"b" | "a" | "c"'],
  ['a one-value enum is a single literal', { type: 'string', enum: ['a'] }, '"a"'],
  ['array without items is unknown[]', { type: 'array' }, 'unknown[]'],
  ['array of T is T[]', { type: 'array', items: STR }, 'string[]'],
  ['array of arrays', { type: 'array', items: { type: 'array', items: STR } }, 'string[][]'],
  ['array of an enum puts the union in parentheses', { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }, '("a" | "b")[]'],
  ['array of a nullable puts the union in parentheses', { type: 'array', items: { type: ['number', 'null'] } }, '(number | null)[]'],
  ['array of a one-value enum needs no parentheses', { type: 'array', items: { enum: ['a'] } }, '"a"[]'],
  ['minItems equal to maxItems makes a tuple', { type: 'array', items: NUM, minItems: 3, maxItems: 3 }, '[number, number, number]'],
  ['a tuple of one', { type: 'array', items: NUM, minItems: 1, maxItems: 1 }, '[number]'],
  ['a tuple of 16', { type: 'array', items: NUM, minItems: 16, maxItems: 16 }, `[${'number, '.repeat(15)}number]`],
  ['17 items is an array', { type: 'array', items: NUM, minItems: 17, maxItems: 17 }, 'number[]'],
  ['0 items is an array', { type: 'array', items: NUM, minItems: 0, maxItems: 0 }, 'number[]'],
  ['different minItems and maxItems is an array', { type: 'array', items: NUM, minItems: 1, maxItems: 3 }, 'number[]'],
  ['minItems alone is an array', { type: 'array', items: NUM, minItems: 2 }, 'number[]'],
  ['a tuple without items holds unknown', { type: 'array', minItems: 2, maxItems: 2 }, '[unknown, unknown]'],
  ['a nullable tuple', { type: ['array', 'null'], items: NUM, minItems: 2, maxItems: 2 }, '[number, number] | null'],
  ['an array of objects', { type: 'array', items: obj({ a: STR }, ['a']) }, lines('{', '  a: string;', '}[]')],
  ['object: required properties, optional ones with ?', obj({ a: STR, b: NUM }, ['a']), lines('{', '  a: string;', '  b?: number;', '}')],
  ['object: keys bare when they are identifiers, quoted with JSON.stringify otherwise',
    obj({ a_b: STR, $x: STR, 'a-b': STR, '1x': STR, 'say "hi"': STR }),
    lines('{', '  a_b?: string;', '  $x?: string;', '  "a-b"?: string;', '  "1x"?: string;', '  "say \\"hi\\""?: string;', '}')],
  ['object: a nested object nests by two spaces', obj({ p: obj({ q: obj({ r: NUM }, ['r']) }, ['q']) }, ['p']),
    lines('{', '  p: {', '    q: {', '      r: number;', '    };', '  };', '}')],
  ['object: a nullable object', obj({ p: { ...obj({ q: NUM }, ['q']) as object, type: ['object', 'null'] } }, ['p']),
    lines('{', '  p: {', '    q: number;', '  } | null;', '}')],
  ['map: one index signature', { type: 'object', propertyNames: STR, additionalProperties: { type: 'integer' } }, lines('{', '  [key: string]: number;', '}')],
  ['map of objects', { type: 'object', propertyNames: STR, additionalProperties: obj({ p: NUM }, ['p']) },
    lines('{', '  [key: string]: {', '    p: number;', '  };', '}')],
  ['object with neither properties nor a map', { type: 'object', additionalProperties: false }, 'Record<string, never>'],
  ['object with empty properties', obj({}), 'Record<string, never>'],
];

for (const [name, schema, expected] of MAPPINGS) {
  test(`mapping: ${name}`, (t) => {
    assert.equal(configType(t, schema), expected);
  });
}

test('mapping: property descriptions become comments; deprecated adds @deprecated; newlines become spaces and */ is escaped', (t) => {
  const schema = obj({
    a: { type: 'string', description: 'Plain.' },
    b: { type: 'string', description: 'Two\nlines and a */ closer.' },
    c: { type: 'string', deprecated: true, description: 'Use a.' },
    d: { type: 'string', deprecated: true },
    e: STR,
    f: { type: 'string', description: '' },
    g: { ...obj({ h: { type: 'string', description: 'Inner.' } }) as object, description: 'Outer.' },
  }, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(configType(t, schema), lines(
    '{', '  /** Plain. */', '  a: string;', '  /** Two lines and a *\\/ closer. */', '  b: string;', '  /** @deprecated Use a. */', '  c: string;',
    '  /** @deprecated */', '  d: string;', '  e: string;', '  f: string;', '  /** Outer. */', '  g: {', '    /** Inner. */', '    h?: string;', '  };', '}',
  ));
});

test('mapping: a property takes the comment of its own node, not of the schema its $ref names', (t) => {
  const vec = { description: 'Target description.', type: 'array', items: NUM, minItems: 3, maxItems: 3 };
  const schema = obj({ a: { $ref: 'vec.schema.json', description: 'Own.' }, b: { $ref: 'vec.schema.json' } }, ['a', 'b']);
  assert.equal(configType(t, schema, { 'modules/m/schemas/vec.schema.json': vec }), lines(
    '{', '  /** Own. */', '  a: [number, number, number];', '  b: [number, number, number];', '}',
  ));
});

test('$ref: #/$defs/<name> in the same file, a file, a file with a fragment, and a file in another module', (t) => {
  const schema = {
    ...obj({
      local: { $ref: '#/$defs/point' },
      again: { $ref: '#/$defs/point' },
      file: { $ref: 'vec.schema.json' },
      defined: { $ref: 'shared.schema.json#/$defs/id' },
      other: { $ref: '../../geo/schemas/flag.schema.json' },
    }, ['local']) as object,
    $defs: { point: { type: 'array', items: NUM, minItems: 2, maxItems: 2 } },
  };
  assert.equal(configType(t, schema, {
    'modules/m/schemas/vec.schema.json': { type: 'array', items: NUM, minItems: 3, maxItems: 3 },
    'modules/m/schemas/shared.schema.json': { $defs: { id: STR } },
    'modules/geo/module.json': { id: 'geo', summary: 'x' },
    'modules/geo/schemas/flag.schema.json': { type: 'boolean' },
  }), lines('{', '  local: [number, number];', '  again?: [number, number];', '  file?: [number, number, number];', '  defined?: string;', '  other?: boolean;', '}'));
});

test('$ref: a ref inside a file in a subfolder resolves against that file and its own $defs', (t) => {
  const schema = { $ref: 'sub/a.schema.json' };
  assert.equal(configType(t, schema, {
    'modules/m/schemas/sub/a.schema.json': { ...obj({ b: { $ref: 'b.schema.json' }, local: { $ref: '#/$defs/local' } }) as object, $defs: { local: { type: 'boolean' } } },
    'modules/m/schemas/sub/b.schema.json': NUM,
  }), lines('{', '  b?: number;', '  local?: boolean;', '}'));
});

test('$ref: a recursive ref is gen-unsupported, at the node that closes the loop', (t) => {
  const cases: [name: string, files: Record<string, Json>, file: string, pointer: string][] = [
    ['the file refers to itself', { 'modules/m/schemas/c.schema.json': obj({ kids: { type: 'array', items: { $ref: 'c.schema.json' } } }) },
      'modules/m/schemas/c.schema.json', '/properties/kids/items'],
    ['a $defs entry refers to itself', { 'modules/m/schemas/c.schema.json': { $ref: '#/$defs/node', $defs: { node: obj({ next: { $ref: '#/$defs/node' } }) } } },
      'modules/m/schemas/c.schema.json', '/$defs/node/properties/next'],
    ['two files refer to each other', {
      'modules/m/schemas/c.schema.json': { $ref: 'x.schema.json' },
      'modules/m/schemas/x.schema.json': obj({ y: { $ref: 'y.schema.json' } }),
      'modules/m/schemas/y.schema.json': obj({ x: { $ref: 'x.schema.json' } }),
    }, 'modules/m/schemas/y.schema.json', '/properties/x'],
  ];
  for (const [name, files, file, pointer] of cases) {
    const dir = tempRepo(t, { 'modules/m/module.json': { id: 'm', summary: 'x', config: { schema: 'schemas/c.schema.json', defaults: {} } }, ...files });
    const { file: generated, problems } = generate(dir);
    assert.equal(generated, undefined, name);
    assert.deepEqual(where(problems), [`gen-unsupported ${file}#${pointer}`], name);
  }
});

test('$ref: a missing file is missing-file and a missing fragment is ref-missing, both at the ref', (t) => {
  const manifest = { id: 'm', summary: 'x', config: { schema: 'schemas/c.schema.json', defaults: {} } };
  const file = tempRepo(t, { 'modules/m/module.json': manifest, 'modules/m/schemas/c.schema.json': obj({ p: { $ref: 'nope.schema.json' } }) });
  assert.deepEqual(where(generate(file).problems), ['missing-file modules/m/schemas/c.schema.json#/properties/p']);
  const fragment = tempRepo(t, { 'modules/m/module.json': manifest, 'modules/m/schemas/c.schema.json': obj({ p: { $ref: '#/$defs/nope' } }) });
  assert.deepEqual(where(generate(fragment).problems), ['ref-missing modules/m/schemas/c.schema.json#/properties/p']);
});

test('a schema that is not JSON is json-parse with its line, and a manifest path with no file is missing-file', (t) => {
  const manifest = { id: 'm', summary: 'x', config: { schema: 'schemas/c.schema.json', defaults: {} } };
  const broken = tempRepo(t, { 'modules/m/module.json': manifest, 'modules/m/schemas/c.schema.json': '{\n  "type": nope\n}' });
  const [problem] = generate(broken).problems;
  assert.deepEqual([problem.rule, problem.file, problem.line], ['json-parse', 'modules/m/schemas/c.schema.json', 2]);
  const missing = tempRepo(t, { 'modules/m/module.json': manifest });
  assert.deepEqual(where(generate(missing).problems), ['missing-file modules/m/module.json#/config/schema']);
});

test('constructs the generator cannot express are gen-unsupported at their node', (t) => {
  const cases: [name: string, schema: Json, pointer: string][] = [
    ['an unknown type', { type: 'banana' }, ''],
    ['a type list that is not [T, "null"]', { type: ['string', 'number'] }, ''],
    ['an empty enum', { enum: [] }, ''],
    ['an enum of numbers', { enum: [1, 2] }, ''],
    ['an items that is a list', { type: 'array', items: [STR] }, '/items'],
    ['a property that is not an object', obj({ p: true }), '/properties/p'],
  ];
  for (const [name, schema, pointer] of cases) {
    const dir = tempRepo(t, {
      'modules/m/module.json': { id: 'm', summary: 'x', config: { schema: 'schemas/c.schema.json', defaults: {} } },
      'modules/m/schemas/c.schema.json': schema,
    });
    assert.deepEqual(where(generate(dir).problems), [`gen-unsupported modules/m/schemas/c.schema.json#${pointer}`], name);
  }
});

test('every declaration is tried: two bad schemas give two problems and no file', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', events: { a: 'schemas/a.schema.json', b: 'schemas/b.schema.json' } },
    'modules/m/schemas/a.schema.json': { type: 'banana' },
    'modules/m/schemas/b.schema.json': { type: 'apple' },
  });
  const { file, problems } = generate(dir);
  assert.equal(file, undefined);
  assert.deepEqual(where(problems), ['gen-unsupported modules/m/schemas/a.schema.json#', 'gen-unsupported modules/m/schemas/b.schema.json#']);
});

const SPAWN_POINT = {
  description: 'A place to spawn.',
  ...obj({ $schema: STR, $version: { const: 1 }, $comment: STR, x: NUM, 'y-axis': { type: 'number', description: 'Up.' } }, ['$version', 'x']) as object,
};

function fullModule(t: TestContext): string {
  return tempRepo(t, {
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true, operations: { ping: {} } },
    'modules/base/module.json': { id: 'base', summary: 'x' },
    'modules/opt/module.json': { id: 'opt', summary: 'x' },
    'modules/m/module.json': {
      id: 'm',
      summary: 'x',
      implements: ['api'],
      requires: ['base'],
      optional: ['opt', 'ghost'],
      types: { spawn_point: 'schemas/spawn_point.schema.json' },
      events: { spawned: 'schemas/spawned.schema.json' },
      operations: {
        place: { params: 'schemas/place_params.schema.json', result: 'schemas/place_result.schema.json' },
        reset: {},
        count: { result: 'schemas/count.schema.json' },
        poke: { params: 'schemas/poke.schema.json' },
      },
      state: 'schemas/state.schema.json',
      config: { schema: 'schemas/config.schema.json', defaults: {} },
    },
    'modules/m/schemas/spawn_point.schema.json': SPAWN_POINT,
    'modules/m/schemas/spawned.schema.json': obj({ id: STR }, ['id']),
    'modules/m/schemas/place_params.schema.json': obj({ at: NUM }, ['at']),
    'modules/m/schemas/place_result.schema.json': { type: 'boolean' },
    'modules/m/schemas/count.schema.json': { type: 'integer' },
    'modules/m/schemas/poke.schema.json': STR,
    'modules/m/schemas/state.schema.json': obj({ n: NUM }, ['n']),
    'modules/m/schemas/config.schema.json': obj({ speed: NUM }, ['speed']),
  });
}

test('layout: sections in order, params before results, own operations in manifest order, optional ids never imported', (t) => {
  assert.equal(textOf(fullModule(t)), lines(
    '// Generated by `npm run gen` from modules/m/module.json. Do not edit.',
    "import type { Ctx as RuntimeCtx } from '../../hosts/js/runtime.ts';",
    "import type * as api from '../api/types.gen.ts';",
    "import type * as base from '../base/types.gen.ts';",
    'export type { api, base };',
    '',
    '/** A place to spawn. */',
    'export type SpawnPoint = {',
    '  x: number;',
    '  /** Up. */',
    '  "y-axis"?: number;',
    '};',
    '',
    'export type SpawnedEvent = {',
    '  id: string;',
    '};',
    '',
    'export type PlaceParams = {',
    '  at: number;',
    '};',
    '',
    'export type PokeParams = string;',
    '',
    'export type PlaceResult = boolean;',
    '',
    'export type CountResult = number;',
    '',
    'export type Config = {',
    '  speed: number;',
    '};',
    '',
    'export type State = {',
    '  n: number;',
    '};',
    '',
    'export interface Operations extends api.Operations {',
    '  place(ctx: Ctx, params: PlaceParams): PlaceResult;',
    '  reset(ctx: Ctx): void;',
    '  count(ctx: Ctx): CountResult;',
    '  poke(ctx: Ctx, params: PokeParams): void;',
    '}',
    '',
    'export type Ctx = RuntimeCtx<State, Config>;',
    '',
  ));
});

test('layout: the GenFile names the module and its types.gen.ts', (t) => {
  const { file } = generate(fullModule(t));
  assert.deepEqual([file?.module, file?.path], ['m', 'modules/m/types.gen.ts']);
});

test('layout: a contract has no State and no Ctx, and its operations take RuntimeCtx', (t) => {
  const dir = tempRepo(t, {
    'modules/api/module.json': { id: 'api', summary: 'x', contract: true, operations: { get: { result: 'schemas/r.schema.json' }, set: { params: 'schemas/p.schema.json' } } },
    'modules/api/schemas/r.schema.json': NUM,
    'modules/api/schemas/p.schema.json': NUM,
  });
  assert.equal(textOf(dir, 'api'), lines(
    '// Generated by `npm run gen` from modules/api/module.json. Do not edit.',
    "import type { Ctx as RuntimeCtx } from '../../hosts/js/runtime.ts';",
    '',
    'export type SetParams = number;',
    '',
    'export type GetResult = number;',
    '',
    'export type Config = Record<string, never>;',
    '',
    'export interface Operations {',
    '  get(ctx: RuntimeCtx): GetResult;',
    '  set(ctx: RuntimeCtx, params: SetParams): void;',
    '}',
    '',
  ));
});

test('layout: a module without anything gets Config, State, Operations and Ctx only', (t) => {
  const dir = tempRepo(t, { 'modules/m/module.json': { id: 'm', summary: 'x' } });
  assert.equal(textOf(dir), lines(
    '// Generated by `npm run gen` from modules/m/module.json. Do not edit.',
    "import type { Ctx as RuntimeCtx } from '../../hosts/js/runtime.ts';",
    '',
    'export type Config = Record<string, never>;',
    '',
    'export type State = undefined;',
    '',
    'export interface Operations {',
    '}',
    '',
    'export type Ctx = RuntimeCtx<State, Config>;',
    '',
  ));
});

test('layout: the import path of the runtime follows the depth of the module folder', (t) => {
  const dir = tempRepo(t, { 'ex/y/modules/m/module.json': { id: 'm', summary: 'x' }, 'ex/y/modules/n/module.json': { id: 'n', summary: 'x', requires: ['m'] } });
  assert.match(textOf(dir, 'n', 'ex/y'), /^import type \{ Ctx as RuntimeCtx \} from '\.\.\/\.\.\/\.\.\/\.\.\/hosts\/js\/runtime\.ts';$/m);
  assert.match(textOf(dir, 'n', 'ex/y'), /^import type \* as m from '\.\.\/m\/types\.gen\.ts';$/m);
});

test('layout: several implemented contracts are extended in sorted order, requires are imported too', (t) => {
  const dir = tempRepo(t, {
    'modules/zed/module.json': { id: 'zed', summary: 'x', contract: true },
    'modules/abc/module.json': { id: 'abc', summary: 'x', contract: true },
    'modules/m/module.json': { id: 'm', summary: 'x', implements: ['zed', 'abc'], requires: ['abc'] },
  });
  const text = textOf(dir);
  assert.match(text, /^export type \{ abc, zed \};$/m);
  assert.match(text, /^export interface Operations extends abc\.Operations, zed\.Operations \{$/m);
});

test('an optional id gets no import, also when it is a module of the root, so deleting it changes nothing', (t) => {
  const files: Record<string, Json> = {
    'modules/opt/module.json': { id: 'opt', summary: 'x', types: { thing: 'schemas/thing.schema.json' } },
    'modules/opt/schemas/thing.schema.json': obj({ $version: { const: 1 } }),
    'modules/m/module.json': { id: 'm', summary: 'x', optional: ['opt'] },
  };
  const present = textOf(tempRepo(t, files));
  assert.doesNotMatch(present, /opt/);
  const { 'modules/opt/module.json': _manifest, 'modules/opt/schemas/thing.schema.json': _schema, ...rest } = files;
  const removed = textOf(tempRepo(t, { ...rest, 'modules/m/module.json': { id: 'm', summary: 'x', optional: ['opt'] } }));
  assert.equal(removed, present);
});

test('record types: Pascal names, the envelope keys are left out, the type description is the comment', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { vec3: 'schemas/vec3.schema.json', spawn__point: 'schemas/spawn_point.schema.json' } },
    'modules/m/schemas/vec3.schema.json': SPAWN_POINT,
    'modules/m/schemas/spawn_point.schema.json': { deprecated: true, ...obj({ $schema: STR, $version: { const: 1 }, $comment: STR }, ['$version']) as object },
  });
  const text = textOf(dir);
  assert.match(text, /^\/\*\* A place to spawn\. \*\/\nexport type Vec3 = \{$/m);
  assert.match(text, /^\/\*\* @deprecated \*\/\nexport type SpawnPoint = Record<string, never>;$/m);
  assert.doesNotMatch(text, /\$version|\$comment/);
});

test('record types: a nested object keeps keys named like the envelope', (t) => {
  const inner = obj({ $schema: STR, v: NUM });
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', types: { t: 'schemas/t.schema.json' } },
    'modules/m/schemas/t.schema.json': obj({ $schema: STR, $version: { const: 1 }, $comment: STR, inner }, ['$version']),
  });
  assert.match(textOf(dir), /^export type T = \{\n {2}inner\?: \{\n {4}\$schema\?: string;\n {4}v\?: number;\n {2}\};\n\};$/m);
});

test('pascal: parts split on _ start with a capital, also with digits', (t) => {
  const dir = tempRepo(t, {
    'modules/m/module.json': { id: 'm', summary: 'x', events: { a: 'schemas/e.schema.json', spawn_point: 'schemas/e.schema.json', vec3: 'schemas/e.schema.json', a_1_b2: 'schemas/e.schema.json' } },
    'modules/m/schemas/e.schema.json': STR,
  });
  assert.deepEqual([...textOf(dir).matchAll(/^export type (\w+) =/gm)].map((m) => m[1]), ['AEvent', 'SpawnPointEvent', 'Vec3Event', 'A1B2Event', 'Config', 'State', 'Ctx']);
});

test('gen-name-clash: two declarations with one identifier name both, at the manifest', (t) => {
  const cases: [name: string, manifest: Record<string, Json>, pointer: string, names: string[]][] = [
    ['type and operation params', { types: { x_params: 'schemas/s.schema.json' }, operations: { x: { params: 'schemas/s.schema.json' } } }, '/operations/x/params', ['type x_params', 'operation x params', 'XParams']],
    ['type and event', { types: { x_event: 'schemas/s.schema.json' }, events: { x: 'schemas/s.schema.json' } }, '/events/x', ['type x_event', 'event x', 'XEvent']],
    ['type and operation result', { types: { x_result: 'schemas/s.schema.json' }, operations: { x: { result: 'schemas/s.schema.json' } } }, '/operations/x/result', ['type x_result', 'operation x result', 'XResult']],
    ['two names with one Pascal form', { types: { a_b: 'schemas/s.schema.json', a__b: 'schemas/s.schema.json' } }, '/types/a__b', ['type a_b', 'type a__b', 'AB']],
    ['a type named config', { types: { config: 'schemas/s.schema.json' } }, '/types/config', ['type config', 'Config']],
    ['a type named state', { types: { state: 'schemas/s.schema.json' } }, '/types/state', ['type state', 'State']],
    ['a type named operations', { types: { operations: 'schemas/s.schema.json' } }, '/types/operations', ['type operations', 'Operations']],
    ['a type named ctx', { types: { ctx: 'schemas/s.schema.json' } }, '/types/ctx', ['type ctx', 'Ctx']],
    ['a type named runtime_ctx', { types: { runtime_ctx: 'schemas/s.schema.json' } }, '/types/runtime_ctx', ['type runtime_ctx', 'RuntimeCtx']],
  ];
  for (const [name, manifest, pointer, names] of cases) {
    const dir = tempRepo(t, { 'modules/m/module.json': { id: 'm', summary: 'x', ...manifest }, 'modules/m/schemas/s.schema.json': STR });
    const { file, problems } = generate(dir);
    assert.equal(file, undefined, name);
    assert.deepEqual(where(problems), [`gen-name-clash modules/m/module.json#${pointer}`], name);
    for (const part of names) assert.ok(problems[0].message.includes(part), `${name}: ${problems[0].message} lacks ${part}`);
  }
});

test('the fixture roots of this unit pass discover, and the import and gen rules they report are the errors of their expect.json', () => {
  for (const name of ['import-boundary', 'undeclared-package', 'dynamic-import', 'gen-stale', 'gen-name-clash', 'gen-unsupported', 'ok-code']) {
    const expected = readJson(path.join(repoRoot, ...FIXTURES.split('/'), name, 'expect.json'));
    assert.ok(expected.ok && isObject(expected.value), name);
    const index = discover(repoRoot, `${FIXTURES}/${name}`, validator);
    assert.deepEqual(index.problems, [], name);
    const problems = [...index.modules.values()].flatMap((module) => checkImports(index, module));
    if (expected.value.generated) problems.push(...checkGenerated(index));
    assert.ok(problems.every((p) => p.severity === 'error'), name);
    assert.deepEqual([...new Set(problems.map((p) => p.rule))], expected.value.errors, name);
  }
});

test('gen-name-clash and gen-unsupported roots: generation fails with exactly that rule', () => {
  for (const rule of ['gen-name-clash', 'gen-unsupported']) {
    const index = discover(repoRoot, `${FIXTURES}/${rule}`, validator);
    const { file, problems } = generateModule(index, index.modules.get('a')!);
    assert.equal(file, undefined, rule);
    assert.deepEqual(problems.map((p) => p.rule), [rule]);
    assert.deepEqual(checkGenerated(index).map((p) => p.rule), [rule]);
  }
});

test('ok-code root: the generated text of each module equals its committed types.gen.ts', () => {
  const index = discover(repoRoot, `${FIXTURES}/ok-code`, validator);
  assert.deepEqual([...index.modules.keys()], ['api', 'impl', 'user']);
  for (const module of index.modules.values()) {
    const { file, problems } = generateModule(index, module);
    assert.deepEqual(problems, []);
    assert.ok(file);
    assert.equal(file.text, readText(path.join(repoRoot, ...file.path.split('/'))), module.id);
  }
  assert.deepEqual(checkGenerated(index), []);
});

test('gen-stale root: the hand-edited file is gen-stale at the file, pointer empty', () => {
  const problems = checkGenerated(discover(repoRoot, `${FIXTURES}/gen-stale`, validator));
  assert.deepEqual(problems.map((p) => [p.rule, p.severity, p.file, p.pointer, p.message]), [
    ['gen-stale', 'error', `${FIXTURES}/gen-stale/modules/a/types.gen.ts`, '', 'differs from npm run gen output; run npm run gen'],
  ]);
});

// A temporary repository holding the ok-code root at its real path, without its types.gen.ts files.
function okCodeCopy(t: TestContext): string {
  const dir = tempRepo(t, {});
  const target = path.join(dir, ...FIXTURES.split('/'), 'ok-code');
  fs.cpSync(path.join(repoRoot, ...FIXTURES.split('/'), 'ok-code'), target, { recursive: true });
  for (const id of ['api', 'impl', 'user']) fs.rmSync(path.join(target, 'modules', id, 'types.gen.ts'));
  return dir;
}

test('checkGenerated: a missing file is gen-stale "missing; run npm run gen"', (t) => {
  const dir = okCodeCopy(t);
  const problems = checkGenerated(indexOf(dir, `${FIXTURES}/ok-code`));
  assert.deepEqual(problems.map((p) => [p.rule, p.file, p.message]), ['api', 'impl', 'user'].map((id) => ['gen-stale', `${FIXTURES}/ok-code/modules/${id}/types.gen.ts`, 'missing; run npm run gen']));
});

test('writeGenerated writes the missing files, then a second run writes nothing', (t) => {
  const dir = okCodeCopy(t);
  const root = `${FIXTURES}/ok-code`;
  const first = writeGenerated(indexOf(dir, root));
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.written, ['api', 'impl', 'user'].map((id) => `${root}/modules/${id}/types.gen.ts`));
  for (const id of ['api', 'impl', 'user']) {
    const file = `${root}/modules/${id}/types.gen.ts`;
    assert.equal(readText(path.join(dir, ...file.split('/'))), readText(path.join(repoRoot, ...file.split('/'))), id);
  }
  assert.deepEqual(checkGenerated(indexOf(dir, root)), []);
  assert.deepEqual(writeGenerated(indexOf(dir, root)), { written: [], problems: [] });
});

test('writeGenerated rewrites only the file whose schema changed, and reports modules it cannot generate', (t) => {
  const dir = okCodeCopy(t);
  const root = `${FIXTURES}/ok-code`;
  writeGenerated(indexOf(dir, root));
  const ping = path.join(dir, ...root.split('/'), 'modules', 'api', 'schemas', 'ping.schema.json');
  fs.writeFileSync(ping, fs.readFileSync(ping, 'utf8').replace('"integer"', '"string"'));
  assert.deepEqual(writeGenerated(indexOf(dir, root)).written, [`${root}/modules/api/types.gen.ts`]);
  fs.writeFileSync(ping, '{ "type": "banana" }\n');
  const broken = writeGenerated(indexOf(dir, root));
  assert.deepEqual(broken.written, []);
  assert.deepEqual(where(broken.problems), [`gen-unsupported ${root}/modules/api/schemas/ping.schema.json#`]);
});

test('committed files are compared as read by readText, so CRLF line endings are current', (t) => {
  const dir = okCodeCopy(t);
  const root = `${FIXTURES}/ok-code`;
  writeGenerated(indexOf(dir, root));
  const file = path.join(dir, ...root.split('/'), 'modules', 'user', 'types.gen.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  assert.deepEqual(checkGenerated(indexOf(dir, root)), []);
  assert.deepEqual(writeGenerated(indexOf(dir, root)).written, []);
});

function cli(...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'repo', 'cli.ts'), 'gen', ...args], { encoding: 'utf8' });
  return { status, stdout, stderr };
}

test('gen --check exits 0 on ok-code and prints the summary', () => {
  const r = cli('--check', '--root', `${FIXTURES}/ok-code`);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'gen: 0 problems\n', '']);
});

test('gen --check exits 1 on gen-stale and prints the problem, then the summary', () => {
  const r = cli('--check', '--root', `${FIXTURES}/gen-stale`);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${FIXTURES}/gen-stale/modules/a/types.gen.ts#: differs from npm run gen output; run npm run gen [gen-stale]\ngen: 1 problems\n`);
});

test('gen --check reports several roots at once, sorted', () => {
  const r = cli('--check', '--root', `${FIXTURES}/ok-code`, '--root', `${FIXTURES}/gen-stale`, '--root', `${FIXTURES}/gen-unsupported`);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.split('\n').map((line) => line.replace(/^.*\[(.*)\]$/, '$1')), ['gen-stale', 'gen-unsupported', 'gen: 2 problems', '']);
});

test('gen usage errors exit 2 with a message on stderr: no root, unknown option, positional, missing and outside roots', () => {
  for (const args of [[], ['--check'], ['--bogus', '--root', '.'], ['--root', '.', 'extra'], ['--root']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.notEqual(r.stderr, '', args.join(' '));
  }
  for (const root of ['nowhere', '../x', '/etc', 'C:/x', 'a\\b', 'schemas/../..']) {
    const r = cli('--root', root);
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `no such root: ${root}\n`], root);
  }
  const file = cli('--root', 'package.json');
  assert.deepEqual([file.status, file.stderr], [2, 'no such root: package.json\n']);
});

// Runs the gen command in this process against a temporary repository, collecting what it prints.
function runGen(t: TestContext, dir: string, ...args: string[]): { status: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, 'log', (...parts: unknown[]) => { out.push(parts.join(' ')); });
  t.mock.method(console, 'error', (...parts: unknown[]) => { err.push(parts.join(' ')); });
  return { status: run(args, dir), out, err };
}

test('gen writes types.gen.ts, says how many, and writes nothing the second time', (t) => {
  const dir = tempRepo(t, { 'modules/a/module.json': { id: 'a', summary: 'x' }, 'modules/b/module.json': { id: 'b', summary: 'x', requires: ['a'] } });
  assert.deepEqual(runGen(t, dir, '--root', '.'), { status: 0, out: ['gen: wrote 2 files'], err: [] });
  assert.equal(readText(path.join(dir, 'modules', 'b', 'types.gen.ts')), textOf(dir, 'b'));
  assert.deepEqual(runGen(t, dir, '--root', '.'), { status: 0, out: ['gen: wrote 0 files'], err: [] });
  assert.deepEqual(runGen(t, dir, '--check', '--root', '.'), { status: 0, out: ['gen: 0 problems'], err: [] });
});

test('gen --check after a hand edit exits 1 with gen-stale, and gen repairs it', (t) => {
  const dir = tempRepo(t, { 'modules/a/module.json': { id: 'a', summary: 'x' } });
  runGen(t, dir, '--root', '.');
  const file = path.join(dir, 'modules', 'a', 'types.gen.ts');
  writeText(file, `${readText(file)}// edited\n`);
  const check = runGen(t, dir, '--check', '--root', '.');
  assert.deepEqual([check.status, check.out], [1, ['modules/a/types.gen.ts#: differs from npm run gen output; run npm run gen [gen-stale]', 'gen: 1 problems']]);
  assert.deepEqual(runGen(t, dir, '--root', '.').out, ['gen: wrote 1 files']);
  assert.equal(runGen(t, dir, '--check', '--root', '.').status, 0);
});

test('gen prints generation problems and exits 1 while still writing the modules it can', (t) => {
  const dir = tempRepo(t, {
    'modules/good/module.json': { id: 'good', summary: 'x' },
    'modules/bad/module.json': { id: 'bad', summary: 'x', events: { e: 'schemas/e.schema.json' } },
    'modules/bad/schemas/e.schema.json': { type: 'banana' },
  });
  const r = runGen(t, dir, '--root', '.');
  assert.deepEqual([r.status, r.out], [1, ['modules/bad/schemas/e.schema.json#: type "banana" cannot be expressed [gen-unsupported]', 'gen: wrote 1 files']]);
  assert.ok(fs.existsSync(path.join(dir, 'modules', 'good', 'types.gen.ts')));
  assert.ok(!fs.existsSync(path.join(dir, 'modules', 'bad', 'types.gen.ts')));
});

test('gen shows the errors of discover, a root without modules/ and a module that was skipped, but not its warnings', (t) => {
  const dir = tempRepo(t, {
    'empty/.keep': '',
    'modules/skipped/module.json': { id: 'skipped' },
    'modules/warns/module.json': { id: 'warns', summary: 'x', optional: ['ghost'] },
  });
  assert.deepEqual(runGen(t, dir, '--check', '--root', 'empty').out, ['empty#: empty has no modules folder [root-missing]', 'gen: 1 problems']);
  const skipped = runGen(t, dir, '--check', '--root', '.');
  assert.equal(skipped.status, 1);
  assert.equal(skipped.out.length, 3, skipped.out.join('\n'));
  assert.match(skipped.out[0], /^modules\/skipped\/module\.json#: .* \[schema\]$/);
  assert.match(skipped.out[1], /^modules\/warns\/types\.gen\.ts#: missing; run npm run gen \[gen-stale\]$/);
});
