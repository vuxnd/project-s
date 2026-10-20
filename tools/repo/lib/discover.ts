// Reads the modules and games of one repository root and reports the structural problems of their manifests.
import { absPath, isDir, isFile, joinPosix, listDirs, relativePosix } from './fsx.ts';
import { getPointer, readJson } from './json.ts';
import type { JsonObject } from './json.ts';
import { error, warning } from './problems.ts';
import type { Problem } from './problems.ts';
import type { Validator } from './validate.ts';

export interface SystemDecl { name: string; loop: 'fixed' | 'frame'; after: string[]; before: string[]; index: number }
export interface OperationDecl { params?: string; result?: string }
export interface ModuleInfo {
  id: string;
  dir: string;                               // repo-relative posix folder, e.g. 'examples/modules/physics'
  file: string;                              // dir + '/module.json'
  contract: boolean;
  code: boolean;
  deprecated?: string;
  implements: string[];
  requires: string[];
  optional: string[];
  types: Record<string, string>;             // name -> repo-relative schema path, manifest order
  events: Record<string, string>;
  operations: Record<string, OperationDecl>; // paths repo-relative
  state?: string;
  config?: { schema: string; defaults: JsonObject };
  systems: SystemDecl[];                     // manifest order; index = position in the manifest array
  hosts: Record<string, string>;             // host name -> repo-relative entry path
  packages: string[];
}
export interface TypeInfo { id: string; module: string; name: string; schema: string; version: number }
export interface GameInfo {
  id: string;
  dir: string;
  file: string;
  summary: string;
  hosts: string[];
  fixedHz: number;
  modules: Record<string, { config?: JsonObject; hosts?: string[] }>;
}
export interface RootIndex {
  repoRoot: string;                  // absolute
  root: string;                      // repo-relative posix; '.' for the repository root
  modules: Map<string, ModuleInfo>;  // valid manifests, in id order
  types: Map<string, TypeInfo>;      // every declared record type, in id order
  games: Map<string, GameInfo>;      // valid game.json files, in id order
  problems: Problem[];
}

// The manifest shapes as authored; schemas/module.schema.json and schemas/game.schema.json have already accepted them.
interface RawModule {
  id: string;
  deprecated?: string;
  contract?: boolean;
  implements?: string[];
  requires?: string[];
  optional?: string[];
  types?: Record<string, string>;
  events?: Record<string, string>;
  operations?: Record<string, OperationDecl>;
  state?: string;
  config?: { schema: string; defaults: JsonObject };
  systems?: { name: string; loop: 'fixed' | 'frame'; after?: string[]; before?: string[] }[];
  hosts?: Record<string, string>;
  packages?: string[];
}
interface RawGame {
  id: string;
  summary: string;
  hosts: string[];
  fixedHz: number;
  modules: Record<string, { config?: JsonObject; hosts?: string[] }>;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_SYSTEMS = ['init', 'operations'];
const CONTRACT_FORBIDS = ['systems', 'hosts', 'state', 'implements', 'optional', 'packages'];

export function rootPath(root: string, ...parts: string[]): string {
  return joinPosix(root, ...parts);
}

export function sees(m: ModuleInfo): string[] {
  return [...new Set([m.id, ...m.implements, ...m.requires, ...m.optional])].sort();
}

export function dataSees(m: ModuleInfo): string[] {
  return [...new Set([m.id, ...m.implements, ...m.requires])].sort();
}

// Reads <dir>/<kind>.json through the checks every manifest passes first; undefined when it must be skipped.
function loadManifest(repoRoot: string, dir: string, name: string, kind: 'module' | 'game', validator: Validator, problems: Problem[]): JsonObject | undefined {
  const file = `${dir}/${kind}.json`;
  if (!isFile(absPath(repoRoot, file))) {
    problems.push(error(dir, '', 'missing-file', `${kind}.json is missing`));
    return undefined;
  }
  if (!NAME.test(name)) {
    problems.push(error(dir, '', 'bad-id', `folder name ${name} does not match ${NAME.source}`));
    return undefined;
  }
  const parsed = readJson(absPath(repoRoot, file));
  if (!parsed.ok) {
    problems.push(error(file, '', 'json-parse', parsed.message, parsed.line));
    return undefined;
  }
  const invalid = validator.validate(`schemas/${kind}.schema.json`, parsed.value, file);
  if (invalid.length > 0) {
    problems.push(...invalid);
    return undefined;
  }
  const value = parsed.value as JsonObject;
  if (value.id !== name) {
    problems.push(error(file, '/id', 'bad-id', `id ${value.id} differs from folder name ${name}`));
    return undefined;
  }
  if (kind === 'module' && value.id === 'trace') {
    problems.push(error(file, '/id', 'bad-id', 'trace is a reserved id'));
    return undefined;
  }
  return value;
}

function checkSchemaPath(value: JsonObject, dir: string, kind: 'module' | 'game', problems: Problem[]): void {
  const expected = relativePosix(dir, `schemas/${kind}.schema.json`);
  if (value.$schema !== undefined && value.$schema !== expected) {
    problems.push(error(`${dir}/${kind}.json`, '/$schema', 'schema-path', `$schema is ${value.$schema}; expected ${expected}`));
  }
}

function withDir(dir: string, paths: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(paths ?? {}).map(([name, p]) => [name, joinPosix(dir, p)]));
}

function moduleInfo(raw: RawModule, dir: string): ModuleInfo {
  const operations: Record<string, OperationDecl> = {};
  for (const [name, op] of Object.entries(raw.operations ?? {})) {
    operations[name] = {};
    if (op.params !== undefined) operations[name].params = joinPosix(dir, op.params);
    if (op.result !== undefined) operations[name].result = joinPosix(dir, op.result);
  }
  const systems = (raw.systems ?? []).map((s, index) => ({ name: s.name, loop: s.loop, after: s.after ?? [], before: s.before ?? [], index }));
  const hosts = withDir(dir, raw.hosts);
  const contract = raw.contract === true;
  const info: ModuleInfo = {
    id: raw.id,
    dir,
    file: `${dir}/module.json`,
    contract,
    code: !contract && (systems.length > 0 || raw.state !== undefined || Object.keys(operations).length > 0 || Object.keys(hosts).length > 0),
    implements: raw.implements ?? [],
    requires: raw.requires ?? [],
    optional: raw.optional ?? [],
    types: withDir(dir, raw.types),
    events: withDir(dir, raw.events),
    operations,
    systems,
    hosts,
    packages: raw.packages ?? [],
  };
  if (raw.deprecated !== undefined) info.deprecated = raw.deprecated;
  if (raw.state !== undefined) info.state = joinPosix(dir, raw.state);
  if (raw.config !== undefined) info.config = { schema: joinPosix(dir, raw.config.schema), defaults: raw.config.defaults };
  return info;
}

// Declared paths that name no file, contract violations and duplicate or reserved system names: checks of one manifest alone.
function checkManifest(repoRoot: string, m: ModuleInfo, raw: JsonObject, problems: Problem[]): void {
  const paths: { path: string; pointer: string }[] = [];
  for (const [name, p] of Object.entries(m.types)) paths.push({ path: p, pointer: `/types/${name}` });
  for (const [name, p] of Object.entries(m.events)) paths.push({ path: p, pointer: `/events/${name}` });
  for (const [name, op] of Object.entries(m.operations)) {
    if (op.params !== undefined) paths.push({ path: op.params, pointer: `/operations/${name}/params` });
    if (op.result !== undefined) paths.push({ path: op.result, pointer: `/operations/${name}/result` });
  }
  if (m.state !== undefined) paths.push({ path: m.state, pointer: '/state' });
  if (m.config !== undefined) paths.push({ path: m.config.schema, pointer: '/config/schema' });
  for (const [host, p] of Object.entries(m.hosts)) paths.push({ path: p, pointer: `/hosts/${host}` });
  for (const { path, pointer } of paths) {
    if (!isFile(absPath(repoRoot, path))) problems.push(error(m.file, pointer, 'missing-file', `${path} does not exist`));
  }

  const seen = new Set<string>();
  for (const s of m.systems) {
    const pointer = `/systems/${s.index}/name`;
    if (RESERVED_SYSTEMS.includes(s.name)) problems.push(error(m.file, pointer, 'reserved-name', `system name ${s.name} is reserved`));
    if (seen.has(s.name)) problems.push(error(m.file, pointer, 'duplicate-name', `system ${s.name} is declared twice`));
    seen.add(s.name);
  }

  if (m.contract) {
    for (const key of CONTRACT_FORBIDS) {
      if (Object.hasOwn(raw, key)) problems.push(error(m.file, `/${key}`, 'contract-shape', `a contract cannot declare ${key}`));
    }
  }
}

// What a manifest says about other modules, checked against the whole root.
function checkLinks(index: RootIndex, m: ModuleInfo, problems: Problem[]): void {
  m.implements.forEach((x, i) => {
    const target = index.modules.get(x);
    if (!target) problems.push(error(m.file, `/implements/${i}`, 'unknown-module', `${x} is not a module of this root`));
    else if (!target.contract) problems.push(error(m.file, `/implements/${i}`, 'implements-contract', `${x} is not a contract`));
  });

  for (const list of ['requires', 'optional'] as const) {
    m[list].forEach((x, i) => {
      const pointer = `/${list}/${i}`;
      const target = index.modules.get(x);
      if (!target) {
        problems.push(list === 'requires'
          ? error(m.file, pointer, 'unknown-module', `${x} is not a module of this root`)
          : warning(m.file, pointer, 'unknown-module', `${x} is not a module of this root; treated as absent`));
        return;
      }
      if (x === m.id) {
        problems.push(error(m.file, pointer, 'bad-dependency', `${x} lists itself in ${list}`));
        return;
      }
      if (list === 'optional' && m.requires.includes(x)) problems.push(error(m.file, pointer, 'bad-dependency', `${x} is in both requires and optional`));
      const contracts = target.implements.join(', ');
      if (contracts !== '') problems.push(error(m.file, pointer, 'require-contract', `${x} implements contract ${contracts}; require ${contracts}`));
      if (target.deprecated !== undefined) problems.push(warning(m.file, pointer, 'deprecated', `${x} is deprecated: ${target.deprecated}`));
    });
  }

  const declaredBy = new Map<string, string>();   // operation name -> first implemented contract that declares it
  m.implements.forEach((x, i) => {
    const contract = index.modules.get(x);
    if (!contract?.contract) return;
    for (const name of Object.keys(contract.operations)) {
      if (Object.hasOwn(m.operations, name)) {
        problems.push(error(m.file, `/operations/${name}`, 'duplicate-name', `operation ${name} is also declared by contract ${x}`));
      } else if (declaredBy.has(name)) {
        problems.push(error(m.file, `/implements/${i}`, 'duplicate-name', `contracts ${declaredBy.get(name)} and ${x} both declare operation ${name}`));
      } else {
        declaredBy.set(name, x);
      }
    }
  });
}

// The type's current version: its schema's properties.$version.const, or 0 when that is missing or not a positive integer.
function typeVersion(repoRoot: string, schema: string): number {
  const abs = absPath(repoRoot, schema);
  const parsed = isFile(abs) ? readJson(abs) : undefined;
  const version = parsed?.ok ? getPointer(parsed.value, '/properties/$version/const') : undefined;
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : 0;
}

export function discover(repoRoot: string, root: string, validator: Validator): RootIndex {
  const index: RootIndex = { repoRoot, root, modules: new Map(), types: new Map(), games: new Map(), problems: [] };
  const problems = index.problems;
  const modulesDir = rootPath(root, 'modules');
  if (!isDir(absPath(repoRoot, modulesDir))) {
    problems.push(error(root, '', 'root-missing', `${root} has no modules folder`));
    return index;
  }

  const raws = new Map<string, JsonObject>();
  for (const d of listDirs(absPath(repoRoot, modulesDir))) {
    const dir = `${modulesDir}/${d}`;
    const raw = loadManifest(repoRoot, dir, d, 'module', validator, problems);
    if (!raw) continue;
    checkSchemaPath(raw, dir, 'module', problems);
    raws.set(d, raw);
    index.modules.set(d, moduleInfo(raw as unknown as RawModule, dir));
  }

  for (const m of index.modules.values()) checkManifest(repoRoot, m, raws.get(m.id)!, problems);
  for (const m of index.modules.values()) checkLinks(index, m, problems);

  const types: TypeInfo[] = [];
  for (const m of index.modules.values()) {
    for (const [name, schema] of Object.entries(m.types)) types.push({ id: `${m.id}.${name}`, module: m.id, name, schema, version: typeVersion(repoRoot, schema) });
  }
  for (const t of types.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) index.types.set(t.id, t);

  const gamesDir = rootPath(root, 'games');
  for (const g of listDirs(absPath(repoRoot, gamesDir))) {
    const dir = `${gamesDir}/${g}`;
    const value = loadManifest(repoRoot, dir, g, 'game', validator, problems);
    if (!value) continue;
    const game = value as unknown as RawGame;
    const info: GameInfo = { id: game.id, dir, file: `${dir}/game.json`, summary: game.summary, hosts: game.hosts, fixedHz: game.fixedHz, modules: game.modules };
    index.games.set(g, info);
    checkSchemaPath(value, dir, 'game', problems);
    for (const [id, entry] of Object.entries(game.modules)) {
      entry.hosts?.forEach((host, i) => {
        if (!game.hosts.includes(host)) problems.push(error(info.file, `/modules/${id}/hosts/${i}`, 'entry-host', `${host} is not a host of game ${game.id}`));
      });
    }
  }
  return index;
}
