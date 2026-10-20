// Generates <module>/types.gen.ts from a manifest and its schemas, and keeps the committed copies current.
import path from 'node:path';
import type { ModuleInfo, RootIndex } from './discover.ts';
import { absPath, isFile, joinPosix, relativePosix } from './fsx.ts';
import { getPointer, isObject, joinPointer, readJson, readText, writeText } from './json.ts';
import type { JsonObject } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';
import type { Rule } from './rules.ts';

export interface GenFile { module: string; path: string; text: string }   // path: '<dir>/types.gen.ts'

// A rendered type expression; `union` tells an array to put it in parentheses, `doc` is the comment of the schema node it came from.
interface Expr { text: string; union: boolean; doc?: string }
interface Place { file: string; pointer: string }   // where a node lives, for problems

const ENVELOPE = ['$schema', '$version', '$comment'];
const FIXED_NAMES = ['Config', 'State', 'Operations', 'Ctx', 'RuntimeCtx', 'Record'];
const UNKNOWN: Expr = { text: 'unknown', union: false };
const NO_PROPERTIES: Expr = { text: 'Record<string, never>', union: false };
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

class GenError extends Error {
  problem: Problem;
  constructor(problem: Problem) {
    super(problem.message);
    this.problem = problem;
  }
}

function fail(rule: Rule, at: Place, message: string, line?: number): never {
  throw new GenError(error(at.file, at.pointer, rule, message, line));
}

function pascal(name: string): string {
  return name.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// /** text */ for a node's description, or /** @deprecated text */ when it is deprecated.
function docComment(node: JsonObject): string | undefined {
  const text = typeof node.description === 'string' ? node.description.replace(/\r?\n/g, ' ').replaceAll('*/', '*\\/') : '';
  if (node.deprecated === true) return text === '' ? '/** @deprecated */' : `/** @deprecated ${text} */`;
  return text === '' ? undefined : `/** ${text} */`;
}

// The type expression of a schema file, with every $ref replaced by what it names. Each call to the result starts with a fresh stack of open refs.
function createRenderer(repoRoot: string): (schema: string, from: Place, record: boolean) => Expr {
  const docs = new Map<string, JsonObject>();
  const open: string[] = [];   // `file#fragment` of the $refs being expanded, to find recursion

  function load(file: string, from: Place, missing: Rule = 'missing-file'): JsonObject {
    const known = docs.get(file);
    if (known) return known;
    const abs = absPath(repoRoot, file);
    if (!isFile(abs)) return fail(missing, from, `${file} does not exist`);
    const parsed = readJson(abs);
    if (!parsed.ok) return fail('json-parse', { file, pointer: '' }, parsed.message, parsed.line);
    if (!isObject(parsed.value)) return fail('gen-unsupported', { file, pointer: '' }, 'a schema must be an object');
    docs.set(file, parsed.value);
    return parsed.value;
  }

  function refType(ref: string, at: Place, indent: string): Expr {
    const [filePart, fragment = ''] = ref.split('#');
    const file = filePart === '' ? at.file : joinPosix(path.posix.dirname(at.file), filePart);
    const key = `${file}#${fragment}`;
    if (open.includes(key)) return fail('gen-unsupported', at, `recursive $ref ${ref}`);
    const target = getPointer(load(file, at, 'ref-missing'), fragment);
    if (target === undefined) return fail('ref-missing', at, `${ref} does not exist`);
    open.push(key);
    try {
      return typeOf(target, { file, pointer: fragment }, indent, false);
    } finally {
      open.pop();
    }
  }

  function arrayType(node: JsonObject, at: Place, indent: string): Expr {
    const item = node.items === undefined ? UNKNOWN : typeOf(node.items, { file: at.file, pointer: joinPointer(at.pointer, 'items') }, indent, false);
    const { minItems, maxItems } = node;
    if (typeof minItems === 'number' && minItems === maxItems && minItems >= 1 && minItems <= 16) {
      return { text: `[${new Array<string>(minItems).fill(item.text).join(', ')}]`, union: false };
    }
    return { text: `${item.union ? `(${item.text})` : item.text}[]`, union: false };
  }

  // A record type's own object drops the envelope keys; a nested object keeps every key.
  function objectType(node: JsonObject, at: Place, indent: string, record: boolean): Expr {
    const inner = `${indent}  `;
    if (isObject(node.properties) && Object.keys(node.properties).length > 0) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const lines: string[] = [];
      for (const [name, property] of Object.entries(node.properties)) {
        if (record && ENVELOPE.includes(name)) continue;
        const value = typeOf(property, { file: at.file, pointer: joinPointer(at.pointer, 'properties', name) }, inner, false);
        if (value.doc !== undefined) lines.push(`${inner}${value.doc}`);
        lines.push(`${inner}${BARE_KEY.test(name) ? name : JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${value.text};`);
      }
      return lines.length === 0 ? NO_PROPERTIES : { text: `{\n${lines.join('\n')}\n${indent}}`, union: false };
    }
    if (isObject(node.additionalProperties)) {
      const value = typeOf(node.additionalProperties, { file: at.file, pointer: joinPointer(at.pointer, 'additionalProperties') }, inner, false);
      return { text: `{\n${inner}[key: string]: ${value.text};\n${indent}}`, union: false };
    }
    return NO_PROPERTIES;
  }

  function baseType(type: unknown, node: JsonObject, at: Place, indent: string, record: boolean): Expr {
    switch (type) {
      case undefined: return UNKNOWN;
      case 'string': return { text: 'string', union: false };
      case 'number':
      case 'integer': return { text: 'number', union: false };
      case 'boolean': return { text: 'boolean', union: false };
      case 'null': return { text: 'null', union: false };
      case 'array': return arrayType(node, at, indent);
      case 'object': return objectType(node, at, indent, record);
      default: return fail('gen-unsupported', at, `type ${JSON.stringify(type)} cannot be expressed`);
    }
  }

  function build(node: JsonObject, at: Place, indent: string, record: boolean): Expr {
    if (typeof node.$ref === 'string') return refType(node.$ref, at, indent);
    if (Object.hasOwn(node, 'const')) {
      const value = node.const;
      const literal = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      return literal ? { text: JSON.stringify(value), union: false } : UNKNOWN;
    }
    if (Object.hasOwn(node, 'enum')) {
      const values = node.enum;
      if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) return fail('gen-unsupported', at, 'enum must be a non-empty array of strings');
      return { text: values.map((v) => JSON.stringify(v)).join(' | '), union: values.length > 1 };
    }
    const { type } = node;
    if (!Array.isArray(type)) return baseType(type, node, at, indent, record);
    const [base, nullish] = type;
    if (type.length !== 2 || typeof base !== 'string' || base === 'null' || nullish !== 'null') return fail('gen-unsupported', at, `type ${JSON.stringify(type)} is not [T, "null"]`);
    return { text: `${baseType(base, node, at, indent, record).text} | null`, union: true };
  }

  function typeOf(node: unknown, at: Place, indent: string, record: boolean): Expr {
    if (!isObject(node)) return fail('gen-unsupported', at, 'a schema must be an object');
    const { text, union } = build(node, at, indent, record);
    return { text, union, doc: docComment(node) };
  }

  return (schema, from, record) => {
    const root = load(schema, from);
    open.length = 0;
    open.push(`${schema}#`);
    return typeOf(root, { file: schema, pointer: '' }, '', record);
  };
}

// Two declarations that generate one identifier, found from the manifest alone.
function nameClashes(module: ModuleInfo): Problem[] {
  const declared = new Map<string, string>(FIXED_NAMES.map((name) => [name, `the generated ${name}`]));
  const problems: Problem[] = [];
  const declare = (name: string, what: string, pointer: string): void => {
    const first = declared.get(name);
    if (first === undefined) declared.set(name, what);
    else problems.push(error(module.file, pointer, 'gen-name-clash', `${what} and ${first} both generate ${name}`));
  };
  for (const name of Object.keys(module.types)) declare(pascal(name), `type ${name}`, `/types/${name}`);
  for (const name of Object.keys(module.events)) declare(`${pascal(name)}Event`, `event ${name}`, `/events/${name}`);
  for (const [name, op] of Object.entries(module.operations)) {
    if (op.params !== undefined) declare(`${pascal(name)}Params`, `operation ${name} params`, `/operations/${name}/params`);
  }
  for (const [name, op] of Object.entries(module.operations)) {
    if (op.result !== undefined) declare(`${pascal(name)}Result`, `operation ${name} result`, `/operations/${name}/result`);
  }
  return problems;
}

// An import path from a folder to a file, both repo-relative: ./ is added where the relative path does not start with a dot.
function importPath(fromDir: string, to: string): string {
  const rel = relativePosix(fromDir, to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function generateModule(index: RootIndex, module: ModuleInfo): { file?: GenFile; problems: Problem[] } {
  const clashes = nameClashes(module);
  if (clashes.length > 0) return { problems: clashes };

  const render = createRenderer(index.repoRoot);
  const problems: Problem[] = [];
  // A schema that cannot be generated is reported and stands in as unknown; the file is not produced then.
  const typeOfSchema = (schema: string, pointer: string, record = false): Expr => {
    try {
      return render(schema, { file: module.file, pointer }, record);
    } catch (e) {
      if (!(e instanceof GenError)) throw e;
      problems.push(e.problem);
      return UNKNOWN;
    }
  };

  const imported = [...new Set([...module.implements, ...module.requires])].filter((id) => index.modules.has(id)).sort();
  const implemented = module.implements.filter((id) => index.modules.has(id)).sort();
  const blocks = [[
    `// Generated by \`npm run gen\` from ${module.file}. Do not edit.`,
    `import type { Ctx as RuntimeCtx } from '${importPath(module.dir, 'hosts/js/runtime.ts')}';`,
    ...imported.map((id) => `import type * as ${id} from '${importPath(module.dir, joinPosix(index.modules.get(id)!.dir, 'types.gen.ts'))}';`),
    ...(imported.length > 0 ? [`export type { ${imported.join(', ')} };`] : []),
  ].join('\n')];

  for (const [name, schema] of Object.entries(module.types)) {
    const { text, doc } = typeOfSchema(schema, `/types/${name}`, true);
    blocks.push(`${doc === undefined ? '' : `${doc}\n`}export type ${pascal(name)} = ${text};`);
  }
  for (const [name, schema] of Object.entries(module.events)) {
    blocks.push(`export type ${pascal(name)}Event = ${typeOfSchema(schema, `/events/${name}`).text};`);
  }
  for (const [name, op] of Object.entries(module.operations)) {
    if (op.params !== undefined) blocks.push(`export type ${pascal(name)}Params = ${typeOfSchema(op.params, `/operations/${name}/params`).text};`);
  }
  for (const [name, op] of Object.entries(module.operations)) {
    if (op.result !== undefined) blocks.push(`export type ${pascal(name)}Result = ${typeOfSchema(op.result, `/operations/${name}/result`).text};`);
  }
  blocks.push(`export type Config = ${module.config ? typeOfSchema(module.config.schema, '/config/schema').text : NO_PROPERTIES.text};`);
  if (!module.contract) blocks.push(`export type State = ${module.state === undefined ? 'undefined' : typeOfSchema(module.state, '/state').text};`);

  const ctx = module.contract ? 'RuntimeCtx' : 'Ctx';
  const methods = Object.entries(module.operations).map(([name, op]) => {
    const params = op.params === undefined ? '' : `, params: ${pascal(name)}Params`;
    return `  ${name}(ctx: ${ctx}${params}): ${op.result === undefined ? 'void' : `${pascal(name)}Result`};\n`;
  });
  const extend = implemented.length > 0 ? ` extends ${implemented.map((id) => `${id}.Operations`).join(', ')}` : '';
  blocks.push(`export interface Operations${extend} {\n${methods.join('')}}`);
  if (!module.contract) blocks.push('export type Ctx = RuntimeCtx<State, Config>;');

  if (problems.length > 0) return { problems };
  return { file: { module: module.id, path: `${module.dir}/types.gen.ts`, text: `${blocks.join('\n\n')}\n` }, problems: [] };
}

// Why the committed copy of `file` is out of date, or undefined when it is current.
function staleness(index: RootIndex, file: GenFile): string | undefined {
  const abs = absPath(index.repoRoot, file.path);
  if (!isFile(abs)) return 'missing; run npm run gen';
  return readText(abs) === file.text ? undefined : 'differs from npm run gen output; run npm run gen';
}

export function checkGenerated(index: RootIndex): Problem[] {
  const problems: Problem[] = [];
  for (const module of index.modules.values()) {
    const { file, problems: failed } = generateModule(index, module);
    problems.push(...failed);
    if (!file) continue;
    const why = staleness(index, file);
    if (why) problems.push(error(file.path, '', 'gen-stale', why));
  }
  return problems;
}

export function writeGenerated(index: RootIndex): { written: string[]; problems: Problem[] } {
  const written: string[] = [];
  const problems: Problem[] = [];
  for (const module of index.modules.values()) {
    const { file, problems: failed } = generateModule(index, module);
    problems.push(...failed);
    if (!file || !staleness(index, file)) continue;
    writeText(absPath(index.repoRoot, file.path), file.text);
    written.push(file.path);
  }
  return { written, problems };
}
