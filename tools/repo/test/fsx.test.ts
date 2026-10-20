// Tests for tools/repo/lib/fsx.ts: posix path helpers and the sorted directory listings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { absPath, exists, isDir, isFile, joinPosix, listDirs, listFiles, relPath, relativePosix, toPosix, walkFiles } from '../lib/fsx.ts';

function tempTree(t: TestContext, files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    const abs = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file);
  }
  return dir;
}

test('toPosix turns every backslash into a slash', () => {
  assert.equal(toPosix('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(toPosix('a/b'), 'a/b');
});

test('absPath, relPath and joinPosix', (t) => {
  const root = tempTree(t, []);
  assert.equal(absPath(root, 'a/b/c.json'), path.join(root, 'a', 'b', 'c.json'));
  assert.equal(absPath(root, '.'), path.normalize(root));
  assert.equal(relPath(root, absPath(root, 'a/b/c.json')), 'a/b/c.json');
  assert.equal(joinPosix('build', '.', 'traces'), 'build/traces');
  assert.equal(joinPosix('.', 'modules'), 'modules');
});

test('relativePosix gives the path from one repository folder to a file', () => {
  assert.equal(relativePosix('examples/modules/physics', 'schemas/module.schema.json'), '../../../schemas/module.schema.json');
  assert.equal(relativePosix('.', 'schemas/module.schema.json'), 'schemas/module.schema.json');
  assert.equal(relativePosix('games/demo', 'games/demo/game.json'), 'game.json');
});

test('exists, isFile and isDir tell files, folders and nothing apart', (t) => {
  const root = tempTree(t, ['a/one.txt']);
  assert.deepEqual([exists(path.join(root, 'a')), isDir(path.join(root, 'a')), isFile(path.join(root, 'a'))], [true, true, false]);
  assert.deepEqual([exists(path.join(root, 'a', 'one.txt')), isDir(path.join(root, 'a', 'one.txt')), isFile(path.join(root, 'a', 'one.txt'))], [true, false, true]);
  assert.deepEqual([exists(path.join(root, 'none')), isDir(path.join(root, 'none')), isFile(path.join(root, 'none'))], [false, false, false]);
});

test('listDirs and listFiles list direct entries in sorted order', (t) => {
  const root = tempTree(t, ['z.txt', 'm.txt', 'b/x.txt', 'a/sub/y.txt', 'a/w.txt']);
  assert.deepEqual(listDirs(root), ['a', 'b']);
  assert.deepEqual(listFiles(root), ['m.txt', 'z.txt']);
  assert.deepEqual(listFiles(path.join(root, 'a')), ['w.txt']);
});

test('listings of a missing folder or of a file are empty', (t) => {
  const root = tempTree(t, ['one.txt']);
  for (const abs of [path.join(root, 'none'), path.join(root, 'one.txt')]) {
    assert.deepEqual([listDirs(abs), listFiles(abs), walkFiles(abs)], [[], [], []]);
  }
});

test('walkFiles lists every file below a folder as sorted posix paths', (t) => {
  const root = tempTree(t, ['top.txt', 'a/b/deep.txt', 'a/mid.txt', 'a.txt', 'c/x.txt']);
  assert.deepEqual(walkFiles(root), ['a.txt', 'a/b/deep.txt', 'a/mid.txt', 'c/x.txt', 'top.txt']);
  assert.deepEqual(walkFiles(path.join(root, 'a')), ['b/deep.txt', 'mid.txt']);
});

test('listings use JavaScript default string order, not file-system or locale order', (t) => {
  const root = tempTree(t, ['alpha/x.txt', 'Zed/x.txt', '_u/x.txt', 'Beta/x.txt', 'b.txt', 'B1.txt', '_a.txt', 'Z.txt']);
  assert.deepEqual(listDirs(root), ['Beta', 'Zed', '_u', 'alpha']);
  assert.deepEqual(listFiles(root), ['B1.txt', 'Z.txt', '_a.txt', 'b.txt']);
  assert.deepEqual(walkFiles(root), ['B1.txt', 'Beta/x.txt', 'Z.txt', 'Zed/x.txt', '_a.txt', '_u/x.txt', 'alpha/x.txt', 'b.txt']);
});
