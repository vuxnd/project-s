// Tests for hosts/python/run.ts: which Python it accepts, and what it does when there is none.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { findPython } from './run.ts';

const runTs = path.join(import.meta.dirname, 'run.ts');

interface Answer { status: number | null; stdout: string }

// A spawn stand-in that answers each candidate (its command, with -3 for py) from `answers` and records the calls.
function fakeSpawn(answers: Record<string, Answer>): { spawn: typeof spawnSync; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = (cmd: string, args: string[]): Answer => {
    calls.push([cmd, ...args]);
    return answers[args[0] === '-3' ? `${cmd} -3` : cmd] ?? { status: null, stdout: '' };
  };
  return { spawn: spawn as unknown as typeof spawnSync, calls };
}

function runWithoutPath(requireHosts: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, PATH: '', REQUIRE_HOSTS: requireHosts };
  const { status, stdout, stderr } = spawnSync(process.execPath, [runTs, '-V'], { encoding: 'utf8', env });
  return { status, stdout, stderr };
}

test('findPython rejects exit 9009 and version 3.10, and accepts 3.13', () => {
  const { spawn, calls } = fakeSpawn({
    python3: { status: 9009, stdout: '' },
    python: { status: 0, stdout: '3.10\n' },
    'py -3': { status: 0, stdout: '3.13\r\n' },
  });
  assert.deepEqual(findPython(spawn), { cmd: 'py', pre: ['-3'] });
  assert.deepEqual(calls.map((call) => call.slice(0, -1)), [
    ['python3', '-I', '-c'],
    ['python', '-I', '-c'],
    ['py', '-3', '-I', '-c'],
  ]);
});

test('findPython takes the first candidate that reports 3.11 or newer', () => {
  const { spawn, calls } = fakeSpawn({
    python3: { status: 0, stdout: '3.11\n' },
    python: { status: 0, stdout: '3.13\n' },
  });
  assert.deepEqual(findPython(spawn), { cmd: 'python3', pre: [] });
  assert.equal(calls.length, 1);
});

test('findPython returns null when no candidate runs or prints a version', () => {
  assert.equal(findPython(fakeSpawn({}).spawn), null);
  assert.equal(findPython(fakeSpawn({ python3: { status: 0, stdout: 'hello\n' } }).spawn), null);
});

test('without Python and without REQUIRE_HOSTS it prints SKIPPED and exits 0', () => {
  const r = runWithoutPath('');
  assert.equal(r.stdout.trim(), 'SKIPPED python (not found)');
  assert.equal(r.status, 0);
});

test('without Python and with REQUIRE_HOSTS=python it exits 1', () => {
  for (const requireHosts of ['python', 'node,python']) {
    const r = runWithoutPath(requireHosts);
    assert.equal(r.status, 1, requireHosts);
    assert.match(r.stderr, /python 3\.11\+ not found; REQUIRE_HOSTS requires it/);
  }
});

test('with Python it runs the arguments under -I -B and exits with its status', (t) => {
  const program = 'import sys; print(sys.flags.isolated, sys.flags.dont_write_bytecode); sys.exit(3)';
  const r = spawnSync(process.execPath, [runTs, '-c', program], { encoding: 'utf8' });
  if (r.stdout.startsWith('SKIPPED python')) {
    t.skip('python not found');
    return;
  }
  assert.equal(r.stdout.trim(), '1 1');
  assert.equal(r.status, 3);
});
