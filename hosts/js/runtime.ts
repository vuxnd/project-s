// Runtime for JavaScript hosts: loads a format 1 bundle and runs its fixed and frame loops (contract C5, plan.md 4.9).

export const FORMATS: readonly number[] = [1];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface BundleModule {
  id: string;
  entry: string;
  sees: string[];
  absent: string[];
  packages: string[];
}

export interface BundleSchemas {
  state: Record<string, string>;
  events: Record<string, string>;
  params: Record<string, string>;
  results: Record<string, string>;
}

export interface Bundle {
  format: number;
  game: string;
  host: string;
  fixedHz: number;
  modules: BundleModule[];
  contracts: Record<string, string>;
  operations: Record<string, string>;
  events: Record<string, string>;
  types: Record<string, number>;
  config: Record<string, JsonObject>;
  records: Record<string, Record<string, JsonObject>>;
  assets: string[];
  schedule: { fixed: string[]; frame: string[] };
  schemas?: BundleSchemas;
}

export interface Ctx<S = unknown, C = unknown, H = unknown> {
  readonly module: string;
  state: S;
  readonly config: Readonly<C>;
  configOf<T = unknown>(id: string): Readonly<T>;
  records<T = unknown>(type: string): Readonly<Record<string, Readonly<T>>>;
  events<T = unknown>(id: string): readonly T[];
  emit(id: string, payload: unknown): void;
  call<R = unknown>(id: string, params?: unknown): R;
  has(id: string): boolean;
  readonly tick: number;
  readonly dt: number;
  readonly alpha: number;
  readonly host: H;
}

export type OperationFn = (ctx: Ctx, params: unknown) => unknown;

export interface ModuleEntry {
  init?: (ctx: Ctx) => unknown;
  operations?: Record<string, OperationFn>;
  [name: string]: unknown;
}

export interface GameEvent {
  event: string;
  payload: unknown;
}

export interface LoadOptions {
  root?: string;                                            // prefix for entry paths; default ''
  host?: unknown;                                           // becomes ctx.host
  debug?: boolean;
  importer?: (entry: string) => Promise<ModuleEntry>;       // default: (entry) => import(root + entry)
  validate?: (schema: string, value: unknown) => string | null;   // null when valid
}

export interface Game {
  readonly bundle: Bundle;
  readonly ticks: number;                                   // completed fixed ticks
  tick(inputs?: readonly GameEvent[]): GameEvent[];
  frame(dt: number, alpha: number): GameEvent[];
  call(id: string, params?: unknown): unknown;
  snapshot(): Record<string, unknown>;
}

interface Loaded { entry: ModuleEntry; ctx: Ctx; ready: boolean }
interface Step { mod: Loaded; fn: (ctx: Ctx) => unknown }
// What exists only while a fixed or frame run is in progress.
interface Run { loop: 'fixed' | 'frame'; dt: number; alpha: number; delivered: GameEvent[]; emitted: GameEvent[] }

const EMPTY: object = Object.freeze({});

const owner = (id: string): string => id.split('.')[0];
const nameOf = (id: string): string => id.slice(id.indexOf('.') + 1);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

// R18's JSON-clean copy: null, booleans, finite numbers, strings, arrays and plain objects, with -0 turned into 0. Anything else throws, a cycle included.
function jsonCopy(value: unknown, kind: string, id: string): unknown {
  const open = new Set<object>();
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v === 0 ? 0 : v;
    if (typeof v === 'object' && !open.has(v)) {
      const proto = Object.getPrototypeOf(v);
      if (Array.isArray(v) || proto === Object.prototype || proto === null) {
        open.add(v);
        const out = Array.isArray(v) ? Array.from(v, copy) : Object.fromEntries(Object.entries(v).map(([key, item]) => [key, copy(item)]));
        open.delete(v);
        return out;
      }
    }
    throw new Error(`${kind} not JSON: ${id}`);
  };
  return copy(value);
}

// R12: an id the caller may see must also be declared.
function declared(map: object, id: string): void {
  if (!Object.hasOwn(map, id)) throw new Error(`unknown: ${id}`);
}

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export async function load(bundle: Bundle, options: LoadOptions = {}): Promise<Game> {
  if (!FORMATS.includes(bundle.format)) throw new Error(`bundle format ${bundle.format}; this host reads ${FORMATS.join(', ')}`);
  const root = options.root ?? '';
  const importer = options.importer ?? ((entry: string): Promise<ModuleEntry> => import(root + entry));
  const debug = options.debug === true;
  const schemas = bundle.schemas;
  const stepDt = 1 / bundle.fixedHz;
  const frameWanted = bundle.schedule.frame.length > 0;
  deepFreeze(bundle.config);
  deepFreeze(bundle.records);

  const loaded = new Map<string, Loaded>();
  const operations = new Map<string, { provider: Loaded; fn: OperationFn }>();
  let ticks = 0;
  let run: Run | null = null;
  let fixedInbox: GameEvent[] = [];
  let frameInbox: GameEvent[] = [];

  // R18 (d): for a schema the bundle names. Callers are debug-mode paths.
  const validated = (kind: string, id: string, schema: string | undefined, value: unknown): void => {
    if (!options.validate || schema === undefined) return;
    const problem = options.validate(schema, value);
    if (problem !== null) throw new Error(`invalid ${kind} for ${id}: ${problem}`);
  };

  // R18 (a): a module's state must be JSON-clean after init, each of its systems and each operation call on it.
  const checkState = (mod: Loaded): void => {
    const id = mod.ctx.module;
    const state = mod.ctx.state;
    if (!debug || state === undefined) return;
    jsonCopy(state, 'state', id);
    validated('state', id, schemas?.state[id], state);
  };

  // R18 (b): the payload an emit or an input delivers.
  const payloadOf = (id: string, payload: unknown): unknown => {
    if (!debug) return payload;
    const copy = deepFreeze(jsonCopy(payload, 'event', id));
    validated('event', id, schemas?.events[id], copy);
    return copy;
  };

  // R16, R18, R9: shared by ctx.call and game.call. While a frame run is in progress, every call is watched, nested ones too.
  const runOperation = (id: string, params: unknown): unknown => {
    declared(bundle.operations, id);
    const op = operations.get(id);
    if (!op?.provider.ready) throw new Error(`not initialized: ${id}`);
    const { provider, fn } = op;
    if (debug) {
      if (params !== undefined) jsonCopy(params, 'params', id);
      validated('params', id, schemas?.params[id], params);
    }
    const watched = debug && run?.loop === 'frame';
    const before = watched ? JSON.stringify(provider.ctx.state) : undefined;
    const result = fn(provider.ctx, params);
    if (isThenable(result)) throw new Error(`operation returned a promise: ${id}`);
    if (!debug) return result;
    checkState(provider);
    if (watched && JSON.stringify(provider.ctx.state) !== before) throw new Error(`frame call changed state: ${id}`);
    const copy = result === undefined ? undefined : deepFreeze(jsonCopy(result, 'result', id));
    validated('result', id, schemas?.results[id], copy);
    return copy;
  };

  // R17: one ctx per module for the life of the game; `state` is a plain property, so a ctx kept from init always sees the current state.
  const makeCtx = (m: BundleModule): Ctx => {
    const sees = new Set(m.sees);
    const absent = new Set(m.absent);
    // R10 and R11: true when the id's owner is absent; throws when the module neither sees it nor lists it as absent.
    const isAbsent = (id: string): boolean => {
      const who = owner(id);
      if (absent.has(who)) return true;
      if (!sees.has(who)) throw new Error(`not visible: ${id} from ${m.id}`);
      return false;
    };
    return {
      module: m.id,
      state: undefined,
      config: bundle.config[m.id] ?? EMPTY,
      host: options.host,
      get tick() { return ticks; },
      get dt() { return run?.dt ?? stepDt; },
      get alpha() { return run?.alpha ?? 0; },
      configOf(id) {
        if (isAbsent(id)) throw new Error(`absent: ${id}`);
        declared(bundle.config, id);
        return bundle.config[id] as never;
      },
      records(type) {
        if (isAbsent(type)) return EMPTY as never;
        declared(bundle.types, type);
        return (bundle.records[type] ?? EMPTY) as never;
      },
      events(id) {
        if (isAbsent(id)) return [];
        declared(bundle.events, id);
        return (run?.delivered ?? []).filter((e) => e.event === id).map((e) => e.payload) as never;
      },
      emit(id, payload) {
        if (isAbsent(id)) return;
        declared(bundle.events, id);
        const e = { event: id, payload: payloadOf(id, payload) };
        fixedInbox.push(e);
        if (frameWanted) frameInbox.push(e);
        run?.emitted.push(e);
      },
      call(id, params) {
        if (isAbsent(id)) throw new Error(`absent: ${id}`);
        return runOperation(id, params) as never;
      },
      has(id) {
        return !isAbsent(id);
      },
    };
  };

  // R2
  for (const m of bundle.modules) loaded.set(m.id, { entry: await importer(m.entry), ctx: makeCtx(m), ready: false });
  const resolveStep = (id: string): Step => {
    const mod = loaded.get(owner(id));
    const fn = mod?.entry[nameOf(id)];
    if (mod === undefined || typeof fn !== 'function') throw new Error(`missing system: ${id}`);
    return { mod, fn: fn as (ctx: Ctx) => unknown };
  };
  const steps = { fixed: bundle.schedule.fixed.map(resolveStep), frame: bundle.schedule.frame.map(resolveStep) };
  for (const [id, providerId] of Object.entries(bundle.operations)) {
    const provider = loaded.get(providerId);
    if (provider === undefined) continue;
    const ops = provider.entry.operations ?? {};
    const fn = Object.hasOwn(ops, nameOf(id)) ? ops[nameOf(id)] : undefined;
    if (typeof fn !== 'function') throw new Error(`missing operation: ${id}`);
    operations.set(id, { provider, fn });
  }

  // R3
  for (const mod of loaded.values()) {
    mod.ctx.state = await mod.entry.init?.(mod.ctx);
    mod.ready = true;
    checkState(mod);
  }

  const execute = (loop: 'fixed' | 'frame', dt: number, alpha: number, delivered: GameEvent[]): GameEvent[] => {
    const current: Run = { loop, dt, alpha, delivered, emitted: [] };
    run = current;
    try {
      for (const step of steps[loop]) {
        step.fn(step.mod.ctx);
        checkState(step.mod);
      }
    } finally {
      run = null;
    }
    return current.emitted;
  };

  return {
    bundle,
    get ticks() { return ticks; },
    tick(inputs = []) {
      const given = inputs.map((input) => {
        declared(bundle.events, input.event);
        return { event: input.event, payload: payloadOf(input.event, input.payload) };
      });
      const inbox = fixedInbox;
      fixedInbox = [];
      const emitted = execute('fixed', stepDt, 0, [...inbox, ...given]);
      ticks += 1;
      return emitted;
    },
    frame(dt, alpha) {
      const inbox = frameInbox;
      frameInbox = [];
      return execute('frame', dt, alpha, inbox);
    },
    call(id, params) {
      return runOperation(id, params);
    },
    snapshot() {
      const out: Record<string, unknown> = {};
      for (const mod of loaded.values()) {
        if (mod.ctx.state !== undefined) out[mod.ctx.module] = jsonCopy(mod.ctx.state, 'state', mod.ctx.module);
      }
      return out;
    },
  };
}
