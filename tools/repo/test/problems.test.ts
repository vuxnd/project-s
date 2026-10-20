// Tests for tools/repo/lib/problems.ts: construction, printing, ordering and the error check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { error, formatProblem, hasErrors, sortProblems, warning } from '../lib/problems.ts';

test('error and warning build a problem and leave line out when it is not given', () => {
  assert.deepEqual(error('a.json', '/x', 'schema', 'bad'), { file: 'a.json', pointer: '/x', rule: 'schema', message: 'bad', severity: 'error' });
  assert.deepEqual(warning('a.json', '', 'deprecated', 'old', 7), { file: 'a.json', pointer: '', line: 7, rule: 'deprecated', message: 'old', severity: 'warning' });
  assert.ok(!('line' in error('a.json', '', 'schema', 'bad')));
});

test('formatProblem prints file#pointer without a line', () => {
  const p = error('examples/modules/audio/module.json', '/requires/0', 'require-contract', 'physics_basic implements contract physics; require physics');
  assert.equal(formatProblem(p), 'examples/modules/audio/module.json#/requires/0: physics_basic implements contract physics; require physics [require-contract]');
});

test('formatProblem prints file:line with a line', () => {
  assert.equal(formatProblem(error('a/module.json', '', 'json-parse', 'unexpected "}"', 3)), 'a/module.json:3: unexpected "}" [json-parse]');
});

test('formatProblem prefixes a warning', () => {
  assert.equal(formatProblem(warning('a/module.json', '/optional/0', 'unknown-module', 'ghost is absent')), 'warning: a/module.json#/optional/0: ghost is absent [unknown-module]');
  assert.equal(formatProblem(warning('a.ts', '', 'dynamic-import', 'x', 12)), 'warning: a.ts:12: x [dynamic-import]');
});

test('sortProblems orders by file, line, pointer, rule, message', () => {
  const sorted = sortProblems([
    error('b.json', '', 'schema', 'm'),
    error('a.json', '/z', 'schema', 'm'),
    error('a.json', '/a', 'schema', 'z'),
    error('a.json', '/a', 'schema', 'a'),
    error('a.json', '/a', 'bad-id', 'm'),
    error('a.json', '', 'json-parse', 'late', 9),
    error('a.json', '', 'json-parse', 'early', 2),
    error('a.json', '/z', 'schema', 'no line'),
  ]);
  assert.deepEqual(sorted.map((p) => `${p.file} ${p.line ?? 0} ${p.pointer} ${p.rule} ${p.message}`), [
    'a.json 0 /a bad-id m',
    'a.json 0 /a schema a',
    'a.json 0 /a schema z',
    'a.json 0 /z schema m',
    'a.json 0 /z schema no line',
    'a.json 2  json-parse early',
    'a.json 9  json-parse late',
    'b.json 0  schema m',
  ]);
});

test('sortProblems removes exact duplicates only and does not change its input', () => {
  const input = [error('a.json', '', 'schema', 'm'), warning('a.json', '', 'schema', 'm'), error('a.json', '', 'schema', 'm')];
  const sorted = sortProblems(input);
  assert.equal(sorted.length, 2);
  assert.equal(input.length, 3);
  assert.deepEqual(sorted.map((p) => p.severity).sort(), ['error', 'warning']);
});

test('hasErrors is true only when an error is present', () => {
  assert.equal(hasErrors([]), false);
  assert.equal(hasErrors([warning('a.json', '', 'deprecated', 'm')]), false);
  assert.equal(hasErrors([warning('a.json', '', 'deprecated', 'm'), error('a.json', '', 'schema', 'm')]), true);
});
