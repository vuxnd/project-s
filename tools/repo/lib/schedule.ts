// Orders the systems of the selected modules into the fixed and frame loops.
import type { ModuleInfo, RootIndex, SystemDecl } from './discover.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';
import { topoSort } from './resolve.ts';
import type { Resolution } from './resolve.ts';

export interface Schedule { fixed: string[]; frame: string[]; problems: Problem[] }

interface Node { id: string; module: ModuleInfo; system: SystemDecl }

function scheduleLoop(index: RootIndex, resolution: Resolution, loop: 'fixed' | 'frame', problems: Problem[]): string[] {
  const selected = new Set(resolution.selected);
  const nodes: Node[] = [];
  for (const id of resolution.order) {
    const module = index.modules.get(id);
    if (module === undefined) continue;
    for (const system of module.systems) {
      if (system.loop === loop) nodes.push({ id: `${id}.${system.name}`, module, system });
    }
  }
  const nodesOf = (module: string): number[] => nodes.flatMap((node, i) => (node.module.id === module ? [i] : []));

  // The nodes an after/before entry of `from` orders against; a problem is reported once, here.
  const targets = (from: Node, entry: string, pointer: string): number[] => {
    const dot = entry.indexOf('.');
    const id = dot < 0 ? entry : entry.slice(0, dot);
    const name = dot < 0 ? undefined : entry.slice(dot + 1);
    const target = index.modules.get(id);
    if (target === undefined) {
      if (!from.module.optional.includes(id)) problems.push(error(from.module.file, pointer, 'unknown-ref', `${entry} is not a module or system of this root`));
      return [];   // an optional module that was removed from the root is ignored
    }
    if (name === undefined) {
      if (!selected.has(id)) return [];
      return nodesOf(target.contract && Object.hasOwn(resolution.contracts, id) ? resolution.contracts[id] : id);
    }
    const system = target.systems.find((s) => s.name === name);
    if (system === undefined) {
      problems.push(error(from.module.file, pointer, 'unknown-ref', `${entry} is not a module or system of this root`));
      return [];
    }
    if (!selected.has(id)) return [];
    if (system.loop !== loop) {
      problems.push(error(from.module.file, pointer, 'loop-mismatch', `${entry} is a ${system.loop} system; ${from.id} is a ${loop} system`));
      return [];
    }
    return nodes.flatMap((node, i) => (node.id === entry ? [i] : []));
  };

  const edges: [number, number][] = [];
  nodes.forEach((node, i) => {
    if (i > 0 && nodes[i - 1].module === node.module) edges.push([i - 1, i]);
    for (const kind of ['after', 'before'] as const) {
      node.system[kind].forEach((entry, j) => {
        for (const target of targets(node, entry, `/systems/${node.system.index}/${kind}/${j}`)) edges.push(kind === 'after' ? [target, i] : [i, target]);
      });
    }
  });

  const { placed, left, cycle } = topoSort(nodes.length, edges);
  if (cycle.length > 0) {
    const smallest = nodes[left[0]];
    problems.push(error(smallest.module.file, `/systems/${smallest.system.index}`, 'cycle', `system cycle: ${cycle.map((i) => nodes[i].id).join(' -> ')}`));
  }
  return [...placed, ...left].map((i) => nodes[i].id);   // nodes held back by a cycle follow in schedule order
}

export function schedule(index: RootIndex, resolution: Resolution): Schedule {
  const problems: Problem[] = [];
  const fixed = scheduleLoop(index, resolution, 'fixed', problems);
  const frame = scheduleLoop(index, resolution, 'frame', problems);
  return { fixed, frame, problems };
}
