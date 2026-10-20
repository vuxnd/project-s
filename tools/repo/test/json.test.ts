// Tests for tools/repo/lib/json.ts: parse positions, the canonical writer, equality and RFC 6901 pointers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { escapePointer, formatJson, getPointer, isObject, joinPointer, jsonEqual, parseJson, readJson, readText, writeJson, writeText } from '../lib/json.ts';
import type { Json } from '../lib/json.ts';

function failure(text: string): { line: number; column: number; message: string } {
  const parsed = parseJson(text);
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(text)} to be invalid`);
  if (parsed.ok) throw new Error('unreachable');
  return { line: parsed.line, column: parsed.column, message: parsed.message };
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseJson returns the value of valid text', () => {
  assert.deepEqual(parseJson('{"a": [1, 2.5, "x", null, true]}'), { ok: true, value: { a: [1, 2.5, 'x', null, true] } });
  assert.deepEqual(parseJson(' \n\t42 \r\n'), { ok: true, value: 42 });
  assert.deepEqual(parseJson('{"__proto__": 1}'), { ok: true, value: JSON.parse('{"__proto__": 1}') });
});

test('parseJson strips one leading BOM', () => {
  assert.deepEqual(parseJson('﻿{"a":1}'), { ok: true, value: { a: 1 } });
  const bom = failure('﻿[');
  assert.deepEqual([bom.line, bom.column], [1, 2]);
});

test('parseJson position: a value is missing in the middle of the text', () => {
  const f = failure('{\n  "a": 1,\n  "b": }');
  assert.deepEqual([f.line, f.column], [3, 8]);
  assert.equal(f.message, 'unexpected "}" at column 8');
});

test('parseJson position: the text stops early', () => {
  const f = failure('[1, 2');
  assert.deepEqual([f.line, f.column], [1, 6]);
  assert.equal(f.message, 'unexpected end of input at column 6');
});

test('parseJson position: empty text', () => {
  const f = failure('');
  assert.deepEqual([f.line, f.column], [1, 1]);
});

test('parseJson position: a trailing comma', () => {
  const f = failure('{"a": 1,}');
  assert.deepEqual([f.line, f.column], [1, 9]);
});

test('parseJson position: other first offending characters', () => {
  const cases: [string, number, number][] = [
    ['tru', 1, 4],
    ['trux', 1, 4],
    ['nul1', 1, 4],
    ['01', 1, 2],
    ['-', 1, 2],
    ['-x', 1, 2],
    ['1.', 1, 3],
    ['1.e5', 1, 3],
    ['1e', 1, 3],
    ['1e+', 1, 4],
    ['1 2', 1, 3],
    ['[1 2]', 1, 4],
    ['[1,]', 1, 4],
    ['{"a" 1}', 1, 6],
    ['{"a"}', 1, 5],
    ['{a: 1}', 1, 2],
    ['{1: 1}', 1, 2],
    ["{'a': 1}", 1, 2],
    ['"abc', 1, 5],
    ['"a\nb"', 1, 3],
    ['"\\x"', 1, 3],
    ['"\\u12g4"', 1, 6],
    ['"\\u12', 1, 6],
    ['{"a": 1} x', 1, 10],
    [']', 1, 1],
    ['[1]]', 1, 4],
    ['{"a": [1, {"b": }]}', 1, 17],
  ];
  for (const [text, line, column] of cases) {
    const f = failure(text);
    assert.deepEqual([f.line, f.column], [line, column], JSON.stringify(text));
  }
});

test('parseJson counts lines on LF and CRLF', () => {
  const f = failure('[1,\r\n2,\r\n]');
  assert.deepEqual([f.line, f.column], [3, 1]);
});

test('parseJson reports a deeply nested valid document without recursion errors', () => {
  const depth = 20000;
  assert.equal(parseJson('['.repeat(depth) + ']'.repeat(depth)).ok, true);
  const f = failure('['.repeat(depth));
  assert.deepEqual([f.line, f.column], [1, depth + 1]);
});

test('readText turns CRLF into LF and readJson parses it', (t) => {
  const file = path.join(tempDir(t), 'crlf.json');
  fs.writeFileSync(file, '{\r\n  "a": 1\r\n}\r\n');
  assert.equal(readText(file), '{\n  "a": 1\n}\n');
  assert.deepEqual(readJson(file), { ok: true, value: { a: 1 } });
});

test('writeText creates parent folders and writeJson writes formatJson text', (t) => {
  const file = path.join(tempDir(t), 'a', 'b', 'out.json');
  writeText(path.join(path.dirname(file), 'note.txt'), 'hello\n');
  assert.equal(readText(path.join(path.dirname(file), 'note.txt')), 'hello\n');
  const value = { size: [1, 2], list: [{ a: 1 }], empty: {} };
  writeJson(file, value);
  assert.equal(fs.readFileSync(file, 'utf8'), formatJson(value));
  assert.deepEqual(readJson(file), { ok: true, value });
});

test('formatJson writes the canonical layout of the plan example', () => {
  const text = formatJson({ size: [1, 1, 1], list: [{ a: 1 }], empty: {} });
  assert.equal(text, ['{', '  "size": [1, 1, 1],', '  "list": [', '    {', '      "a": 1', '    }', '  ],', '  "empty": {}', '}', ''].join('\n'));
});

test('formatJson writes scalars, empty containers and nested arrays', () => {
  assert.equal(formatJson(null), 'null\n');
  assert.equal(formatJson('a"b\n'), '"a\\"b\\n"\n');
  assert.equal(formatJson(-0), '0\n');
  assert.equal(formatJson([]), '[]\n');
  assert.equal(formatJson({}), '{}\n');
  assert.equal(formatJson([null, true, 1.5, 'x']), '[null, true, 1.5, "x"]\n');
  assert.equal(formatJson([[1, 2], [3]]), '[\n  [1, 2],\n  [3]\n]\n');
  assert.equal(formatJson({ b: [], a: { c: [{}] } }), '{\n  "b": [],\n  "a": {\n    "c": [\n      {}\n    ]\n  }\n}\n');
});

test('formatJson keeps insertion order and round-trips through parseJson', () => {
  const value: Json = { z: 1, a: { y: [1, { k: 'v' }, [2, 3]], x: null }, m: 'text' };
  const text = formatJson(value);
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ['z', 'a', 'm']);
  assert.deepEqual(parseJson(text), { ok: true, value });
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
});

test('formatJson throws on NaN, infinities, undefined and functions, naming where', () => {
  assert.throws(() => formatJson(NaN), /cannot format NaN/);
  assert.throws(() => formatJson(Infinity), /cannot format Infinity/);
  assert.throws(() => formatJson([-Infinity]), /cannot format -Infinity at \/0/);
  assert.throws(() => formatJson(undefined as unknown as Json), /cannot format undefined/);
  assert.throws(() => formatJson({ a: [1, { b: undefined }] } as unknown as Json), /cannot format undefined at \/a\/1\/b/);
  assert.throws(() => formatJson([undefined] as unknown as Json), /cannot format undefined at \/0/);
  assert.throws(() => formatJson({ f: () => 1 } as unknown as Json), /cannot format function at \/f/);
});

test('isObject accepts objects only', () => {
  assert.deepEqual([{}, { a: 1 }].map(isObject), [true, true]);
  assert.deepEqual([null, [], 'x', 1, true, undefined].map(isObject), [false, false, false, false, false, false]);
});

test('jsonEqual compares numbers, booleans and strings by value', () => {
  assert.ok(jsonEqual(1, 1));
  assert.ok(jsonEqual(0, -0));
  assert.ok(jsonEqual('a', 'a'));
  assert.ok(jsonEqual(null, null));
  assert.ok(!jsonEqual(1, 2));
  assert.ok(!jsonEqual(1, true));
  assert.ok(!jsonEqual(0, false));
  assert.ok(!jsonEqual(true, false));
  assert.ok(!jsonEqual('1', 1));
  assert.ok(!jsonEqual(null, 0));
});

test('jsonEqual compares arrays elementwise and objects by keys without order', () => {
  assert.ok(jsonEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]]));
  assert.ok(!jsonEqual([1, 2], [2, 1]));
  assert.ok(!jsonEqual([1], [1, 2]));
  assert.ok(jsonEqual({ a: 1, b: [true] }, { b: [true], a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!jsonEqual({ a: 1, b: 2 }, { a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { b: 1 }));
  assert.ok(!jsonEqual({ a: undefined }, { b: undefined }));
  assert.ok(!jsonEqual({}, []));
  assert.ok(!jsonEqual([], {}));
  assert.ok(!jsonEqual({ a: true }, { a: 1 }));
});

test('escapePointer and joinPointer escape ~ and /', () => {
  assert.equal(escapePointer('a/b~c'), 'a~1b~0c');
  assert.equal(escapePointer('~1'), '~01');
  assert.equal(joinPointer(''), '');
  assert.equal(joinPointer('', 'a/b', 0, 'x~'), '/a~1b/0/x~0');
  assert.equal(joinPointer('/base', 'k'), '/base/k');
});

test('getPointer follows RFC 6901', () => {
  const value = { 'a/b': { '~': [10, 20, { z: 'deep' }] }, '': { empty: 1 }, list: [[1, 2], [3]] };
  assert.equal(getPointer(value, ''), value);
  assert.equal(getPointer(value, '/a~1b/~0/1'), 20);
  assert.equal(getPointer(value, '/a~1b/~0/2/z'), 'deep');
  assert.equal(getPointer(value, '//empty'), 1);
  assert.equal(getPointer(value, '/list/1/0'), 3);
  assert.deepEqual(getPointer(value, '/list/0'), [1, 2]);
  assert.equal(getPointer({ '~1': 'tilde-one', '/': 'slash' }, '/~01'), 'tilde-one');
});

test('getPointer returns undefined for a missing step', () => {
  const value = { a: [1, 2], s: 'text', n: null };
  for (const pointer of ['/missing', '/a/2', '/a/-', '/a/01', '/a/x', '/a/1/0', '/s/0', '/n/x', 'a', '/a~2', '/toString', '/__proto__']) {
    assert.equal(getPointer(value, pointer), undefined, pointer);
  }
  assert.equal(getPointer(undefined, '/a'), undefined);
});
