// JSON reading with exact error positions, the canonical JSON writer, comparison and RFC 6901 pointers.
import fs from 'node:fs';
import path from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Parsed = { ok: true; value: Json } | { ok: false; line: number; column: number; message: string };

// Index of the first character that makes `text` invalid JSON (text.length when it stops early), or -1 when valid.
function errorIndex(text: string): number {
  const n = text.length;
  const digit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  const stack: string[] = [];
  let i = 0;
  let state: 'value' | 'valueOrEnd' | 'key' | 'keyOrEnd' | 'colon' | 'after' = 'value';

  // Index of the offending character inside a string starting at text[i], or -1 and i just past the closing quote.
  const scanString = (): number => {
    i++;
    for (;;) {
      if (i >= n) return n;
      const c = text[i];
      if (c === '"') { i++; return -1; }
      if (c < ' ') return i;
      if (c !== '\\') { i++; continue; }
      i++;
      if (i >= n) return n;
      if ('"\\/bfnrt'.includes(text[i])) { i++; continue; }
      if (text[i] !== 'u') return i;
      i++;
      for (let k = 0; k < 4; k++, i++) {
        if (i >= n) return n;
        if (!/[0-9a-fA-F]/.test(text[i])) return i;
      }
    }
  };

  const scanNumber = (): number => {
    if (text[i] === '-') i++;
    if (i >= n) return n;
    if (text[i] === '0') i++;
    else if (digit(text[i])) while (digit(text[i])) i++;
    else return i;
    if (text[i] === '.') {
      i++;
      if (i >= n) return n;
      if (!digit(text[i])) return i;
      while (digit(text[i])) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (i >= n) return n;
      if (!digit(text[i])) return i;
      while (digit(text[i])) i++;
    }
    return -1;
  };

  const scanWord = (word: string): number => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= n) return n;
      if (text[i + k] !== word[k]) return i + k;
    }
    i += word.length;
    return -1;
  };

  for (;;) {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
    if (state === 'after' && stack.length === 0) return i < n ? i : -1;
    if (i >= n) return n;
    const c = text[i];
    let bad = -1;
    if (state === 'after') {
      const closer = stack[stack.length - 1] === '[' ? ']' : '}';
      if (c === ',') { i++; state = closer === ']' ? 'value' : 'key'; }
      else if (c === closer) { i++; stack.pop(); }
      else bad = i;
    } else if (state === 'colon') {
      if (c === ':') { i++; state = 'value'; }
      else bad = i;
    } else if (state === 'key' || state === 'keyOrEnd') {
      if (c === '}' && state === 'keyOrEnd') { i++; stack.pop(); state = 'after'; }
      else if (c === '"') { bad = scanString(); state = 'colon'; }
      else bad = i;
    } else if (c === ']' && state === 'valueOrEnd') {
      i++; stack.pop(); state = 'after';
    } else if (c === '[' || c === '{') {
      stack.push(c); i++; state = c === '[' ? 'valueOrEnd' : 'keyOrEnd';
    } else {
      if (c === '"') bad = scanString();
      else if (c === '-' || digit(c)) bad = scanNumber();
      else if (c === 't') bad = scanWord('true');
      else if (c === 'f') bad = scanWord('false');
      else if (c === 'n') bad = scanWord('null');
      else bad = i;
      state = 'after';
    }
    if (bad >= 0) return bad;
  }
}

export function parseJson(text: string): Parsed {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { ok: true, value: JSON.parse(source) as Json };
  } catch {
    const found = errorIndex(source);
    const at = found < 0 ? source.length : found;
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    const column = at - (before.lastIndexOf('\n') + 1) + 1;
    const what = at < source.length ? `unexpected ${JSON.stringify(source[at])}` : 'unexpected end of input';
    return { ok: false, line, column, message: `${what} at column ${column}` };
  }
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function format(value: unknown, indent: string, pointer: string): string {
  if (isScalar(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`cannot format ${value} at ${pointer || 'the root'}`);
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return `[${value.map((item, i) => format(item, '', joinPointer(pointer, i))).join(', ')}]`;
    return `[\n${value.map((item, i) => inner + format(item, inner, joinPointer(pointer, i))).join(',\n')}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${format(value[key], inner, joinPointer(pointer, key))}`).join(',\n')}\n${indent}}`;
  }
  throw new Error(`cannot format ${typeof value} at ${pointer || 'the root'}`);
}

export function formatJson(value: Json): string {
  return `${format(value, '', '')}\n`;
}

export function readText(abs: string): string {
  return fs.readFileSync(abs, 'utf8').replaceAll('\r\n', '\n');
}

export function readJson(abs: string): Parsed {
  return parseJson(readText(abs));
}

export function writeText(abs: string, text: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

export function writeJson(abs: string, value: Json): void {
  writeText(abs, formatJson(value));
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

export function escapePointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function joinPointer(base: string, ...tokens: (string | number)[]): string {
  return base + tokens.map((token) => `/${escapePointer(String(token))}`).join('');
}

export function getPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}
