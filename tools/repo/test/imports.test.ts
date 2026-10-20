// Tests for tools/repo/lib/imports.ts: every token rule and import form of scanImports, and checkImports on the import fixture roots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { discover } from '../lib/discover.ts';
import type { ModuleInfo, RootIndex } from '../lib/discover.ts';
import { checkImports, scanImports } from '../lib/imports.ts';
import { writeText } from '../lib/json.ts';
import type { Problem } from '../lib/problems.ts';
import { createValidator } from '../lib/validate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES = 'tools/repo/test/fixtures/roots';
const validator = createValidator(repoRoot);

// What scanImports finds, as `<line>:<specifier>`.
function found(source: string): string[] {
  return scanImports(source).map((ref) => `${ref.line}:${ref.specifier}`);
}

const lines = (...parts: string[]): string => parts.join('\n');

const CASES: [name: string, source: string, expected: string[]][] = [
  ['a regex literal holding a quote does not hide the import after it', lines(
    "const APOS = /'/g;", "const GLOB = 'assets/*.glb';", "import { play } from '../../audio/web/index.ts';", "const END = '*/';", 'export const n = 1;',
  ), ['3:../../audio/web/index.ts']],
  ['type imports, a multi-line specifier list and every re-export form', lines(
    "import type { A } from '../types.gen.ts';", 'import {', '  b,', '  c,', "} from './b.ts';", "export type * as ns from '../x/types.gen.ts';",
    "export { d } from './d.ts';", "export * from './e.ts';", 'export const f = 1;', 'export { f as g };',
  ), ['1:../types.gen.ts', '2:./b.ts', '6:../x/types.gen.ts', '7:./d.ts', '8:./e.ts']],
  ['a side-effect import, import() with a literal and with a variable, and import.meta', lines(
    "import './side.ts';", "const m = await import('./lazy.ts');", 'const n = await import(name);', 'const u = import.meta.url;',
  ), ['1:./side.ts', '2:./lazy.ts', '3:null']],
  ['imports written inside comments and strings are not reported', lines(
    "// import x from '../../a.ts';", "/* import y from '../../b.ts'; */", `const s = "import z from '../../c.ts'";`, `const q = 'export * from "../../d.ts"';`,
  ), []],
  ['an import inside a template substitution is reported, template text is not', 'const t = `import a from "../../t.ts" ${await import("./in-template.ts")} done`;', ['1:./in-template.ts']],
  ['division next to a regex with a slash in a class', lines(
    'const r = a / b / c;', 'const re = /[/]import/g;', 'const w = (x) / 2;', "function f() { return /\\/ from 'nope'/; }", "import { k } from './k.ts';",
  ), ['5:./k.ts']],
  ['loader.import(...) is a method call, not an import', lines("const v = loader.import('../../x.ts');", "import z from 'pkg/sub';"), ['2:pkg/sub']],

  ['no source gives no references', '', []],
  ['whitespace and comments between the words of an import', "import /* a */ x // b\n  from './a.ts';", ['1:./a.ts']],
  ['a block comment counts its lines', "/* a\nb\nc */\nimport './x.ts';", ['4:./x.ts']],
  ['a template literal counts its lines', 'const t = `a\nb\nc`;\nimport \'./x.ts\';', ['4:./x.ts']],
  ['a backslash escapes a quote, and an escaped newline continues the string', "const s = 'it\\'s \\\nstill';\nimport './a.ts';", ['3:./a.ts']],
  ['a string without a closing quote ends at the end of its line', "const s = 'oops;\nimport './a.ts';", ['2:./a.ts']],
  ['a specifier is the text of its string', `import a from "./a.ts";\nimport b from './b.ts';`, ['1:./a.ts', '2:./b.ts']],
  ['a template escapes its backtick and its ${', 'const t = `\\` import \'./no.ts\' \\${ import("./no2.ts") }`;\nimport \'./yes.ts\';', ['2:./yes.ts']],
  ['a template inside a substitution', 'const t = `${ { a: `x ${ import(\'./deep.ts\') }` }.a } end`;\nimport \'./after.ts\';', ['1:./deep.ts', '2:./after.ts']],
  ['braces inside a substitution do not end it', 'const t = `${ { a: 1 }.a + (await import(\'./inside.ts\')) } import \'./text.ts\'`;', ['1:./inside.ts']],
  ['a regex ends at an unescaped slash outside a class, then its flags', "const re = /\\/'/gi; import './a.ts';", ['1:./a.ts']],
  ['a regex without a closing slash ends at the end of its line', "const re = /abc\nimport './a.ts';", ['2:./a.ts']],
  ['a regex at the start of the source', "/import y from '\\.\\/hidden\\.ts'/; import './seen.ts';", ['1:./seen.ts']],

  ['every import form', lines(
    "import a from './a.ts';", "import * as b from './b.ts';", "import { c } from './c.ts';", "import d, { e } from './d.ts';", "import type F from './f.ts';",
    "import json from './g.json' with { type: 'json' };", "import { from } from './from.ts';",
  ), ['1:./a.ts', '2:./b.ts', '3:./c.ts', '4:./d.ts', '5:./f.ts', '6:./g.json', '7:./from.ts']],
  ['export forms with a source and without', lines(
    "export * from './a.ts';", "export * as ns from './b.ts';", "export type * from './c.ts';", "export type * as t from './d.ts';", "export { x } from './e.ts';",
    "export type { Y } from './f.ts';", 'export { z };', 'export const w = 1;', 'export default function main() {}', 'export type T = string;',
  ), ['1:./a.ts', '2:./b.ts', '3:./c.ts', '4:./d.ts', '5:./e.ts', '6:./f.ts']],
  ['import() with a literal, a variable, a concatenation, a template, and in a type', lines(
    "const a = await import('./a.ts');", 'const b = await import(name);', "const c = await import('./c' + suffix);", 'const d = await import(`./d.ts`);',
    "type T = typeof import('./t.ts');",
  ), ['1:./a.ts', '2:null', '3:null', '4:null', '5:./t.ts']],
  ['import.meta and a method named import after ?. are not imports', lines('const u = import.meta.url;', "const v = loader?.import('../../x.ts');"), []],
];

for (const [name, source, expected] of CASES) {
  test(`scanImports: ${name}`, () => {
    assert.deepEqual(found(source), expected);
  });
}

const REGEX_AFTER = ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];

test('scanImports: after each listed punctuator and keyword a slash starts a regex that hides what it contains', () => {
  for (const before of REGEX_AFTER) {
    const source = `x ${before} /import y from '\\.\\/hidden\\.ts'/; import './seen.ts';`;
    assert.deepEqual(found(source), ['1:./seen.ts'], before);
  }
});

test('scanImports: after other tokens a slash divides, so what lies between two divisions is code', () => {
  for (const before of ['a', '1', '(a)', 'a[0]', "'s'", '`t`', '/x/g', 'a.b']) {
    assert.deepEqual(found(`const q = ${before} / b; import './a.ts'; const r = c / d;`), ['1:./a.ts'], before);
  }
});

test('scanImports: a reference carries the line of its import or export token', () => {
  assert.deepEqual(scanImports("\n\nexport {\n  a,\n} from './a.ts';\nimport {\n  b,\n} from './b.ts';"), [
    { line: 3, specifier: './a.ts' },
    { line: 6, specifier: './b.ts' },
  ]);
});

// A temporary module folder modules/m holding the given files, scanned with the given packages.
function checkIn(t: TestContext, files: Record<string, string>, packages: string[] = []): Problem[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) writeText(path.join(dir, 'modules', 'm', ...rel.split('/')), text);
  const module: ModuleInfo = {
    id: 'm', dir: 'modules/m', file: 'modules/m/module.json', contract: false, code: true, implements: [], requires: [], optional: [],
    types: {}, events: {}, operations: {}, systems: [], hosts: {}, packages,
  };
  const index: RootIndex = { repoRoot: dir, root: '.', modules: new Map([['m', module]]), types: new Map(), games: new Map(), problems: [] };
  return checkImports(index, module);
}

const where = (problems: readonly Problem[]): string[] => problems.map((p) => `${p.rule} ${p.file}:${p.line}`);

function importProblems(root: string, id: string): Problem[] {
  const index = discover(repoRoot, `${FIXTURES}/${root}`, validator);
  const module = index.modules.get(id);
  assert.ok(module, `${root} has no module ${id}`);
  return checkImports(index, module);
}

test('import-boundary root: a imports a file of b, b imports nothing', () => {
  const problems = importProblems('import-boundary', 'a');
  assert.deepEqual(where(problems), [`import-boundary ${FIXTURES}/import-boundary/modules/a/ts/index.ts:1`]);
  assert.equal(problems[0].pointer, '');
  assert.equal(problems[0].severity, 'error');
  assert.deepEqual(importProblems('import-boundary', 'b'), []);
});

test('undeclared-package root: node:fs and left-pad are reported with their lines', () => {
  assert.deepEqual(where(importProblems('undeclared-package', 'a')), [
    `undeclared-package ${FIXTURES}/undeclared-package/modules/a/ts/index.ts:1`,
    `undeclared-package ${FIXTURES}/undeclared-package/modules/a/ts/index.ts:2`,
  ]);
});

test('dynamic-import root: import(name) is reported at its line', () => {
  assert.deepEqual(where(importProblems('dynamic-import', 'a')), [`dynamic-import ${FIXTURES}/dynamic-import/modules/a/ts/index.ts:2`]);
});

test('ok-code root: no module has an import problem, also not helper.ts, which imports node:assert/strict without listing it', () => {
  for (const id of ['api', 'impl', 'user']) assert.deepEqual(importProblems('ok-code', id), [], id);
});

test('relative imports inside the module folder are allowed, also through the folder above ts/', (t) => {
  assert.deepEqual(checkIn(t, { 'ts/index.ts': "import './util.ts';\nimport '../types.gen.ts';\nimport '../data/x.json';\nexport * from '../ts/util.ts';" }), []);
});

test('relative imports that leave the module folder are import-boundary, whatever the folder they land in', (t) => {
  const problems = checkIn(t, { 'ts/index.ts': "import '../../other/x.ts';\nimport '../../../escape.ts';\nimport '../..';\nimport '../../m2/y.ts';" });
  assert.deepEqual(where(problems), [1, 2, 3, 4].map((line) => `import-boundary modules/m/ts/index.ts:${line}`));
});

test('an absolute path or a URL is import-boundary', (t) => {
  const problems = checkIn(t, { 'ts/index.ts': "import '/etc/x.ts';\nimport 'file:///x.ts';\nimport 'https://cdn.example/x.js';\nimport 'C:/x.ts';\nimport '\\\\host\\x.ts';" });
  assert.deepEqual(where(problems), [1, 2, 3, 4, 5].map((line) => `import-boundary modules/m/ts/index.ts:${line}`));
});

test('a node: built-in must be listed, and node:fs covers node:fs/promises', (t) => {
  const source = "import 'node:fs';\nimport 'node:fs/promises';\nimport 'node:path';";
  assert.deepEqual(where(checkIn(t, { 'ts/index.ts': source })), [1, 2, 3].map((line) => `undeclared-package modules/m/ts/index.ts:${line}`));
  assert.deepEqual(where(checkIn(t, { 'ts/index.ts': source }, ['node:fs'])), ['undeclared-package modules/m/ts/index.ts:3']);
});

test('a package must be listed by its name; a subpath and a scoped name count as the package', (t) => {
  const source = "import 'left-pad';\nimport 'left-pad/sub/file.js';\nimport '@scope/pkg';\nimport '@scope/pkg/sub';\nimport '@scope/other';\nimport 'fs';";
  assert.deepEqual(where(checkIn(t, { 'ts/index.ts': source }, ['left-pad', '@scope/pkg'])), [
    'undeclared-package modules/m/ts/index.ts:5',
    'undeclared-package modules/m/ts/index.ts:6',
  ]);
});

test('files under the module test/ may import node: built-ins unlisted, but not packages, and other folders may not', (t) => {
  const problems = checkIn(t, {
    'test/helper.ts': "import assert from 'node:assert/strict';\nimport 'left-pad';",
    'test/deep/more.ts': "import 'node:fs';",
    'ts/helper.ts': "import assert from 'node:assert/strict';",
    'ts/test/nested.ts': "import 'node:fs';",
    'tests/other.ts': "import 'node:fs';",
  });
  assert.deepEqual(where(problems), [
    'undeclared-package modules/m/test/helper.ts:2',
    'undeclared-package modules/m/tests/other.ts:1',
    'undeclared-package modules/m/ts/helper.ts:1',
    'undeclared-package modules/m/ts/test/nested.ts:1',
  ]);
});

test('import() with a non-literal argument is dynamic-import, a literal one is checked like an import', (t) => {
  const problems = checkIn(t, { 'ts/index.ts': "await import(name);\nawait import('./ok.ts');\nawait import('../../x.ts');" });
  assert.deepEqual(where(problems), ['dynamic-import modules/m/ts/index.ts:1', 'import-boundary modules/m/ts/index.ts:3']);
});

test('only .ts files are read, every folder is searched, and only the types.gen.ts at the module root is skipped', (t) => {
  const bad = "import 'left-pad';";
  const problems = checkIn(t, {
    'types.gen.ts': bad,
    'ts/types.gen.ts': bad,
    'ts/x.js': bad,
    'ts/x.d.ts': bad,
    'README.md': bad,
    'a/b/c/deep.ts': bad,
  });
  assert.deepEqual(where(problems), [
    'undeclared-package modules/m/a/b/c/deep.ts:1',
    'undeclared-package modules/m/ts/types.gen.ts:1',
    'undeclared-package modules/m/ts/x.d.ts:1',
  ]);
});
