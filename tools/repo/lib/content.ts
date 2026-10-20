// Checks the schema files of a root (profile, references, annotations) and loads and checks its records.
import path from 'node:path';
import { absPath, isFile, joinPosix, relativePosix, walkFiles } from './fsx.ts';
import { dataSees } from './discover.ts';
import type { ModuleInfo, RootIndex } from './discover.ts';
import { getPointer, isObject, joinPointer, readJson } from './json.ts';
import type { Json, JsonObject, Parsed } from './json.ts';
import { error, hasErrors, warning } from './problems.ts';
import type { Problem } from './problems.ts';
import { checkProfile, checkRecordType, REF_FORM, schemaRefs, typeRefs } from './profile.ts';
import type { Validator } from './validate.ts';

export interface RecordInfo {
  type: string;      // type id
  id: string;        // '<module>/<name>' or 'trace/<name>'
  module: string;    // containing module id, or 'trace'
  file: string;      // repo-relative file holding the record
  pointer: string;   // '' for a content file, '/records/<type>/<name>' inside a trace
  version: number;   // $version as written
  body: JsonObject;  // without $schema, $version, $comment; x-asset values rewritten to repo paths
  assets: string[];  // sorted repo paths referenced through x-asset
}
export interface RecordSource { type: string; id: string; module: string; file: string; pointer: string; value: JsonObject }

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENVELOPE = ['$schema', '$version', '$comment'];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Schema files parsed once per index, undefined for a path that is no file.
const documents = new WeakMap<RootIndex, Map<string, Parsed | undefined>>();

function loadDoc(index: RootIndex, file: string): Parsed | undefined {
  const cache = documents.get(index) ?? new Map<string, Parsed | undefined>();
  documents.set(index, cache);
  if (!cache.has(file)) {
    const abs = absPath(index.repoRoot, file);
    cache.set(file, file.startsWith('../') || !isFile(abs) ? undefined : readJson(abs));
  }
  return cache.get(file);
}

function ownerOf(index: RootIndex, file: string): ModuleInfo | undefined {
  return [...index.modules.values()].find((m) => file.startsWith(`${m.dir}/`));
}

function declaredSchemas(m: ModuleInfo): string[] {
  const files = [...Object.values(m.types), ...Object.values(m.events)];
  for (const op of Object.values(m.operations)) files.push(...[op.params, op.result].filter((f) => f !== undefined));
  if (m.state !== undefined) files.push(m.state);
  if (m.config !== undefined) files.push(m.config.schema);
  return files;
}

// The file a `$ref` written in `file` names, and the $defs entry when it names one.
function resolveRef(file: string, ref: string): { file: string; def?: string } {
  const [target, fragment] = ref.split('#');
  const resolved = { file: target === '' ? file : joinPosix(path.posix.dirname(file), target) };
  return fragment === undefined ? resolved : { ...resolved, def: fragment.slice('/$defs/'.length) };
}

export function checkSchemas(index: RootIndex, validator: Validator): Problem[] {
  const problems: Problem[] = [];
  const modules = [...index.modules.values()];
  const typeFiles = new Set(modules.flatMap((m) => Object.values(m.types)));
  const queue = modules.flatMap(declaredSchemas);   // grows as $ref targets are found
  const done = new Set<string>();
  for (const file of queue) {
    if (done.has(file)) continue;
    done.add(file);
    const owner = ownerOf(index, file);
    const doc = loadDoc(index, file);
    if (!owner || !doc) continue;
    if (!doc.ok) {
      problems.push(error(file, '', 'json-parse', doc.message, doc.line));
      continue;
    }
    const found = checkProfile(doc.value, file);
    if (typeFiles.has(file)) found.push(...checkRecordType(doc.value, file));
    const visible = dataSees(owner);
    const visibleDirs = visible.flatMap((id) => index.modules.get(id)?.dir ?? []);

    for (const { pointer, ref } of schemaRefs(doc.value)) {
      if (!REF_FORM.test(ref)) continue;   // checkProfile reports it
      const target = resolveRef(file, ref);
      const targetDoc = loadDoc(index, target.file);
      if (!targetDoc) {
        found.push(error(file, pointer, 'ref-missing', `${target.file} does not exist`));
        continue;
      }
      if (target.def !== undefined && targetDoc.ok && getPointer(targetDoc.value, `/$defs/${target.def}`) === undefined) {
        found.push(error(file, pointer, 'ref-missing', `${target.file} has no $defs entry ${target.def}`));
      }
      if (!visibleDirs.some((dir) => target.file.startsWith(`${dir}/`))) {
        found.push(error(file, pointer, 'invisible-ref', `${target.file} is outside ${owner.id} and the modules it requires or implements`));
      }
      queue.push(target.file);
    }

    for (const { pointer, type } of typeRefs(doc.value)) {
      const declared = index.types.get(type);
      if (!declared) found.push(error(file, pointer, 'unknown-type', `${type} is not a declared record type`));
      else if (!visible.includes(declared.module)) found.push(error(file, pointer, 'invisible-ref', `${type} belongs to ${declared.module}, which ${owner.id} does not require or implement`));
    }

    if (!hasErrors(found)) found.push(...validator.load(file));   // Ajv repeats a missing $ref target or an unknown keyword, so a file with errors is not compiled
    problems.push(...found);
  }
  return problems;
}

// Walks the schema of a record beside the record: $ref, properties, items and map additionalProperties.
export function checkRecord(index: RootIndex, validator: Validator, source: RecordSource, known: ReadonlySet<string>): { record?: RecordInfo; problems: Problem[] } {
  const { file, value } = source;
  const trace = source.module === 'trace';
  const at = (...tokens: (string | number)[]): string => joinPointer(source.pointer, ...tokens);
  const type = index.types.get(source.type);
  if (!type) return { problems: [error(file, source.pointer, 'unknown-type', `${source.type} is not a declared record type`)] };
  const owner = index.modules.get(source.module);
  const visible = owner ? dataSees(owner) : [];
  if (!trace && !visible.includes(type.module)) {
    return { problems: [error(file, source.pointer, 'invisible-ref', `${source.type} belongs to ${type.module}, which ${source.module} does not require or implement`)] };
  }
  if (type.version === 0) return { problems: [] };   // checkSchemas reports the type as [record-type]

  const written = value.$version;
  if (typeof written === 'number' && Number.isInteger(written) && written < type.version) {
    return { problems: [error(file, at('$version'), 'outdated-record', `${source.id}: $version ${written} is older than ${source.type} ${type.version}; run npm run migrate -- --write`)] };
  }
  const problems: Problem[] = [];
  if (!trace && typeof value.$schema === 'string') {
    const expected = relativePosix(path.posix.dirname(file), type.schema);
    if (value.$schema !== expected) problems.push(error(file, at('$schema'), 'schema-path', `$schema is ${value.$schema}; expected ${expected}`));
  }
  const invalid = validator.validate(type.schema, value, file, source.pointer);
  if (invalid.length > 0) return { problems: [...problems, ...invalid] };

  const rewrites = new Map<string, string>();   // pointer of an x-asset value -> repo path
  const warned = new Set<string>();
  const checkRef = (typeId: string, id: string, pointer: string): void => {
    if (!known.has(`${typeId} ${id}`)) problems.push(error(file, pointer, 'dangling-ref', `there is no ${typeId} record ${id}`));
    else if (!trace && !visible.includes(id.split('/')[0])) problems.push(error(file, pointer, 'invisible-ref', `${id} belongs to a module that ${source.module} does not require or implement`));
  };
  const checkAsset = (extensions: Json[], asset: string, pointer: string): void => {
    const repoPath = joinPosix(owner?.dir ?? '.', asset);
    const bad = (reason: string): void => {
      problems.push(error(file, pointer, 'asset-missing', reason));
    };
    if (trace) bad('a trace record cannot reference an asset');
    else if (/^\/|\\|(^|\/)\.\.(\/|$)/.test(asset)) bad(`${asset} must be a path inside the module folder`);
    else if (!extensions.includes(path.posix.extname(asset).slice(1).toLowerCase())) bad(`${asset} must have one of the extensions: ${extensions.join(', ')}`);
    else if (!isFile(absPath(index.repoRoot, repoPath))) bad(`${repoPath} does not exist`);
    else rewrites.set(pointer, repoPath);
  };

  const visit = (schema: unknown, schemaFile: string, node: Json, tokens: (string | number)[]): void => {
    if (!isObject(schema)) return;
    const pointer = at(...tokens);
    if (schema.deprecated === true && !warned.has(pointer)) {
      warned.add(pointer);
      const hint = typeof schema.description === 'string' ? `: ${schema.description}` : '';
      problems.push(warning(file, pointer, 'deprecated', `${source.id}${joinPointer('', ...tokens)} is deprecated${hint}`));
    }
    if (typeof schema.$ref === 'string' && REF_FORM.test(schema.$ref)) {
      const target = resolveRef(schemaFile, schema.$ref);
      const doc = loadDoc(index, target.file);
      if (doc?.ok) visit(target.def === undefined ? doc.value : getPointer(doc.value, `/$defs/${target.def}`), target.file, node, tokens);
    }
    if (typeof node === 'string') {
      if (typeof schema['x-ref'] === 'string') checkRef(schema['x-ref'], node, pointer);
      if (Array.isArray(schema['x-asset'])) checkAsset(schema['x-asset'], node, pointer);
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => visit(schema.items, schemaFile, item, [...tokens, i]));
    } else if (isObject(node)) {
      const props = isObject(schema.properties) ? schema.properties : {};
      for (const [key, child] of Object.entries(node)) visit(Object.hasOwn(props, key) ? props[key] : schema.additionalProperties, schemaFile, child, [...tokens, key]);
    }
  };
  const typeDoc = loadDoc(index, type.schema);
  if (typeDoc?.ok) visit(typeDoc.value, type.schema, value, []);
  if (hasErrors(problems)) return { problems };

  const rewritten = (node: Json, pointer: string): Json => {
    const to = rewrites.get(pointer);
    if (to !== undefined) return to;
    if (Array.isArray(node)) return node.map((item, i) => rewritten(item, joinPointer(pointer, i)));
    if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rewritten(child, joinPointer(pointer, key))]));
    return node;
  };
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => !ENVELOPE.includes(key)).map(([key, child]) => [key, rewritten(child, at(key))]));
  return {
    record: { type: source.type, id: source.id, module: source.module, file, pointer: source.pointer, version: type.version, body, assets: [...new Set(rewrites.values())].sort() },
    problems,
  };
}

export function loadRecords(index: RootIndex, validator: Validator): { records: RecordInfo[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const sources: RecordSource[] = [];
  for (const m of index.modules.values()) {
    const content = joinPosix(m.dir, 'content');
    for (const rel of walkFiles(absPath(index.repoRoot, content))) {
      const file = `${content}/${rel}`;
      const [type, base, ...deeper] = rel.split('/');
      const name = base?.endsWith('.json') ? base.slice(0, -'.json'.length) : '';
      if (deeper.length > 0 || !NAME.test(name)) {
        problems.push(error(file, '', 'bad-id', `${rel} must be <type id>/<name>.json with a name matching ${NAME.source}`));
        continue;
      }
      const parsed = readJson(absPath(index.repoRoot, file));
      if (!parsed.ok) problems.push(error(file, '', 'json-parse', parsed.message, parsed.line));
      else if (!isObject(parsed.value)) problems.push(error(file, '', 'schema', 'a record must be a JSON object'));
      else sources.push({ type, id: `${m.id}/${name}`, module: m.id, file, pointer: '', value: parsed.value });
    }
  }
  const known = new Set(sources.map((s) => `${s.type} ${s.id}`));
  const records: RecordInfo[] = [];
  for (const source of sources) {
    const checked = checkRecord(index, validator, source, known);
    problems.push(...checked.problems);
    if (checked.record) records.push(checked.record);
  }
  records.sort((a, b) => compare(a.type, b.type) || compare(a.id, b.id));
  return { records, problems };
}

export function checkMigrationFiles(index: RootIndex): Problem[] {
  const problems: Problem[] = [];
  for (const type of index.types.values()) {
    const dir = index.modules.get(type.module)!.dir;
    for (let k = 2; k <= type.version; k++) {
      for (const name of [`${k}.ts`, `${k}.before.json`, `${k}.after.json`]) {
        const file = joinPosix(dir, 'migrations', type.name, name);
        if (!isFile(absPath(index.repoRoot, file))) problems.push(error(type.schema, '/properties/$version/const', 'migration-missing', `${file} does not exist`));
      }
    }
  }
  return problems;
}
