// Merges config overrides into module defaults (RFC 7396) and validates the result against each config schema.
import type { Composition } from './composition.ts';
import type { RootIndex } from './discover.ts';
import { absPath, isFile } from './fsx.ts';
import { isObject, joinPointer } from './json.ts';
import type { Json, JsonObject } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';
import type { Resolution } from './resolve.ts';
import type { Validator } from './validate.ts';

// A new value that shares nothing with its arguments. Object.fromEntries defines every key, so a "__proto__" key stays plain data.
export function mergePatch(target: Json | undefined, patch: Json): Json {
  if (!isObject(patch)) return structuredClone(patch);
  const merged = new Map(isObject(target) ? Object.entries(structuredClone(target)) : []);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) merged.delete(name);
    else merged.set(name, mergePatch(merged.get(name), value));
  }
  return Object.fromEntries(merged);
}

// The failures of `value` against a config schema as [bad-config] errors at file#pointer. A schema file that is missing is discover's
// [missing-file]; one that cannot be loaded keeps its [schema-load] problem.
function configFailures(index: RootIndex, validator: Validator, schema: string, value: JsonObject, file: string, pointer: string): Problem[] {
  if (!isFile(absPath(index.repoRoot, schema))) return [];
  return validator.validate(schema, value, file).map((p) => (p.rule === 'schema' ? error(file, pointer, 'bad-config', `${p.pointer || '/'}: ${p.message}`) : p));
}

export function resolveConfig(index: RootIndex, resolution: Resolution, composition: Composition, validator: Validator): { config: Record<string, JsonObject>; problems: Problem[] } {
  const config: Record<string, JsonObject> = {};
  const problems: Problem[] = [];
  for (const id of resolution.selected) {
    const declared = index.modules.get(id)?.config;
    const override = composition.modules[id]?.config;
    const at = joinPointer(composition.pointer, id, 'config');
    if (declared === undefined) {
      if (override !== undefined) problems.push(error(composition.file, at, 'bad-config', `${id} declares no config`));
      config[id] = {};
      continue;
    }
    config[id] = mergePatch(declared.defaults, override ?? {}) as JsonObject;
    problems.push(...configFailures(index, validator, declared.schema, config[id], composition.file, at));
  }
  return { config, problems };
}

export function checkConfigDefaults(index: RootIndex, validator: Validator): Problem[] {
  return [...index.modules.keys()].sort().flatMap((id) => {
    const m = index.modules.get(id)!;
    return m.config === undefined ? [] : configFailures(index, validator, m.config.schema, m.config.defaults, m.file, '/config/defaults');
  });
}
