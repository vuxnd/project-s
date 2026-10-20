// Tests for package.json and the repository's test layout: script quoting, exact pins, test globs (D42, D59).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isObject, readJson, readText } from '../lib/json.ts';
import type { JsonObject } from '../lib/json.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function readPackage(): JsonObject {
  const parsed = readJson(path.join(repoRoot, 'package.json'));
  assert.ok(parsed.ok && isObject(parsed.value), 'package.json must be a JSON object');
  return parsed.value;
}

function stringMap(value: unknown): Record<string, string> {
  assert.ok(isObject(value), 'expected an object');
  for (const [key, entry] of Object.entries(value)) assert.equal(typeof entry, 'string', key);
  return value as Record<string, string>;
}

// Test files below the repository root, as posix paths; skips folders that hold no repository code.
function testFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const skipped = entry.name === 'node_modules' || entry.name === '.git' || (prefix === '' && (entry.name === 'build' || entry.name === '.claude'));
      if (!skipped) found.push(...testFiles(path.join(dir, entry.name), `${rel}/`));
    } else if (entry.name.endsWith('.test.ts')) {
      found.push(rel);
    }
  }
  return found.sort();
}

// The directories named by the double-quoted globs of the node --test command at the start of test:unit.
function testDirs(): string[] {
  const unit = stringMap(readPackage().scripts)['test:unit'];
  assert.ok(unit, 'package.json needs a test:unit script');
  const command = unit.split('&&')[0];
  assert.ok(command.trim().startsWith('node --test '), command);
  const globs = [...command.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  assert.ok(globs.length > 0, 'test:unit passes no double-quoted globs');
  return globs.map((glob) => {
    const match = /^([a-z][a-z0-9_-]*)\/\*\*\/\*\.test\.ts$/.exec(glob);
    assert.ok(match, `glob ${glob} is not <dir>/**/*.test.ts`);
    return match[1];
  });
}

test('no script contains a single quote, because cmd.exe does not treat it as a quote', () => {
  for (const [name, script] of Object.entries(stringMap(readPackage().scripts))) {
    assert.ok(!script.includes("'"), `${name}: ${script}`);
  }
});

test('every devDependencies version is exact and the three pins are present', () => {
  const dev = stringMap(readPackage().devDependencies);
  for (const [name, version] of Object.entries(dev)) assert.match(version, /^\d+\.\d+\.\d+$/, name);
  assert.equal(dev.typescript, '7.0.2');
  assert.equal(dev['@types/node'], '24.19.2');
  assert.equal(dev.ajv, '8.20.0');
});

test('package.json has no dependencies and no workspaces', () => {
  const pkg = readPackage();
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.workspaces, undefined);
});

test('package.json is a private ES module package with the devEngines of the plan', () => {
  const pkg = readPackage();
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.devEngines, { runtime: { name: 'node', version: '>=24.12.0', onFail: 'error' } });
});

test('.npmrc saves exact versions', () => {
  assert.match(readText(path.join(repoRoot, '.npmrc')), /^save-exact=true$/m);
});

test('.node-version names Node 24', () => {
  assert.equal(readText(path.join(repoRoot, '.node-version')).trim(), '24');
});

test('test:unit passes only <dir>/**/*.test.ts globs to node --test', () => {
  assert.ok(testDirs().length > 0);
});

test('every *.test.ts file in the repository lies under a directory test:unit globs', () => {
  const dirs = testDirs();
  const fixtures = 'tools/repo/test/fixtures/';
  for (const file of testFiles(repoRoot).filter((f) => !f.startsWith(fixtures))) {
    assert.ok(dirs.some((dir) => file.startsWith(`${dir}/`)), `${file} is outside ${dirs.join(', ')}`);
  }
});

test('no *.test.ts file lies under tools/repo/test/fixtures/', () => {
  const fixtures = 'tools/repo/test/fixtures/';
  assert.deepEqual(testFiles(repoRoot).filter((f) => f.startsWith(fixtures)), []);
});
