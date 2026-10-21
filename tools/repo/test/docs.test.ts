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
  '1. Project Structure', '2. High-Level System Diagram', '3. Core Components', '4. Data Stores', '5. External Integrations / APIs',
  '6. Deployment & Infrastructure', '7. Security Considerations', '8. Development & Testing Environment',
  '9. Future Considerations / Roadmap', '10. Project Identification', '11. Glossary / Acronyms',
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
    'Skipped: `build/games/x`, `node_modules/ajv`, `https://example.invalid/x`, `http/x`, `a/<b`, `a/b>`, `a/{b`, `a/b}`, ``tools/repo/x``.',
    '```text',
    '`hosts/godot/host.json`',
    '```',
    '~~~ts',
    'const a = `hosts/js/x`;',
    '~~~',
    'Checked: `schemas/game.schema.json` and `examples/build/x`',
  ].join('\n');
  assert.deepEqual(extractPaths(md), [
    { line: 1, text: 'tools/repo/cli.ts' },
    { line: 1, text: 'hosts/' },
    { line: 10, text: 'schemas/game.schema.json' },
    { line: 10, text: 'examples/build/x' },
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
    '```shell',
    'echo not sh either',
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
    '# 2. High-Level System Diagram',
    '### 8. Development & Testing Environment',
    '## The high-level system diagram',
    '```text',
    '## 9. Future Considerations / Roadmap',
    '```',
    '## 1. project STRUCTURE',
    '## 11. glossary / acronyms, one line each',
  ].join('\n');
  assert.deepEqual(missingHeadings(md), HEADINGS.filter((name) => name !== '1. Project Structure' && name !== '11. Glossary / Acronyms'));
});

test('missingContracts reports a contract label that a schema description cites and the document lacks', () => {
  const schemaTexts = {
    'schemas/a.schema.json': JSON.stringify({ description: 'A file (contract C3 in ARCHITECTURE.md).', properties: { x: { description: 'Also contract C12.' } } }),
    'schemas/b.schema.json': JSON.stringify({ title: 'contract C7 in a title cites nothing', description: 'No label.' }),
  };
  assert.deepEqual(missingContracts('C12 only.', schemaTexts), [{ label: 'C3', file: 'schemas/a.schema.json' }]);
  assert.deepEqual(missingContracts('C30 and C12 do not name C 3.', schemaTexts), [{ label: 'C3', file: 'schemas/a.schema.json' }]);
  assert.deepEqual(missingContracts('C3 and C12.', schemaTexts), []);
  assert.deepEqual(missingContracts('C3 only.', schemaTexts), [{ label: 'C12', file: 'schemas/a.schema.json' }]);
});

test('the script prints each failure and the summary, and exits 1 when any check fails', (t) => {
  const r = runDocs(t, 'ARCHITECTURE.md', [
    '## 2. High-Level System Diagram',
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
    ...HEADINGS.filter((name) => name !== '2. High-Level System Diagram').map((name) => `${r.file}: missing heading ${name}`),
    'docs: 2 paths, 2 commands checked, 12 failures',
  ]);
});

test('the script checks headings and contract labels only in ARCHITECTURE.md, and exits 0 without failures', (t) => {
  const r = runDocs(t, 'README.md', ['See `tools/repo/docs.ts`.', '```sh', 'npm ci', 'npm run serve', '```']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'docs: 1 paths, 2 commands checked, 0 failures\n');
});

test('the script works from the repository root, validates the commands it does not run, and prints output lines and contract labels', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const rel of ['tools/repo/docs.ts', 'tools/repo/lib/fsx.ts', 'tools/repo/lib/json.ts']) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(path.resolve(import.meta.dirname, '..', '..', '..', rel), path.join(repo, rel));
  }
  const files: Record<string, string> = {
    'package.json': '{ "type": "module" }\n',
    'schemas/a.schema.json': '{ "description": "A file (contract C3 in ARCHITECTURE.md)." }\n',
    'sub/marker.txt': '',
    'sub/ok.cjs': 'process.exitCode = 0;\n',
    'sub/fail.cjs': 'for (let i = 1; i <= 25; i++) console.log(`line ${i}`);\nprocess.exitCode = 1;\n',
    'ARCHITECTURE.md': [
      ...HEADINGS.map((name) => `## ${name}`),
      'A file: `sub/marker.txt`; not a folder: `sub/marker.txt/`.',
      '```sh',
      'npm ci',
      'npm test',
      'npm run serve',
      'node sub/ok.cjs',
      'node sub/fail.cjs',
      '```',
      '',
    ].join('\n'),
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  const md = path.join(repo, 'ARCHITECTURE.md');
  const r = spawnSync(process.execPath, [path.join(repo, 'tools', 'repo', 'docs.ts'), md], { cwd: os.tmpdir(), encoding: 'utf8' });
  const file = toPosix(md);
  assert.equal(r.status, 1, r.stderr);
  // Plan 4.15 fixes no text for a command that is not valid, so lines 14 to 16 keep only their location.
  const out = r.stdout.split(/\r?\n/).filter((line) => line !== '').map((line) => line.trim().replace(/^(.*:1[4-6]): .*$/, '$1'));
  assert.deepEqual(out, [
    `${file}:12: missing path sub/marker.txt/`,
    `${file}:14`,
    `${file}:15`,
    `${file}:16`,
    `${file}:18: command failed (exit 1): node sub/fail.cjs`,
    ...Array.from({ length: 20 }, (_, i) => `line ${i + 6}`),
    `${file}: contract C3 cited by schemas/a.schema.json is not described`,
    'docs: 2 paths, 5 commands checked, 6 failures',
  ]);
});

test('the script without a file prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.notEqual(r.stderr, '');
});
