// Migrates records to their type's current version: the steps of a type, one record through them, and the plan for a root.
import { pathToFileURL } from 'node:url';
import { discover } from './discover.ts';
import type { RootIndex } from './discover.ts';
import { absPath, joinPosix, listFiles, walkFiles } from './fsx.ts';
import { formatJson, isObject, joinPointer, readJson } from './json.ts';
import type { JsonObject } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';
import { createValidator } from './validate.ts';
import type { Validator } from './validate.ts';

export interface MigrationChange { file: string; type: string; id: string; from: number; to: number }

// A record below its type's version; `value` is the object inside the parsed document of its file.
interface Outdated { type: string; id: string; pointer: string; value: JsonObject; from: number; to: number }

const ENVELOPE = ['$schema', '$version', '$comment'];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function migrationSteps(index: RootIndex, type: string): { to: number; file: string; before: string; after: string }[] {
  const info = index.types.get(type);
  if (!info) return [];
  const dir = joinPosix(index.modules.get(info.module)!.dir, 'migrations', info.name);
  return Array.from({ length: Math.max(info.version - 1, 0) }, (_, i) => {
    const to = i + 2;
    return { to, file: `${dir}/${to}.ts`, before: `${dir}/${to}.before.json`, after: `${dir}/${to}.after.json` };
  });
}

// A step returns the body; the envelope of the result is the one of the input record, with $version set to the step.
async function migrate(repoRoot: string, index: RootIndex, validator: Validator, type: string, record: JsonObject, to?: number): Promise<JsonObject> {
  const info = index.types.get(type);
  if (!info) throw new Error(`${type} is not a declared record type`);
  const from = record.$version;
  if (typeof from !== 'number' || !Number.isInteger(from)) throw new Error('the record has no integer $version');
  const target = to ?? info.version;
  let current = structuredClone(record);
  for (const step of migrationSteps(index, type).filter((s) => s.to > from && s.to <= target)) {
    try {
      const { default: fn } = (await import(pathToFileURL(absPath(repoRoot, step.file)).href)) as { default?: unknown };
      if (typeof fn !== 'function') throw new Error('no default export function');
      const returned: unknown = fn(structuredClone(current));
      if (!isObject(returned)) throw new Error('returned a value that is not an object');
      current = {
        ...(record.$schema === undefined ? {} : { $schema: record.$schema }),
        $version: step.to,
        ...(record.$comment === undefined ? {} : { $comment: record.$comment }),
        ...Object.fromEntries(Object.entries(returned).filter(([key]) => !ENVELOPE.includes(key))),
      };
    } catch (e) {
      throw new Error(`${step.file}: ${message(e)}`);
    }
  }
  if (target === info.version) {   // an intermediate result can never match the schema of the current version
    const invalid = validator.errors(info.schema, current);
    if (invalid.length > 0) throw new Error(`the result does not match ${info.schema}: ${invalid.join('; ')}`);
  }
  return current;
}

export function migrateRecord(repoRoot: string, index: RootIndex, type: string, record: JsonObject, to?: number): Promise<JsonObject> {
  return migrate(repoRoot, index, createValidator(repoRoot), type, record, to);
}

// The JSON object a file holds, or undefined when it holds none: the checks report that, not the migration.
function readObject(repoRoot: string, file: string): JsonObject | undefined {
  const parsed = readJson(absPath(repoRoot, file));
  return parsed.ok && isObject(parsed.value) ? parsed.value : undefined;
}

// The outdated records of the content files and of the traces of contracts, grouped by file in sorted order.
function outdatedRecords(index: RootIndex): { file: string; doc: JsonObject; records: Outdated[] }[] {
  const found: { file: string; doc: JsonObject; records: Outdated[] }[] = [];
  const outdated = (type: string, id: string, pointer: string, value: JsonObject): Outdated[] => {
    const to = index.types.get(type)?.version ?? 0;
    const from = value.$version;
    return to > 0 && typeof from === 'number' && Number.isInteger(from) && from < to ? [{ type, id, pointer, value, from, to }] : [];
  };
  for (const m of index.modules.values()) {
    const content = joinPosix(m.dir, 'content');
    for (const rel of walkFiles(absPath(index.repoRoot, content))) {
      const file = `${content}/${rel}`;
      const [type, base, ...deeper] = rel.split('/');
      const doc = base?.endsWith('.json') && deeper.length === 0 ? readObject(index.repoRoot, file) : undefined;
      const records = doc ? outdated(type, `${m.id}/${base.slice(0, -'.json'.length)}`, '', doc) : [];
      if (doc && records.length > 0) found.push({ file, doc, records });
    }
    if (!m.contract) continue;
    const conformance = joinPosix(m.dir, 'conformance');
    for (const name of listFiles(absPath(index.repoRoot, conformance)).filter((f) => f.endsWith('.json'))) {
      const file = `${conformance}/${name}`;
      const doc = readObject(index.repoRoot, file);
      const byType = doc?.records;
      const records: Outdated[] = [];
      for (const [type, byName] of Object.entries(isObject(byType) ? byType : {})) {
        for (const [recordName, value] of Object.entries(isObject(byName) ? byName : {})) {
          if (isObject(value)) records.push(...outdated(type, `trace/${recordName}`, joinPointer('', 'records', type, recordName), value));
        }
      }
      if (doc && records.length > 0) found.push({ file, doc, records });
    }
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export async function planMigrations(repoRoot: string, root: string, validator: Validator): Promise<{ changes: MigrationChange[]; files: Map<string, string>; problems: Problem[] }> {
  const index = discover(repoRoot, root, validator);
  const changes: MigrationChange[] = [];
  const files = new Map<string, string>();
  const problems = index.problems.filter((p) => p.severity === 'error');
  for (const { file, doc, records } of outdatedRecords(index)) {
    const migrated: [Outdated, JsonObject][] = [];
    for (const record of records) {
      try {
        migrated.push([record, await migrate(repoRoot, index, validator, record.type, record.value)]);
      } catch (e) {
        problems.push(error(file, record.pointer, 'migration-failed', `${record.id}: ${message(e)}`));
      }
    }
    if (migrated.length < records.length) continue;   // a file is rewritten only when every record in it migrates
    for (const [record, result] of migrated) {
      changes.push({ file, type: record.type, id: record.id, from: record.from, to: record.to });
      for (const key of Object.keys(record.value)) delete record.value[key];
      Object.assign(record.value, result);
    }
    files.set(file, formatJson(doc));
  }
  return { changes, files, problems };
}
