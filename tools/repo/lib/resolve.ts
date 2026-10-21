// Turns a composition into the selected modules, their providers, load order and visibility for one host.
import type { Composition } from './composition.ts';
import { sees } from './discover.ts';
import type { RootIndex } from './discover.ts';
import { joinPointer } from './json.ts';
import { error, warning } from './problems.ts';
import type { Problem } from './problems.ts';

export interface Resolution {
  selected: string[];                 // every selected module and contract id, sorted
  order: string[];                    // selected non-contract ids, load order
  contracts: Record<string, string>;  // selected contract -> its single selected implementation
  sees: Record<string, string[]>;     // per id in order: sorted visible ids in this composition
  absent: Record<string, string[]>;   // per id in order: sorted optional ids not selected
  problems: Problem[];
}

// Kahn's algorithm over the nodes 0..count-1, always taking the smallest ready node; an edge is [first, then].
// A cycle keeps nodes back: `left` lists them, smallest first. `cycle` is the loop found by walking from left[0] to the smallest
// node each one waits for, with the repeated node at both ends; it is empty when nothing is left. Shared with schedule.ts.
export function topoSort(count: number, edges: readonly (readonly [number, number])[]): { placed: number[]; left: number[]; cycle: number[] } {
  const waitsFor = Array.from({ length: count }, () => new Set<number>());
  for (const [first, then] of edges) waitsFor[then].add(first);
  const placed: number[] = [];
  const done = new Set<number>();
  for (;;) {
    const next = waitsFor.findIndex((waits, node) => !done.has(node) && [...waits].every((w) => done.has(w)));
    if (next < 0) break;
    placed.push(next);
    done.add(next);
  }
  const left = waitsFor.flatMap((_, node) => (done.has(node) ? [] : [node]));
  const cycle: number[] = [];
  if (left.length > 0) {
    const walk = [left[0]];
    for (;;) {
      const next = Math.min(...[...waitsFor[walk[walk.length - 1]]].filter((node) => !done.has(node)));
      const seen = walk.indexOf(next);
      if (seen >= 0) {
        cycle.push(...walk.slice(seen), next);
        break;
      }
      walk.push(next);
    }
  }
  return { placed, left, cycle };
}

export function resolve(index: RootIndex, composition: Composition, host: string): Resolution {
  const problems: Problem[] = [];
  const modules = index.modules;

  for (const key of Object.keys(composition.modules)) {
    const at = joinPointer(composition.pointer, key);
    const m = modules.get(key);
    if (m === undefined) problems.push(error(composition.file, at, 'unknown-module', `${key} is not a module of this root`));
    else if (m.deprecated !== undefined) problems.push(warning(composition.file, at, 'deprecated', `${key} is deprecated: ${m.deprecated}`));
  }

  // The keys built for this host; an entry for another host, its config included, plays no part below.
  const keys = Object.entries(composition.modules)
    .filter(([id, entry]) => modules.has(id) && (entry.hosts === undefined || entry.hosts.includes(host)))
    .map(([id]) => id);
  const picked = new Set<string>();
  const pick = (id: string): void => {
    const m = modules.get(id);
    if (m === undefined || picked.has(id)) return;
    picked.add(id);
    for (const dependency of [...m.implements, ...m.requires]) pick(dependency);
  };
  keys.forEach(pick);
  const selected = [...picked].sort();

  const provider = new Map<string, string>();
  for (const id of selected.filter((x) => modules.get(x)!.contract)) {
    const found = keys.filter((key) => modules.get(key)!.implements.includes(id)).sort();
    if (found.length === 1) {
      provider.set(id, found[0]);
    } else if (found.length > 1) {
      problems.push(error(composition.file, composition.pointer, 'one-provider', `contract ${id} has ${found.length} implementations selected: ${found.join(', ')}; keep one`));
    } else {
      const options = [...modules.values()].filter((m) => m.implements.includes(id) && Object.hasOwn(m.hosts, host)).map((m) => m.id).sort();
      const advice = options.length > 0 ? `add one of: ${options.join(', ')}` : `no module implements it for host ${host}`;
      problems.push(error(composition.file, composition.pointer, 'no-provider', `contract ${id} has no implementation selected; ${advice}`));
    }
  }

  for (const id of selected) {
    const m = modules.get(id)!;
    // An implementation runs its contracts' operations, so it needs an entry even when it declares nothing else.
    const provides = m.implements.some((c) => Object.keys(modules.get(c)?.operations ?? {}).length > 0);
    if ((m.code || provides) && !Object.hasOwn(m.hosts, host)) problems.push(error(m.file, '/hosts', 'no-host-entry', `${id} has no entry for host ${host}, needed by ${composition.file}`));
  }

  const loadable = selected.filter((id) => !modules.get(id)!.contract);
  const rank = new Map(loadable.map((id, i) => [id, i]));
  const rankOf = (id: string): number | undefined => {   // a contract stands for its implementation
    const rep = modules.get(id)?.contract ? provider.get(id) : id;
    return rep === undefined ? undefined : rank.get(rep);
  };
  const edges: [number, number][] = [];
  for (const id of selected) {
    const a = modules.get(id)!;
    const then = rankOf(id);
    if (then === undefined) continue;
    for (const dependency of [...a.requires, ...a.optional.filter((x) => picked.has(x))]) {
      const first = rankOf(dependency);
      if (first !== undefined && first !== then) edges.push([first, then]);
    }
  }
  const { placed, left, cycle } = topoSort(loadable.length, edges);
  if (cycle.length > 0) problems.push(error(composition.file, composition.pointer, 'cycle', `requires cycle: ${cycle.map((i) => loadable[i]).join(' -> ')}`));
  const order = [...placed, ...left].map((i) => loadable[i]);   // ids held back by a cycle follow in id order, so every selected module is listed

  const visible: Record<string, string[]> = {};
  const absent: Record<string, string[]> = {};
  for (const id of order) {
    const m = modules.get(id)!;
    visible[id] = sees(m).filter((x) => picked.has(x));
    absent[id] = m.optional.filter((x) => !picked.has(x)).sort();
  }
  return { selected, order, contracts: Object.fromEntries(provider), sees: visible, absent, problems };
}
