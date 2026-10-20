// Tests for tools/repo/cli.ts: usage, help, unknown commands, and how it runs a command file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const toolDir = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/repo/cli.ts <command> [options]';

function runCli(cli: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status, stdout, stderr };
}

// A copy of cli.ts and fsx.ts in a temporary repository with the given command files.
function copyCli(t: TestContext, commands: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.mkdirSync(path.join(dir, 'tools', 'repo', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(toolDir, 'cli.ts'), path.join(dir, 'tools', 'repo', 'cli.ts'));
  fs.copyFileSync(path.join(toolDir, 'lib', 'fsx.ts'), path.join(dir, 'tools', 'repo', 'lib', 'fsx.ts'));
  fs.mkdirSync(path.join(dir, 'tools', 'repo', 'commands'));
  for (const [name, source] of Object.entries(commands)) fs.writeFileSync(path.join(dir, 'tools', 'repo', 'commands', `${name}.ts`), source);
  return path.join(dir, 'tools', 'repo', 'cli.ts');
}

test('no argument prints usage on stderr and exits 2', () => {
  const r = runCli(path.join(toolDir, 'cli.ts'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith(USAGE), r.stderr);
  assert.equal(r.stdout, '');
});

test('help prints usage on stdout and exits 0', () => {
  const r = runCli(path.join(toolDir, 'cli.ts'), 'help');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith(USAGE), r.stdout);
  assert.equal(r.stderr, '');
});

test('an unknown command prints its name and usage on stderr and exits 2', () => {
  const r = runCli(path.join(toolDir, 'cli.ts'), 'nope');
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith(`unknown command: nope\n${USAGE}`), r.stderr);
  assert.equal(r.stdout, '');
});

test('a command name that is a path is unknown, not imported', () => {
  const r = runCli(path.join(toolDir, 'cli.ts'), '../lib/json');
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith('unknown command: ../lib/json\n'), r.stderr);
});

test('usage lists one sorted line per command file', (t) => {
  const cli = copyCli(t, {
    zeta: "export const summary = 'Last command.';\nexport function run() { return 0; }\n",
    alpha: "export const summary = 'First command.';\nexport function run() { return 0; }\n",
  });
  const r = runCli(cli, 'help');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${USAGE}\nalpha  First command.\nzeta  Last command.\n`);
});

test('a command runs with its arguments and the repository root, and its result is the exit code', (t) => {
  const cli = copyCli(t, {
    demo: [
      "export const summary = 'Echo.';",
      'export async function run(args: string[], repoRoot: string): Promise<number> {',
      '  console.log(JSON.stringify({ args, repoRoot }));',
      '  return 3;',
      '}',
      '',
    ].join('\n'),
  });
  const r = runCli(cli, 'demo', '--root', 'a b');
  assert.equal(r.status, 3);
  const printed = JSON.parse(r.stdout) as { args: string[]; repoRoot: string };
  assert.deepEqual(printed.args, ['--root', 'a b']);
  assert.equal(fs.realpathSync(printed.repoRoot), fs.realpathSync(path.resolve(path.dirname(cli), '..', '..')));
});

test('an exception in a command prints internal error with the stack and exits 1', (t) => {
  const cli = copyCli(t, {
    boom: "export const summary = 'Throws.';\nexport function run(): number { throw new Error('kaboom'); }\n",
  });
  const r = runCli(cli, 'boom');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith('internal error: Error: kaboom\n'), r.stderr);
});
