// Tests for hosts/js/web/serve.ts: createServer over a temporary root, requests sent with node:http so paths reach the server raw (plan.md 4.13).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createServer } from '../serve.ts';

const WEB_DIR = path.join(import.meta.dirname, '..');
const PAGE = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
const IMPORT_MAP = '<script type="importmap">{"imports":{}}</script>';

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }

// A server on a free port over the temporary root `<temp>/site` holding `files` (path to content); both go when the test ends.
// `<temp>/secret.txt` lies next to the root, outside it.
async function serve(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const root = path.join(temp, 'site');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(temp, 'secret.txt'), 'outside the root');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const server = createServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  // The path goes out as given: no URL parsing, so `..` and `%2e%2e` reach the server.
  const request = (rawPath: string, method = 'GET', headers: OutgoingHttpHeaders = {}) => new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { temp, root, request };
}

test('a .ts file is served as text/javascript with its types removed', async (t) => {
  const source = [
    "import type { Shape } from './shape.ts';",
    'export const answer: number = 41;',
    'export function inc(n: number): number { return n + 1; }',
    'export const shape = null as Shape | null;',
    '',
  ].join('\n');
  const { temp, request } = await serve(t, { 'mods/a.ts': source });
  const reply = await request('/mods/a.ts');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'text/javascript; charset=utf-8');
  // Node does not strip types from .mjs, so this import works only when the served text has none.
  const out = path.join(temp, 'out.mjs');
  fs.writeFileSync(out, reply.body);
  const served = await import(pathToFileURL(out).href);
  assert.deepEqual([served.inc(served.answer), served.shape], [42, null]);
});

test('a .ts file with a syntax error or syntax Node cannot strip is a 500 with the message', async (t) => {
  const sources = { 'broken.ts': 'export const = ;\n', 'enum.ts': 'export enum Color { Red }\n' };
  const { request } = await serve(t, sources);
  for (const [file, source] of Object.entries(sources)) {
    let message = '';
    try {
      stripTypeScriptTypes(source);
    } catch (e) {
      message = (e as Error).message;
    }
    assert.notEqual(message, '', file);
    const reply = await request(`/${file}`);
    assert.equal(reply.status, 500, file);
    assert.equal(reply.body.toString('utf8'), message, file);
  }
});

test('index.html gets an empty import map and nothing else changes', async (t) => {
  assert.equal(PAGE.split('<!-- importmap -->').length, 2);
  const { request } = await serve(t, { 'hosts/js/web/index.html': PAGE, 'other/index.html': PAGE });
  const reply = await request('/hosts/js/web/index.html?root=examples&game=sandbox');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8');
  const html = reply.body.toString('utf8');
  assert.ok(html.includes(IMPORT_MAP));
  assert.ok(!html.includes('<!-- importmap -->'));
  assert.equal(html, PAGE.replace('<!-- importmap -->', IMPORT_MAP));
  // Only the host page is rewritten.
  assert.equal((await request('/other/index.html')).body.toString('utf8'), PAGE);
});

test('a web bundle that lists a package is a 500, one that lists none is served', async (t) => {
  const bundle = (...packages: string[][]) => JSON.stringify({
    format: 1,
    modules: packages.map((list, i) => ({ id: `m${i}`, entry: `m${i}/web/index.ts`, sees: [`m${i}`], absent: [], packages: list })),
  });
  const { request } = await serve(t, {
    'build/examples/games/pad/web/bundle.json': bundle([], ['left-pad']),
    'build/examples/games/none/web/bundle.json': bundle([]),
    'build/examples/games/builtin/web/bundle.json': bundle(['node:fs'], []),
    'build/hosts/conformance/games/pad/web/bundle.json': bundle(['@scope/left-pad']),
    'build/games/pad/web/bundle.json': bundle(['left-pad']),
    'build/games/none/web/bundle.json': bundle([]),
    'build/examples/games/pad/node/bundle.json': bundle(['left-pad']),
    'build/examples/games/broken/web/bundle.json': '{',
  });
  for (const rawPath of ['/build/examples/games/pad/web/bundle.json', '/build/hosts/conformance/games/pad/web/bundle.json', '/build/games/pad/web/bundle.json', '/build//games/pad/web/bundle.json']) {
    const reply = await request(rawPath);
    assert.equal(reply.status, 500, rawPath);
    assert.equal(reply.body.toString('utf8'), 'packages are not served by the dev server yet', rawPath);
  }
  for (const rawPath of ['/build/examples/games/none/web/bundle.json', '/build/examples/games/builtin/web/bundle.json', '/build/games/none/web/bundle.json', '/build/examples/games/pad/node/bundle.json']) {
    const reply = await request(rawPath);
    assert.equal(reply.status, 200, rawPath);
    assert.equal(reply.headers['content-type'], 'application/json', rawPath);
    assert.ok(JSON.parse(reply.body.toString('utf8')).format === 1, rawPath);
  }
  const broken = await request('/build/examples/games/broken/web/bundle.json');
  assert.equal(broken.status, 500);
  assert.notEqual(broken.body.toString('utf8'), '');
});

test('paths that climb out of the root, hold a NUL or name a file outside it are 403', async (t) => {
  const { temp, request } = await serve(t, { 'a/b.txt': 'inside' });
  const outside = '/' + path.join(temp, 'secret.txt').replaceAll('\\', '/');   // `//tmp/…` or `/C:/…`
  const rawPaths = [
    '/%2e%2e/x', '/a/../../x', '/%2E%2E/secret.txt', '/..%2fsecret.txt', '/a/%2e%2e/b.txt', '/a/..', '/..', '/a%5c..%5c..%5csecret.txt',
    '/a%5c..%5ca%5cb.txt', '/a\\..\\a\\b.txt',
    '/a%00b', '/a/b.txt%00.png', encodeURI(outside), `/${encodeURIComponent(outside.slice(1))}`,
  ];
  for (const rawPath of rawPaths) {
    const reply = await request(rawPath);
    assert.equal(reply.status, 403, rawPath);
    assert.ok(!reply.body.toString('utf8').includes('outside the root'), rawPath);
  }
  assert.equal((await request('/a/b.txt')).status, 200);
});

test('a missing file, a directory and a path below a file are 404', async (t) => {
  const { request } = await serve(t, { 'a/b.txt': 'inside' });
  for (const rawPath of ['/nothing.txt', '/a', '/a/', '/', '/a/b.txt/c', '/a/missing/b.txt', '/..a']) {
    assert.equal((await request(rawPath)).status, 404, rawPath);
  }
});

test('a malformed percent escape is a 400', async (t) => {
  const { request } = await serve(t);
  assert.equal((await request('/%E0%A4%A')).status, 400);
  assert.equal((await request('/a%zz')).status, 400);
});

test('methods other than GET and HEAD are 405 and say which are allowed', async (t) => {
  const { request } = await serve(t, { 'a.txt': 'inside' });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await request('/a.txt', method);
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.allow, 'GET, HEAD', method);
  }
});

test('a request whose Host is not 127.0.0.1 or localhost is 403', async (t) => {
  const { request } = await serve(t, { 'a.txt': 'inside' });
  for (const host of ['attacker.example', 'attacker.example:8080', '127.0.0.1.attacker.example', 'localhost.attacker.example:80']) {
    const reply = await request('/a.txt', 'GET', { host });
    assert.equal(reply.status, 403, host);
    assert.ok(!reply.body.toString('utf8').includes('inside'), host);
  }
  for (const host of ['localhost', 'LOCALHOST:8080', '127.0.0.1:1']) assert.equal((await request('/a.txt', 'GET', { host })).status, 200, host);
});

test('HEAD answers 200 with the headers of GET and no body', async (t) => {
  const { request } = await serve(t, { 'a.ts': 'export const n: number = 1;\n', 'b.json': '{"b":1}\n' });
  for (const file of ['/a.ts', '/b.json']) {
    const get = await request(file);
    const head = await request(file, 'HEAD');
    assert.equal(head.status, 200, file);
    assert.equal(head.body.length, 0, file);
    assert.ok(get.body.length > 0, file);
    assert.equal(head.headers['content-type'], get.headers['content-type'], file);
    assert.equal(head.headers['content-length'], String(get.body.length), file);
  }
  assert.equal((await request('/missing', 'HEAD')).status, 404);
});

test('other files are served as bytes with a content type by extension', async (t) => {
  const bytes = Buffer.from([0, 1, 2, 255, 254, 0]);
  const types: Record<string, string> = {
    'a.html': 'text/html; charset=utf-8',
    'a.js': 'text/javascript; charset=utf-8',
    'a.mjs': 'text/javascript; charset=utf-8',
    'a.json': 'application/json',
    'a.css': 'text/css',
    'a.png': 'image/png',
    'a.glb': 'model/gltf-binary',
    'a.gltf': 'model/gltf+json',
    'a.wav': 'audio/wav',
    'a.ogg': 'audio/ogg',
    'a.bin': 'application/octet-stream',
    'noext': 'application/octet-stream',
  };
  const { request } = await serve(t, Object.fromEntries(Object.keys(types).map((name) => [name, bytes])));
  for (const [name, type] of Object.entries(types)) {
    const reply = await request(`/${name}`);
    assert.equal(reply.status, 200, name);
    assert.equal(reply.headers['content-type'], type, name);
    assert.deepEqual(reply.body, bytes, name);
  }
});

test('node serve.ts serves the repository on 127.0.0.1 and prints its address', async (t) => {
  const repoRoot = path.resolve(WEB_DIR, '..', '..', '..');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(WEB_DIR, 'serve.ts'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')).trimEnd());
    });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
    child.on('exit', (code) => reject(new Error(`serve.ts exited with ${code}: ${err}`)));
  });
  const match = /^serving (.+) at http:\/\/127\.0\.0\.1:(\d+)\/hosts\/js\/web\/index\.html\?root=examples&game=sandbox$/.exec(line);
  assert.ok(match, line);
  assert.equal(match[1], repoRoot);
  const base = `http://127.0.0.1:${match[2]}`;
  const page = await fetch(`${base}/hosts/js/web/index.html?root=examples&game=sandbox`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(IMPORT_MAP));
  const host = await fetch(`${base}/hosts/js/web/host.ts`);
  assert.equal(host.status, 200);
  assert.equal(host.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.ok(!(await host.text()).includes('import type'));
  assert.equal((await fetch(`${base}/hosts/js/runtime.ts`)).status, 200);
});

test('node serve.ts exits 1 with the reason when the port is taken', async (t) => {
  const taken = http.createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => { taken.close(); });
  const { port } = taken.address() as AddressInfo;
  const result = spawnSync(process.execPath, [path.join(WEB_DIR, 'serve.ts'), `--port=${port}`], { encoding: 'utf8' });
  assert.deepEqual([result.status, result.stdout], [1, '']);
  assert.match(result.stderr, /EADDRINUSE/);
});

test('node serve.ts exits 2 on a bad port or an unknown option', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(WEB_DIR, 'serve.ts'), ...args], { encoding: 'utf8' });
  for (const port of ['abc', '-1', '65536', '']) {
    const result = run(`--port=${port}`);
    assert.deepEqual([result.status, result.stdout], [2, ''], port);
    assert.notEqual(result.stderr, '', port);
  }
  const unknown = run('--host', 'x');
  assert.equal(unknown.status, 2);
  assert.notEqual(unknown.stderr, '');
});
