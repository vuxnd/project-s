// JSON Schema validation of repository files with Ajv; the only file that imports ajv.
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { absPath, isFile, joinPosix } from './fsx.ts';
import { isObject, readJson } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';

export const SCHEMA_BASE = 'https://repo.invalid/';

export interface Validator {
  load(schemaPath: string): Problem[];
  validate(schemaPath: string, value: unknown, file: string, basePointer?: string): Problem[];
  errors(schemaPath: string, value: unknown): string[];
}

interface Failure { file: string; message: string }

const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const DATA_KEYWORDS = new Set(['const', 'default', 'examples', 'enum']);

// Every $ref value below `schema`; a map holds schemas under arbitrary names, data keywords hold none.
function collectRefs(schema: unknown, found: string[], inMap: boolean): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, found, false);
  } else if (isObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      if (inMap) collectRefs(value, found, false);
      else if (key === '$ref' && typeof value === 'string') found.push(value);
      else if (!DATA_KEYWORDS.has(key)) collectRefs(value, found, SCHEMA_MAPS.has(key));
    }
  }
}

// The files other than the schema itself that its $ref values name, as written.
function referencedFiles(schema: unknown): string[] {
  const refs: string[] = [];
  collectRefs(schema, refs, false);
  return refs.map((ref) => ref.split('#')[0]).filter((file) => file !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(file));
}

function describe(e: ErrorObject): string {
  const message = e.message ?? e.keyword;
  if (e.keyword === 'additionalProperties') return `${message} (unknown property "${e.params.additionalProperty}")`;
  if (e.keyword === 'enum') return `${message} (one of: ${e.params.allowedValues.join(', ')})`;
  if (e.keyword === 'const') return `${message} (expected ${JSON.stringify(e.params.allowedValue)})`;
  return message;
}

function failureText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replaceAll(SCHEMA_BASE, '');
}

export function createValidator(repoRoot: string): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addVocabulary(['x-ref', 'x-asset', 'x-unit']);
  const registered = new Map<string, Failure | null>();   // schema file -> why it cannot be used; null when added to ajv
  const compiled = new Map<string, ValidateFunction | Failure>();

  function register(file: string): Failure | null {
    const known = registered.get(file);
    if (known !== undefined) return known;
    registered.set(file, null);   // provisional, so files that $ref each other end the walk
    const failure = add(file);
    registered.set(file, failure);
    return failure;
  }

  function add(file: string): Failure | null {
    const abs = absPath(repoRoot, file);
    if (file.startsWith('../') || !isFile(abs)) return { file, message: 'file not found' };
    const parsed = readJson(abs);
    if (!parsed.ok) return { file, message: `line ${parsed.line}: ${parsed.message}` };
    try {
      ajv.addSchema(parsed.value as Record<string, unknown>, SCHEMA_BASE + file);
    } catch (e) {
      return { file, message: failureText(e) };
    }
    for (const target of referencedFiles(parsed.value)) {
      const failure = register(joinPosix(path.posix.dirname(file), target));
      if (failure) return failure;
    }
    return null;
  }

  function compile(schemaPath: string): ValidateFunction | Failure {
    const cached = compiled.get(schemaPath);
    if (cached) return cached;
    const file = schemaPath.split('#')[0];
    let result: ValidateFunction | Failure;
    const failure = register(file);
    if (failure) {
      result = failure;
    } else {
      try {
        result = (ajv.getSchema(SCHEMA_BASE + schemaPath) as ValidateFunction | undefined) ?? { file, message: `${schemaPath} does not exist` };
      } catch (e) {
        result = { file, message: failureText(e) };
      }
    }
    compiled.set(schemaPath, result);
    return result;
  }

  // The failure at the schema the caller asked for; its message names another file when that one is the cause.
  function loadProblem(schemaPath: string, failure: Failure): Problem {
    const file = schemaPath.split('#')[0];
    return error(file, '', 'schema-load', failure.file === file ? failure.message : `${failure.file}: ${failure.message}`);
  }

  return {
    load(schemaPath) {
      const result = compile(schemaPath);
      return typeof result === 'function' ? [] : [loadProblem(schemaPath, result)];
    },
    validate(schemaPath, value, file, basePointer = '') {
      const result = compile(schemaPath);
      if (typeof result !== 'function') return [loadProblem(schemaPath, result)];
      if (result(value)) return [];
      return (result.errors ?? []).map((e) => error(file, basePointer + e.instancePath, 'schema', describe(e)));
    },
    errors(schemaPath, value) {
      const result = compile(schemaPath);
      if (typeof result !== 'function') throw new Error(loadProblem(schemaPath, result).message);
      if (result(value)) return [];
      return (result.errors ?? []).map((e) => `${e.instancePath || '/'}: ${describe(e)}`);
    },
  };
}
