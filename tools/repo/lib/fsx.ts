// File-system and path helpers: posix repository-relative paths in, absolute paths out, sorted listings.
import fs from 'node:fs';
import path from 'node:path';

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

export function absPath(repoRoot: string, rel: string): string {
  return path.join(repoRoot, ...rel.split('/'));
}

export function relPath(repoRoot: string, abs: string): string {
  return toPosix(path.relative(repoRoot, abs));
}

export function joinPosix(...parts: string[]): string {
  return path.posix.join(...parts);
}

export function relativePosix(fromDir: string, to: string): string {
  return path.posix.relative(fromDir, to);
}

export function exists(abs: string): boolean {
  return fs.existsSync(abs);
}

export function isFile(abs: string): boolean {
  return fs.statSync(abs, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function isDir(abs: string): boolean {
  return fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function entries(abs: string): fs.Dirent[] {
  return isDir(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [];
}

export function listDirs(abs: string): string[] {
  return entries(abs).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export function listFiles(abs: string): string[] {
  return entries(abs).filter((e) => e.isFile()).map((e) => e.name).sort();
}

export function walkFiles(abs: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const e of entries(dir)) {
      if (e.isDirectory()) visit(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) found.push(`${prefix}${e.name}`);
    }
  };
  visit(abs, '');
  return found.sort();
}
