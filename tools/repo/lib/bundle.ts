// Builds the format 1 bundle of one composition for one host (plan.md 4.7.4).
import type { Bundle } from '../../../hosts/js/runtime.ts';
import type { Composition } from './composition.ts';
import { resolveConfig } from './config.ts';
import type { RecordInfo } from './content.ts';
import type { RootIndex } from './discover.ts';
import { joinPosix } from './fsx.ts';
import type { JsonObject } from './json.ts';
import { hasErrors } from './problems.ts';
import type { Problem } from './problems.ts';
import { resolve } from './resolve.ts';
import type { Resolution } from './resolve.ts';
import { schedule } from './schedule.ts';
import type { Validator } from './validate.ts';

export interface BuildInput {
  index: RootIndex;
  records: readonly RecordInfo[];
  composition: Composition;
  host: string;
  game: string;
  fixedHz: number;
  validator: Validator;
}

// The entries as an object whose keys are in JavaScript's default string order.
function sorted<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function bundlePath(root: string, game: string, host: string): string {
  return joinPosix('build', root, 'games', game, host, 'bundle.json');
}

export function buildBundle(input: BuildInput): { bundle?: Bundle; resolution: Resolution; problems: Problem[] } {
  const { index, composition, host } = input;
  const resolution = resolve(index, composition, host);
  const scheduled = schedule(index, resolution);
  // resolve skips an entry for another host with its config (4.8.5 step 2); resolveConfig has no host parameter, so it gets only the entries of this one.
  const entries = Object.entries(composition.modules).filter(([, entry]) => entry.hosts === undefined || entry.hosts.includes(host));
  const configured = resolveConfig(index, resolution, { ...composition, modules: Object.fromEntries(entries) }, input.validator);
  const problems = [...resolution.problems, ...scheduled.problems, ...configured.problems];
  if (hasErrors(problems)) return { resolution, problems };

  const operations: [string, string][] = [];
  const events: [string, string][] = [];
  const types: [string, number][] = [];
  const schemas = { state: [] as [string, string][], events: [] as [string, string][], params: [] as [string, string][], results: [] as [string, string][] };
  for (const id of resolution.selected) {
    const m = index.modules.get(id)!;
    const provider = m.contract ? resolution.contracts[id] : id;
    for (const [name, op] of Object.entries(m.operations)) {
      operations.push([`${id}.${name}`, provider]);
      if (op.params !== undefined) schemas.params.push([`${id}.${name}`, op.params]);
      if (op.result !== undefined) schemas.results.push([`${id}.${name}`, op.result]);
    }
    for (const [name, schema] of Object.entries(m.events)) {
      events.push([`${id}.${name}`, id]);
      schemas.events.push([`${id}.${name}`, schema]);
    }
    for (const name of Object.keys(m.types)) types.push([`${id}.${name}`, index.types.get(`${id}.${name}`)!.version]);
    if (m.code && m.state !== undefined) schemas.state.push([id, m.state]);
  }

  const selected = new Set(resolution.selected);
  const included = input.records.filter((r) => r.module === 'trace' || selected.has(r.module));
  const byType = new Map<string, [string, JsonObject][]>();
  for (const r of included) byType.set(r.type, [...(byType.get(r.type) ?? []), [r.id, r.body]]);

  const bundle: Bundle = {
    format: 1,
    game: input.game,
    host,
    fixedHz: input.fixedHz,
    modules: resolution.order.flatMap((id) => {
      const m = index.modules.get(id)!;
      return m.code ? [{ id, entry: m.hosts[host], sees: [...resolution.sees[id]], absent: [...resolution.absent[id]], packages: [...m.packages].sort() }] : [];
    }),
    contracts: sorted(Object.entries(resolution.contracts)),
    operations: sorted(operations),
    events: sorted(events),
    types: sorted(types),
    config: sorted(Object.entries(configured.config)),
    records: sorted([...byType].map(([type, list]) => [type, sorted(list)] as const)),
    assets: [...new Set(included.flatMap((r) => r.assets))].sort(),
    schedule: { fixed: scheduled.fixed, frame: scheduled.frame },
    schemas: { state: sorted(schemas.state), events: sorted(schemas.events), params: sorted(schemas.params), results: sorted(schemas.results) },
  };
  return { bundle, resolution, problems };
}
