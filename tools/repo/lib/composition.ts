// The module selection of a game or a trace, in the one shape resolve, schedule and config read.
import type { GameInfo, ModuleInfo } from './discover.ts';
import type { Json, JsonObject } from './json.ts';

export interface TraceExpect {
  at?: number; call?: string; params?: Json; pointer?: string; equals?: Json; near?: number; within?: number;
  by?: number; emitted?: string; count?: number;
}
export interface TraceDoc {
  summary: string;
  fixedHz: number;
  ticks: number;
  modules?: string[];
  config?: Record<string, JsonObject>;
  records?: Record<string, Record<string, JsonObject>>;
  inputs?: { at: number; event: string; payload: Json }[];
  expect: TraceExpect[];
}
export interface Composition {
  file: string;                                                        // game.json or trace file, for problems
  pointer: string;                                                     // '/modules' for a game, '' for a trace
  modules: Record<string, { config?: JsonObject; hosts?: string[] }>;  // selection, authored order
}

export function gameComposition(game: GameInfo): Composition {
  return {
    file: game.file,
    pointer: '/modules',
    modules: Object.fromEntries(Object.entries(game.modules).map(([id, entry]) => [id, structuredClone(entry)])),
  };
}

export function traceComposition(contract: ModuleInfo, implementation: ModuleInfo, trace: TraceDoc, traceFile: string): Composition {
  const ids = [contract.id, implementation.id, ...(trace.modules ?? [])];
  const entry = (id: string): Composition['modules'][string] =>
    trace.config !== undefined && Object.hasOwn(trace.config, id) ? { config: structuredClone(trace.config[id]) } : {};
  return { file: traceFile, pointer: '', modules: Object.fromEntries(ids.map((id) => [id, entry(id)])) };
}
