// Dev server for the web host (plan.md 4.13): serves the repository over HTTP, strips types from .ts files, puts an empty import map in the page.
import fs from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { relPath } from '../../../tools/repo/lib/fsx.ts';

const JAVASCRIPT = 'text/javascript; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': JAVASCRIPT,
  '.mjs': JAVASCRIPT,
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const PAGE = 'hosts/js/web/index.html';
const IMPORT_MAP = '<script type="importmap">{"imports":{}}</script>';
const WEB_BUNDLE = /^build\/(?:.+\/)?games\/[^/]+\/web\/bundle\.json$/;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A bundle lists a package when any module names one that is not a node: built-in.
function listsPackage(bundle: unknown): boolean {
  const { modules } = bundle as { modules: { packages: string[] }[] };
  return modules.some((m) => m.packages.some((name) => !name.startsWith('node:')));
}

// The file a request names, or the status that refuses it. The path is decoded first, so `%2e%2e` counts as `..`.
function locate(root: string, url: string): { abs: string } | { status: number } {
  const query = url.indexOf('?');
  let pathname: string;
  try {
    pathname = decodeURIComponent(query < 0 ? url : url.slice(0, query));
  } catch {
    return { status: 400 };
  }
  if (!pathname.startsWith('/')) return { status: 400 };
  if (pathname.includes('\0') || pathname.split(/[/\\]/).includes('..')) return { status: 403 };
  const abs = path.resolve(root, pathname.slice(1));   // `//etc/passwd` becomes an absolute path here
  const rel = relPath(root, abs);
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return { status: 403 };
  return { abs };
}

function reply(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);   // Node sends no body for HEAD
}

function handle(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(res, 405, TEXT, http.STATUS_CODES[405] as string);
  }
  const found = locate(root, req.url ?? '');
  if ('status' in found) return reply(res, found.status, TEXT, http.STATUS_CODES[found.status] as string);
  if (!fs.statSync(found.abs, { throwIfNoEntry: false })?.isFile()) return reply(res, 404, TEXT, http.STATUS_CODES[404] as string);
  const rel = relPath(root, found.abs);
  const ext = path.extname(found.abs).toLowerCase();
  if (ext === '.ts') return reply(res, 200, JAVASCRIPT, stripTypeScriptTypes(fs.readFileSync(found.abs, 'utf8')));
  if (rel === PAGE) return reply(res, 200, TYPES['.html'], fs.readFileSync(found.abs, 'utf8').replace('<!-- importmap -->', () => IMPORT_MAP));
  const body = fs.readFileSync(found.abs);
  if (WEB_BUNDLE.test(rel) && listsPackage(JSON.parse(body.toString('utf8')))) {
    return reply(res, 500, TEXT, 'packages are not served by the dev server yet');
  }
  return reply(res, 200, TYPES[ext] ?? 'application/octet-stream', body);
}

export function createServer(options: { root: string }): http.Server {
  const root = path.resolve(options.root);
  return http.createServer((req, res) => {
    try {
      handle(root, req, res);
    } catch (e) {
      reply(res, 500, TEXT, messageOf(e));   // a syntax error in a .ts file or a bundle that is not JSON
    }
  });
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { port: { type: 'string' } }, strict: true });
    const port = values.port ?? '8080';
    if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error(`bad port: ${port}`);
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const server = createServer({ root });
    server.on('error', (e) => {
      console.error(`serve: ${e.message}`);
      process.exitCode = 1;
    });
    server.listen(Number(port), '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      console.log(`serving ${root} at http://127.0.0.1:${bound}/hosts/js/web/index.html?root=examples&game=sandbox`);
    });
  } catch (e) {
    console.error(`serve: ${messageOf(e)}`);
    process.exitCode = 2;
  }
}
