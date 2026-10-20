// Finds the imports in a module's TypeScript files and checks them against the module folder and its packages.
import path from 'node:path';
import type { ModuleInfo, RootIndex } from './discover.ts';
import { absPath, walkFiles } from './fsx.ts';
import { readText } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';

export interface ImportRef { line: number; specifier: string | null }   // null: import() with a non-literal argument

interface Token { kind: 'id' | 'str' | 'punct' | 'other'; value: string; line: number }

// After one of these a / starts a regular expression; after anything else it divides.
const REGEX_AFTER_PUNCT = ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'];
const REGEX_AFTER_WORD = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];

// Comments are dropped; a string, a template and a regular expression are one token each, and code inside ${ } is tokenized as code.
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const outer: number[] = [];   // brace depth of the code around each open ${
  let depth = 0;                // unclosed { in the code being read
  let line = 1;
  let i = 0;

  const regexAllowed = (): boolean => {
    const prev = tokens.at(-1);
    if (prev === undefined) return true;
    if (prev.kind === 'punct') return REGEX_AFTER_PUNCT.includes(prev.value);
    return prev.kind === 'id' && REGEX_AFTER_WORD.includes(prev.value);
  };

  // At a backslash: skips it and the character it escapes.
  const skipEscape = (): void => {
    if (source[i + 1] === '\n') line++;
    i += 2;
  };

  // Template text from i up to the closing backtick (one token) or up to a ${ (code resumes).
  const templateText = (): void => {
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        skipEscape();
      } else if (c === '`') {
        i++;
        tokens.push({ kind: 'other', value: 'template', line });
        return;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        outer.push(depth);
        depth = 0;
        return;
      } else {
        if (c === '\n') line++;
        i++;
      }
    }
  };

  // A string ends at its closing quote or at the end of its line.
  const stringToken = (quote: string): void => {
    const start = line;
    let value = '';
    i++;
    while (i < source.length && source[i] !== quote && source[i] !== '\n') {
      if (source[i] === '\\') {
        if (source[i + 1] !== '\n') value += source.charAt(i + 1);
        skipEscape();
      } else {
        value += source[i++];
      }
    }
    if (source[i] === quote) i++;
    tokens.push({ kind: 'str', value, line: start });
  };

  // A regular expression ends at the next / outside a [ ] class on its line, then come its flags.
  const regexToken = (): void => {
    let inClass = false;
    i++;
    while (i < source.length && source[i] !== '\n') {
      const c = source[i];
      if (c === '\\' && source[i + 1] !== '\n') {
        i += 2;
        continue;
      }
      if (c === '/' && !inClass) break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      i++;
    }
    if (source[i] === '/') i++;
    while (/[A-Za-z]/.test(source.charAt(i))) i++;
    tokens.push({ kind: 'other', value: 'regex', line });
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\n') {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += source.slice(i, stop).split('\n').length - 1;
      i = stop;
    } else if (c === '"' || c === "'") {
      stringToken(c);
    } else if (c === '`') {
      i++;
      templateText();
    } else if (c === '/' && regexAllowed()) {
      regexToken();
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (/[\w$]/.test(source.charAt(i))) i++;
      tokens.push({ kind: 'id', value: source.slice(start, i), line });
    } else if (/[0-9]/.test(c)) {
      while (/[\w.]/.test(source.charAt(i))) i++;
      tokens.push({ kind: 'other', value: 'number', line });
    } else if (c === '}' && depth === 0 && outer.length > 0) {
      depth = outer.pop() as number;
      i++;
      templateText();
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      tokens.push({ kind: 'punct', value: c, line });
      i++;
    }
  }
  return tokens;
}

export function scanImports(source: string): ImportRef[] {
  const tokens = tokenize(source);
  const refs: ImportRef[] = [];
  const isPunct = (token: Token | undefined, value: string): boolean => token?.kind === 'punct' && token.value === value;
  // The string after the first `from` that is directly followed by a string, looking no further than the next ;
  const specifierAfter = (from: number): string | null => {
    for (let k = from; k < tokens.length; k++) {
      if (isPunct(tokens[k], ';')) return null;
      if (tokens[k].kind === 'id' && tokens[k].value === 'from' && tokens[k + 1]?.kind === 'str') return tokens[k + 1].value;
    }
    return null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.kind !== 'id' || isPunct(tokens[k - 1], '.')) continue;
    const next = tokens[k + 1];
    if (token.value === 'import') {
      if (isPunct(next, '.')) continue;   // import.meta
      if (isPunct(next, '(')) {
        const argument = tokens[k + 2];
        refs.push({ line: token.line, specifier: argument?.kind === 'str' && isPunct(tokens[k + 3], ')') ? argument.value : null });
      } else if (next?.kind === 'str') {
        refs.push({ line: token.line, specifier: next.value });
      } else {
        const specifier = specifierAfter(k + 1);
        if (specifier !== null) refs.push({ line: token.line, specifier });
      }
    } else if (token.value === 'export') {
      const second = next?.kind === 'id' && next.value === 'type' ? tokens[k + 2] : next;
      if (isPunct(second, '*') || isPunct(second, '{')) {
        const specifier = specifierAfter(k + 1);
        if (specifier !== null) refs.push({ line: token.line, specifier });
      }
    }
  }
  return refs;
}

const URL_OR_ABSOLUTE = /^([a-z][a-z0-9+.-]*:|[\\/])/i;

interface Finding { rule: 'import-boundary' | 'undeclared-package' | 'dynamic-import'; message: string }

// What is wrong with one import of `file`, which lies at `rel` in the module folder; undefined when it is allowed.
function judge(module: ModuleInfo, file: string, rel: string, specifier: string | null): Finding | undefined {
  const undeclared = (name: string): Finding | undefined =>
    module.packages.includes(name) ? undefined : { rule: 'undeclared-package', message: `${name} is not listed in packages of ${module.id}` };
  if (specifier === null) return { rule: 'dynamic-import', message: 'import() with a non-literal argument' };
  if (/^\.\.?(\/|$)/.test(specifier)) {
    const target = path.posix.join(path.posix.dirname(file), specifier);
    return target === module.dir || target.startsWith(`${module.dir}/`) ? undefined : { rule: 'import-boundary', message: `${specifier} resolves outside ${module.dir}` };
  }
  if (specifier.startsWith('node:')) return rel.startsWith('test/') ? undefined : undeclared(`node:${specifier.slice('node:'.length).split('/')[0]}`);
  if (URL_OR_ABSOLUTE.test(specifier)) return { rule: 'import-boundary', message: `${specifier} is an absolute path or a URL` };
  const parts = specifier.split('/');
  return undeclared(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
}

export function checkImports(index: RootIndex, module: ModuleInfo): Problem[] {
  const problems: Problem[] = [];
  const dir = absPath(index.repoRoot, module.dir);
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith('.ts') || rel === 'types.gen.ts') continue;
    const file = `${module.dir}/${rel}`;
    for (const { line, specifier } of scanImports(readText(path.join(dir, ...rel.split('/'))))) {
      const found = judge(module, file, rel, specifier);
      if (found) problems.push(error(file, '', found.rule, found.message, line));
    }
  }
  return problems;
}
