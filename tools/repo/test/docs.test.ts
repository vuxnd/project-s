// Tests for tools/repo/docs.ts: the spans, commands, headings and contract labels it reads, and what the script prints.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { extractCommands, extractPaths, missingContracts, missingHeadings } from '../docs.ts';
import { toPosix } from '../lib/fsx.ts';

const script = path.resolve(import.meta.dirname, '..', 'docs.ts');
const HEADINGS = [
  'Repository structure', 'Principles', 'Major systems', 'Module boundaries', 'Data flows', 'Extension mechanisms',
  'Technology integration', 'Backward compatibility', 'Dependency management', 'Testing', 'Deferred', 'Decisions',
];

// Writes lines to <temporary dir>/<name> and runs the script on that file.
function runDocs(t: TestContext, name: string, lines: string[]): { file: string; status: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { file: toPosix(file), status, stdout, stderr };
}

test('extractPaths returns the single-backtick spans outside fenced blocks that name a path', () => {
  const md = [
    'Checked: `tools/repo/cli.ts`, `hosts/` and `README.md`, which has no slash.',
    'Skipped: `<root>/modules/<id>/`, `examples/*/x`, `a/{b,c}`, `npm run build -- x --root a/b`, `node:fs/promises`.',
    'Skipped: `build/games/x`, `node_modules/ajv`, `https://example.invalid/x`, ``tools/repo/x``.',
    '```text',
    '`hosts/godot/host.json`',
    '```',
    '~~~ts',
    'const a = `hosts/js/x`;',
    '~~~',
    'Checked: `schemas/game.schema.json`',
  ].join('\n');
  assert.deepEqual(extractPaths(md), [
    { line: 1, text: 'tools/repo/cli.ts' },
    { line: 1, text: 'hosts/' },
    { line: 10, text: 'schemas/game.schema.json' },
  ]);
});

test('extractCommands returns the lines of sh blocks and marks npm ci, npm test and npm run serve as not run', () => {
  const md = [
    '```sh',
    'npm ci',
    'npm run check',
    '',
    'npm test',
    '```',
    '```text',
    'npm run nothing',
    '```',
    '```bash',
    'echo not sh',
    '```',
    '```sh',
    'npm run serve',
    'node tools/repo/cli.ts traces --host node --root examples',
    '```',
  ].join('\n');
  assert.deepEqual(extractCommands(md), [
    { line: 2, text: 'npm ci', run: false },
    { line: 3, text: 'npm run check', run: true },
    { line: 5, text: 'npm test', run: false },
    { line: 14, text: 'npm run serve', run: false },
    { line: 15, text: 'node tools/repo/cli.ts traces --host node --root examples', run: true },
  ]);
});

test('missingHeadings names each required heading that no ## heading starts with, ignoring case', () => {
  assert.deepEqual(missingHeadings(HEADINGS.map((name) => `## ${name.toUpperCase()}, and more`).join('\n')), []);
  const md = [
    '# Principles',
    '### Testing',
    '```text',
    '## Deferred',
    '```',
    '## repository STRUCTURE',
    '## Decisions, one line each',
  ].join('\n');
  assert.deepEqual(missingHeadings(md), HEADINGS.filter((name) => name !== 'Repository structure' && name !== 'Decisions'));
});

test('missingContracts reports a contract label that a schema description cites and the document lacks', () => {
  const schemaTexts = {
    'schemas/a.schema.json': JSON.stringify({ description: 'A file (contract C3 in ARCHITECTURE.md).', properties: { x: { description: 'Also contract C12.' } } }),
    'schemas/b.schema.json': JSON.stringify({ title: 'contract C7 in a title cites nothing', description: 'No label.' }),
  };
  assert.deepEqual(missingContracts('C12 only.', schemaTexts), [{ label: 'C3', file: 'schemas/a.schema.json' }]);
  assert.deepEqual(missingContracts('C30 and C12 do not name C 3.', schemaTexts), [{ label: 'C3', file: 'schemas/a.schema.json' }]);
  assert.deepEqual(missingContracts('C3 and C12.', schemaTexts), []);
});

test('the script prints each failure and the summary, and exits 1 when any check fails', (t) => {
  const r = runDocs(t, 'ARCHITECTURE.md', [
    '## Principles',
    'Exists: `tools/repo/docs.ts`; missing: `tools/repo/nothing.ts`.',
    '```sh',
    'node -e "process.exit(3)"',
    'npm test',
    '```',
    'Labels: C1 C2 C3 C4 C5 C6 C7 C8 C9 C10.',
  ]);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((line) => line !== ''), [
    `${r.file}:2: missing path tools/repo/nothing.ts`,
    `${r.file}:4: command failed (exit 3): node -e "process.exit(3)"`,
    ...HEADINGS.filter((name) => name !== 'Principles').map((name) => `${r.file}: missing heading ${name}`),
    'docs: 2 paths, 2 commands checked, 13 failures',
  ]);
});

test('the script checks headings and contract labels only in ARCHITECTURE.md, and exits 0 without failures', (t) => {
  const r = runDocs(t, 'README.md', ['See `tools/repo/docs.ts`.', '```sh', 'npm ci', 'npm run serve', '```']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'docs: 1 paths, 2 commands checked, 0 failures\n');
});

test('the script without a file prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'usage: node tools/repo/docs.ts <file.md>...\n');
});
