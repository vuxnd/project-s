// Tests for hosts/js/runtime.ts: rules R1 to R22 of plan.md 4.9.2, with inline bundles and inline module entries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { FORMATS, load } from '../runtime.ts';
import type { Bundle, BundleModule, Ctx, Game, GameEvent, LoadOptions, ModuleEntry } from '../runtime.ts';

// V8 hands out `gc` only with --expose-gc, which the test command does not pass, so the flag is set at run time.
v8.setFlagsFromString('--expose-gc');
const collectGarbage = vm.runInNewContext('gc') as () => void;

// Entry paths are module ids; the importer hands out the inline entries and records the order it was asked in.
function importerOf(entries: Record<string, ModuleEntry>, asked: string[] = []): NonNullable<LoadOptions['importer']> {
  return async (entry) => {
    asked.push(entry);
    return entries[entry];
  };
}

function moduleOf(id: string, patch: Partial<BundleModule> = {}): BundleModule {
  return { id, entry: id, sees: [id], absent: [], packages: [], ...patch };
}

// A 50 Hz bundle with the one module `m`, which declares the event `m.e`, and nothing scheduled.
function bundleOf(patch: Partial<Bundle> = {}): Bundle {
  return {
    format: 1, game: 'g', host: 'node', fixedHz: 50,
    modules: [moduleOf('m')], contracts: {}, operations: {}, events: { 'm.e': 'm' }, types: {}, config: { m: {} }, records: {}, assets: [],
    schedule: { fixed: [], frame: [] },
    ...patch,
  };
}

const schedule = (fixed: string[], frame: string[] = []): Partial<Bundle> => ({ schedule: { fixed, frame } });
const ev = (payload: unknown): GameEvent => ({ event: 'm.e', payload });

// Loads `entry` as the module `m` of bundleOf(patch).
function loadOne(entry: ModuleEntry, patch: Partial<Bundle> = {}, options: LoadOptions = {}): Promise<Game> {
  return load(bundleOf(patch), { importer: importerOf({ m: entry }), ...options });
}

// An entry whose init keeps its ctx in `kept`; R17 lets a kept ctx be used outside a run.
function keeping(kept: Record<string, Ctx>, id: string, entry: ModuleEntry = {}): ModuleEntry {
  return { ...entry, init(ctx: Ctx) { kept[id] = ctx; return entry.init?.(ctx); } };
}

// Module a sees itself and b and lists ghost as absent; c is in the bundle but a cannot see it. Returns a's ctx and a game.
async function visibility(debug = false): Promise<{ a: Ctx; game: Game }> {
  const kept: Record<string, Ctx> = {};
  const bundle = bundleOf({
    modules: [moduleOf('a', { sees: ['a', 'b'], absent: ['ghost'] }), moduleOf('b'), moduleOf('c')],
    operations: { 'b.op': 'b', 'c.op': 'c' },
    events: { 'b.ping': 'b', 'c.ping': 'c' },
    types: { 'b.item': 1, 'b.none': 1, 'c.item': 1 },
    config: { a: {}, b: { speed: 2 }, c: {} },
    records: { 'b.item': { 'b/one': { n: 1 } }, 'c.item': { 'c/one': { n: 2 } } },
  });
  const provider: ModuleEntry = { operations: { op: () => 'done' } };
  const game = await load(bundle, { debug, importer: importerOf({ a: keeping(kept, 'a'), b: provider, c: provider }) });
  return { a: kept.a, game };
}

test('R1 load rejects a bundle format the host does not read', async () => {
  assert.deepEqual(FORMATS, [1]);
  const asked: string[] = [];
  await assert.rejects(load(bundleOf({ format: 2 }), { importer: importerOf({ m: {} }, asked) }), { message: 'bundle format 2; this host reads 1' });
  assert.deepEqual(asked, []);
  assert.equal((await loadOne({})).bundle.format, 1);
});

test('R2 load imports every entry in bundle order', async () => {
  const asked: string[] = [];
  const bundle = bundleOf({ modules: [moduleOf('b', { entry: 'mods/b/ts/index.ts' }), moduleOf('a', { entry: 'mods/a/ts/index.ts' })], config: { a: {}, b: {} } });
  await load(bundle, { importer: importerOf({ 'mods/a/ts/index.ts': {}, 'mods/b/ts/index.ts': {} }, asked) });
  assert.deepEqual(asked, ['mods/b/ts/index.ts', 'mods/a/ts/index.ts']);
});

test('R2 without an importer, load imports root + entry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'm', 'ts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'ts', 'index.ts'), 'export function init(): { from: string } { return { from: \'file\' }; }\n');
  const game = await load(bundleOf({ modules: [moduleOf('m', { entry: 'm/ts/index.ts' })] }), { root: pathToFileURL(dir + path.sep).href });
  assert.deepEqual(game.snapshot(), { m: { from: 'file' } });
});

test('R2 a scheduled system its owner does not export is missing', async () => {
  await assert.rejects(loadOne({ run() {} }, schedule(['m.run'], ['m.draw'])), { message: 'missing system: m.draw' });
  await assert.rejects(loadOne({ run: 1 }, schedule(['m.run'])), { message: 'missing system: m.run' });
  await assert.rejects(loadOne({}, schedule(['ghost.run'])), { message: 'missing system: ghost.run' });
});

test('R2 an operation its loaded provider does not export is missing', async () => {
  await assert.rejects(loadOne({}, { operations: { 'm.op': 'm' } }), { message: 'missing operation: m.op' });
  await assert.rejects(loadOne({ operations: {} }, { operations: { 'm.op': 'm' } }), { message: 'missing operation: m.op' });
  await loadOne({}, { operations: { 'ghost.op': 'ghost' } }); // a provider that is not a loaded module is not checked
  await assert.rejects(loadOne({ operations: {} }, { operations: { 'm.constructor': 'm' } }), { message: 'missing operation: m.constructor' });
});

test('R3 init runs after all imports in module order and its awaited result becomes the state', async () => {
  const log: string[] = [];
  const stating = (id: string, state: unknown): ModuleEntry => ({ async init() { log.push(`init ${id}`); return state; } });
  const bundle = bundleOf({ modules: [moduleOf('a'), moduleOf('b'), moduleOf('c')], config: { a: {}, b: {}, c: {} } });
  const game = await load(bundle, { importer: importerOf({ a: stating('a', { x: 1 }), b: stating('b', 2), c: {} }, log) });
  assert.deepEqual(log, ['a', 'b', 'c', 'init a', 'init b']);
  assert.deepEqual(game.snapshot(), { a: { x: 1 }, b: 2 });
});

test('R3 during init tick is 0, dt is 1 / fixedHz, alpha is 0 and events() is empty', async () => {
  let seen: unknown;
  await loadOne({ init(ctx: Ctx) { seen = { tick: ctx.tick, dt: ctx.dt, alpha: ctx.alpha, events: ctx.events('m.e') }; } });
  assert.deepEqual(seen, { tick: 0, dt: 1 / 50, alpha: 0, events: [] });
});

test('R3 events emitted by init reach the first fixed run and, with frame systems, the first frame run', async () => {
  const seen: string[] = [];
  const entry: ModuleEntry = {
    init(ctx: Ctx) { ctx.emit('m.e', 'from init'); },
    run(ctx: Ctx) { seen.push(`run ${ctx.events('m.e')}`); },
    draw(ctx: Ctx) { seen.push(`draw ${ctx.events('m.e')}`); },
  };
  const game = await loadOne(entry, schedule(['m.run'], ['m.draw']));
  game.tick();
  game.frame(0.01, 0);
  assert.deepEqual(seen, ['run from init', 'draw from init']);
});

test('R3 ctx.call works for providers whose init has completed', async () => {
  const bundle = bundleOf({
    modules: [moduleOf('a', { sees: ['a', 'b'] }), moduleOf('b', { sees: ['a', 'b'] })],
    operations: { 'a.op': 'a', 'b.op': 'b' },
    config: { a: {}, b: {} },
  });
  const operations = { op: () => 'ok' };
  const early: ModuleEntry = { operations, init: (ctx: Ctx) => ctx.call('b.op') };
  await assert.rejects(load(bundle, { importer: importerOf({ a: early, b: { operations } }) }), { message: 'not initialized: b.op' });
  let got: unknown;
  const late: ModuleEntry = { operations, init: (ctx: Ctx) => { got = ctx.call('a.op'); } };
  await load(bundle, { importer: importerOf({ a: { operations }, b: late }) });
  assert.equal(got, 'ok');
});

test('R4 tick runs the fixed systems once in schedule order and counts completed ticks', async () => {
  const seen: string[] = [];
  const system = (id: string): ModuleEntry => ({ run(ctx: Ctx) { seen.push(`${id} tick=${ctx.tick} dt=${ctx.dt} alpha=${ctx.alpha}`); } });
  const bundle = bundleOf({ modules: [moduleOf('a'), moduleOf('b')], config: { a: {}, b: {} }, ...schedule(['b.run', 'a.run']) });
  const game = await load(bundle, { importer: importerOf({ a: system('a'), b: system('b') }) });
  game.tick();
  game.tick();
  assert.deepEqual(seen, ['b tick=0 dt=0.02 alpha=0', 'a tick=0 dt=0.02 alpha=0', 'b tick=1 dt=0.02 alpha=0', 'a tick=1 dt=0.02 alpha=0']);
  assert.equal(game.ticks, 2);
});

test('R5 an event emitted in tick N is seen once, by every system of tick N+1', async () => {
  const seen: string[] = [];
  const entry: ModuleEntry = {
    first(ctx: Ctx) { seen.push(`first [${ctx.events('m.e')}]`); ctx.emit('m.e', ctx.tick); },
    second(ctx: Ctx) { seen.push(`second [${ctx.events('m.e')}]`); },
  };
  const game = await loadOne(entry, schedule(['m.first', 'm.second']));
  game.tick();
  game.tick();
  game.tick();
  assert.deepEqual(seen, ['first []', 'second []', 'first [0]', 'second [0]', 'first [1]', 'second [1]']);
});

test('R5 inputs follow the emitted events and reach only the tick they were given to', async () => {
  const seen: unknown[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) {
      seen.push(ctx.events('m.e'));
      if (ctx.tick === 0) ctx.emit('m.e', 'emitted');
    },
  };
  const game = await loadOne(entry, schedule(['m.run']));
  game.tick([ev('input 0')]);
  game.tick([ev('input 1')]);
  game.tick();
  assert.deepEqual(seen, [['input 0'], ['emitted', 'input 1'], []]);
});

test('R5 events(id) returns only the payloads of event id', async () => {
  const seen: unknown[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) {
      seen.push(ctx.events('m.e'), ctx.events('m.f'));
      if (ctx.tick === 0) { ctx.emit('m.e', 'e1'); ctx.emit('m.f', 'f1'); ctx.emit('m.e', 'e2'); }
    },
  };
  const game = await loadOne(entry, { ...schedule(['m.run']), events: { 'm.e': 'm', 'm.f': 'm' } });
  game.tick();
  game.tick([{ event: 'm.f', payload: 'f2' }]);
  assert.deepEqual(seen, [[], [], ['e1', 'e2'], ['f1', 'f2']]);
});

test('R5 ctx.events returns an empty list outside a run', async () => {
  const kept: Record<string, Ctx> = {};
  const game = await loadOne(keeping(kept, 'm', { run(ctx: Ctx) { ctx.emit('m.e', 1); } }), schedule(['m.run']));
  game.tick();
  assert.deepEqual(kept.m.events('m.e'), []);
});

test('R5 a frame system sees every event since its last run, never an input; each loop sees an event once', async () => {
  const fixedSeen: number[] = [];
  const frameSeen: number[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) { fixedSeen.push(ctx.events('m.e').length); ctx.emit('m.e', ctx.tick); },
    show(ctx: Ctx) { frameSeen.push(ctx.events('m.e').length); },
  };
  const game = await loadOne(entry, schedule(['m.run'], ['m.show']));
  game.tick();
  game.tick();
  game.frame(0.016, 0.5);
  game.tick([ev('input')]);
  game.frame(0.016, 0.5);
  game.frame(0.016, 0.5);
  assert.deepEqual(frameSeen, [2, 1, 0]);
  assert.deepEqual(fixedSeen, [0, 1, 2]);
});

test('R5 an event emitted by a frame system reaches the next fixed run and the next frame run', async () => {
  const seen: string[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) { seen.push(`run [${ctx.events('m.e')}]`); },
    show(ctx: Ctx) { seen.push(`show [${ctx.events('m.e')}]`); if (ctx.tick === 0) ctx.emit('m.e', 'click'); },
  };
  const game = await loadOne(entry, schedule(['m.run'], ['m.show']));
  game.frame(0.016, 0);
  game.tick();
  game.frame(0.016, 0);
  assert.deepEqual(seen, ['show []', 'run [click]', 'show [click]']);
});

// Ticks a game whose system emits a fresh object each tick and reports which of those objects the garbage collector kept.
async function keptPayloads(patch: Partial<Bundle>): Promise<boolean[]> {
  const refs: WeakRef<object>[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) {
      const payload = { tick: ctx.tick };
      refs.push(new WeakRef(payload));
      ctx.emit('m.e', payload);
    },
    show() {},
  };
  const game = await loadOne(entry, patch);
  for (let i = 0; i < 4; i++) game.tick();
  await new Promise((resolve) => setImmediate(resolve));
  collectGarbage();
  return refs.map((ref) => ref.deref() !== undefined);
}

test('R5 with no frame systems no frame backlog builds up', async () => {
  assert.deepEqual(await keptPayloads(schedule(['m.run'])), [false, false, false, true]);
});

test('R5 with frame systems the events wait for the next frame run', async () => {
  assert.deepEqual(await keptPayloads(schedule(['m.run'], ['m.show'])), [true, true, true, true]);
});

test('R6 tick and frame return the events their systems and operations emitted, inputs excluded', async () => {
  const entry: ModuleEntry = {
    run(ctx: Ctx) { ctx.emit('m.e', 'a'); ctx.call('m.op'); ctx.emit('m.e', 'c'); },
    show(ctx: Ctx) { ctx.emit('m.e', 'frame'); },
    operations: { op: (ctx: Ctx) => ctx.emit('m.e', 'b') },
  };
  const game = await loadOne(entry, { ...schedule(['m.run'], ['m.show']), operations: { 'm.op': 'm' } });
  assert.deepEqual(game.tick([ev('input')]), [ev('a'), ev('b'), ev('c')]);
  assert.deepEqual(game.frame(0.01, 0), [ev('frame')]);
});

test('R6 events emitted by init or game.call are delivered but returned by no run; an absent emit is dropped', async () => {
  const seen: unknown[] = [];
  const entry: ModuleEntry = {
    init(ctx: Ctx) { ctx.emit('m.e', 'init'); },
    run(ctx: Ctx) { seen.push(ctx.events('m.e')); ctx.emit('ghost.e', 'dropped'); },
    operations: { op: (ctx: Ctx) => ctx.emit('m.e', 'call') },
  };
  const patch = { ...schedule(['m.run']), operations: { 'm.op': 'm' }, modules: [moduleOf('m', { absent: ['ghost'] })] };
  const game = await loadOne(entry, patch);
  game.call('m.op');
  assert.deepEqual(game.tick(), []);
  assert.deepEqual(game.tick(), []);
  assert.deepEqual(seen, [['init', 'call'], []]);
});

test('R7 an input must name a declared event and is not visibility-checked', async () => {
  const seen: unknown[] = [];
  const bundle = bundleOf({
    modules: [moduleOf('m'), moduleOf('other')],
    events: { 'other.hint': 'other' },
    config: { m: {}, other: {} },
    ...schedule(['other.run']),
  });
  const other: ModuleEntry = { run(ctx: Ctx) { seen.push(ctx.events('other.hint')); } };
  const game = await load(bundle, { importer: importerOf({ m: {}, other }) });
  assert.throws(() => game.tick([{ event: 'nowhere.x', payload: 1 }]), { message: 'unknown: nowhere.x' });
  assert.equal(game.ticks, 0);
  game.tick([{ event: 'other.hint', payload: 1 }]);
  game.tick();
  assert.deepEqual(seen, [[1], []]);
});

test('R8 frame runs the frame systems with the given dt and alpha and the completed tick count', async () => {
  const seen: string[] = [];
  const entry: ModuleEntry = {
    run() { seen.push('run'); },
    one(ctx: Ctx) { seen.push(`one dt=${ctx.dt} alpha=${ctx.alpha} tick=${ctx.tick}`); },
    two() { seen.push('two'); },
  };
  const game = await loadOne(entry, schedule(['m.run'], ['m.one', 'm.two']));
  game.tick();
  game.tick();
  game.frame(0.016, 0.25);
  assert.deepEqual(seen, ['run', 'run', 'one dt=0.016 alpha=0.25 tick=2', 'two']);
  assert.equal(game.ticks, 2);
});

test('R9 debug mode rejects an operation a frame system calls that changes its provider state', async () => {
  const store: ModuleEntry = {
    init: () => ({ n: 0 }),
    operations: {
      read: (ctx: Ctx) => (ctx.state as { n: number }).n,
      bump: (ctx: Ctx) => { (ctx.state as { n: number }).n += 1; },
    },
  };
  const gameCalling = (op: string, options: LoadOptions): Promise<Game> => {
    const view: ModuleEntry = { step: (ctx: Ctx) => ctx.call('store.bump'), look: (ctx: Ctx) => ctx.call(op) };
    const bundle = bundleOf({
      modules: [moduleOf('store'), moduleOf('view', { sees: ['view', 'store'] })],
      operations: { 'store.read': 'store', 'store.bump': 'store' },
      config: { store: {}, view: {} },
      ...schedule(['view.step'], ['view.look']),
    });
    return load(bundle, { importer: importerOf({ store, view }), ...options });
  };
  const reading = await gameCalling('store.read', { debug: true });
  reading.tick();
  reading.frame(0.01, 0);
  const bumping = await gameCalling('store.bump', { debug: true });
  bumping.tick();
  assert.throws(() => bumping.frame(0.01, 0), { message: 'frame call changed state: store.bump' });
  const unchecked = await gameCalling('store.bump', {});
  unchecked.frame(0.01, 0);
});

test('R9 debug mode also checks an operation called by an operation that a frame system calls', async () => {
  const bundle = bundleOf({
    modules: [moduleOf('store'), moduleOf('relay', { sees: ['relay', 'store'] }), moduleOf('view', { sees: ['view', 'relay'] })],
    operations: { 'store.bump': 'store', 'relay.pass': 'relay' },
    config: { store: {}, relay: {}, view: {} },
    ...schedule([], ['view.look']),
  });
  const store: ModuleEntry = { init: () => ({ n: 0 }), operations: { bump: (ctx: Ctx) => { (ctx.state as { n: number }).n += 1; } } };
  const relay: ModuleEntry = { operations: { pass: (ctx: Ctx) => ctx.call('store.bump') } };
  const view: ModuleEntry = { look: (ctx: Ctx) => ctx.call('relay.pass') };
  const game = await load(bundle, { debug: true, importer: importerOf({ store, relay, view }) });
  assert.throws(() => game.frame(0.01, 0), { message: 'frame call changed state: store.bump' });
});

test('R10 an id whose owner is neither seen nor absent is not visible', async () => {
  const { a } = await visibility();
  const calls: [string, () => unknown][] = [
    ['c.item', () => a.records('c.item')],
    ['c.ping', () => a.events('c.ping')],
    ['c.ping', () => a.emit('c.ping', {})],
    ['c.op', () => a.call('c.op')],
    ['c', () => a.configOf('c')],
    ['c', () => a.has('c')],
    ['nowhere.x', () => a.call('nowhere.x')],
  ];
  for (const [id, call] of calls) assert.throws(call, { message: `not visible: ${id} from a` });
});

test('R11 an absent owner gives false, empty results, a dropped emit or an absent error', async () => {
  const { a } = await visibility();
  assert.equal(a.has('ghost'), false);
  assert.deepEqual(a.events('ghost.ping'), []);
  assert.deepEqual(a.records('ghost.item'), {});
  assert.doesNotThrow(() => a.emit('ghost.ping', {}));
  assert.throws(() => a.call('ghost.op'), { message: 'absent: ghost.op' });
  assert.throws(() => a.configOf('ghost'), { message: 'absent: ghost' });
});

test('R12 a visible id that is not declared is unknown, after the R10 and R11 checks', async () => {
  const { a } = await visibility();
  const calls: (() => unknown)[] = [
    () => a.events('b.nothing'),
    () => a.emit('b.nothing', {}),
    () => a.call('b.nothing'),
    () => a.records('b.nothing'),
    () => a.configOf('b.nothing'),
  ];
  for (const call of calls) assert.throws(call, { message: 'unknown: b.nothing' });
  assert.throws(() => a.events('c.nothing'), { message: 'not visible: c.nothing from a' });
  assert.deepEqual(a.events('ghost.nothing'), []);
});

test('R13 has is true for the module itself and for every owner it sees', async () => {
  const { a } = await visibility();
  assert.equal(a.has('a'), true);
  assert.equal(a.has('b'), true);
  assert.equal(a.has('b.anything'), true);
});

test('R14 ctx.config and configOf return the deep-frozen bundle config', async () => {
  const kept: Record<string, Ctx> = {};
  const bundle = bundleOf({
    modules: [moduleOf('m', { sees: ['m', 'p'] }), moduleOf('p')],
    config: { m: { speed: 2, nested: { list: [1] } }, p: { mode: 'x' } },
  });
  await load(bundle, { importer: importerOf({ m: keeping(kept, 'm'), p: {} }) });
  assert.equal(kept.m.config, bundle.config.m);
  assert.equal(kept.m.configOf('p'), bundle.config.p);
  assert.throws(() => { (kept.m.config as { speed: number }).speed = 3; }, TypeError);
  assert.throws(() => { (kept.m.config as { nested: { list: number[] } }).nested.list.push(2); }, TypeError);
});

test('R15 records returns the deep-frozen bundle records, or an empty object', async () => {
  const kept: Record<string, Ctx> = {};
  const bundle = bundleOf({ types: { 'm.item': 1, 'm.none': 1 }, records: { 'm.item': { 'm/a': { n: 1, tags: ['x'] } } } });
  await load(bundle, { importer: importerOf({ m: keeping(kept, 'm') }) });
  const items = kept.m.records<{ tags: string[] }>('m.item');
  assert.equal(items, bundle.records['m.item']);
  assert.deepEqual(kept.m.records('m.none'), {});
  assert.throws(() => { (items['m/a'].tags as string[]).push('y'); }, TypeError);
  assert.throws(() => { (kept.m.records('m.none') as Record<string, unknown>).x = 1; }, TypeError);
});

test('R16 call runs the provider operation synchronously with the provider ctx; a contract call runs in its implementation', async () => {
  const kept: Record<string, Ctx> = {};
  const bundle = bundleOf({
    modules: [moduleOf('impl', { sees: ['impl', 'api'] }), moduleOf('user', { sees: ['user', 'api'] })],
    contracts: { api: 'impl' },
    operations: { 'api.echo': 'impl' },
    config: { api: {}, impl: {}, user: {} },
  });
  const impl: ModuleEntry = {
    init: () => ({ calls: 0 }),
    operations: { echo: (ctx: Ctx, params: unknown) => { (ctx.state as { calls: number }).calls += 1; return { by: ctx.module, params }; } },
  };
  const game = await load(bundle, { importer: importerOf({ impl, user: keeping(kept, 'user') }) });
  assert.deepEqual(kept.user.call('api.echo', { n: 1 }), { by: 'impl', params: { n: 1 } });
  assert.deepEqual(game.snapshot().impl, { calls: 1 });
});

test('R16 an operation that returns a thenable throws', async () => {
  const operations = { slow: async () => 1, thenable: () => ({ then() {} }) };
  const patch = { operations: { 'm.slow': 'm', 'm.thenable': 'm' } };
  const game = await loadOne({ operations }, patch);
  assert.throws(() => game.call('m.slow'), { message: 'operation returned a promise: m.slow' });
  assert.throws(() => game.call('m.thenable'), { message: 'operation returned a promise: m.thenable' });
});

test('R17 init, systems and operations receive the one ctx of a module', async () => {
  const seen: Ctx[] = [];
  const entry: ModuleEntry = {
    init(ctx: Ctx) { seen.push(ctx); },
    run(ctx: Ctx) { seen.push(ctx); },
    operations: { op: (ctx: Ctx) => { seen.push(ctx); } },
  };
  const game = await loadOne(entry, { ...schedule(['m.run']), operations: { 'm.op': 'm' } });
  game.tick();
  game.call('m.op');
  assert.equal(seen.length, 3);
  assert.ok(seen.every((ctx) => ctx === seen[0]));
});

test('R17 a ctx kept from init reads and assigns the current state between runs', async () => {
  for (const debug of [false, true]) {
    const kept: Record<string, Ctx> = {};
    const seen: number[] = [];
    const entry: ModuleEntry = {
      init: () => ({ pending: [] }),
      show(ctx: Ctx) {
        seen.push((ctx.state as { pending: number[] }).pending.length);
        ctx.state = { pending: [] };
      },
    };
    const game = await loadOne(keeping(kept, 'm', entry), schedule([], ['m.show']), { debug });
    game.frame(0.016, 0);
    (kept.m.state as { pending: number[] }).pending.push(1);
    game.frame(0.016, 0);
    (kept.m.state as { pending: number[] }).pending.push(1);
    game.frame(0.016, 0);
    kept.m.state = { pending: [1, 1] };
    game.frame(0.016, 0);
    assert.deepEqual(seen, [0, 1, 1, 2]);
  }
});

test('R18 debug mode rejects state that is not JSON', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const values: unknown[] = [NaN, Infinity, undefined, 1n, new Date(0), new Set(), () => 1, cyclic, [undefined]];
  for (const v of values) {
    await assert.rejects(loadOne({ init: () => ({ v }) }, {}, { debug: true }), { message: 'state not JSON: m' });
  }
  await loadOne({ init: () => ({ v: NaN }) });
  const bySystem = await loadOne({ init: () => ({}), run(ctx: Ctx) { ctx.state = { v: NaN }; } }, schedule(['m.run']), { debug: true });
  assert.throws(() => bySystem.tick(), { message: 'state not JSON: m' });
  const byOperation = await loadOne({ init: () => ({}), operations: { op(ctx: Ctx) { ctx.state = { v: NaN }; } } }, { operations: { 'm.op': 'm' } }, { debug: true });
  assert.throws(() => byOperation.call('m.op'), { message: 'state not JSON: m' });
});

test('R18 debug mode rejects an event payload or input that is not JSON', async () => {
  const emitting = (payload: unknown): ModuleEntry => ({ run(ctx: Ctx) { ctx.emit('m.e', payload); } });
  for (const payload of [Infinity, -Infinity, NaN, undefined, { v: Infinity }, [NaN]]) {
    const game = await loadOne(emitting(payload), schedule(['m.run']), { debug: true });
    assert.throws(() => game.tick(), { message: 'event not JSON: m.e' });
  }
  const game = await loadOne({}, {}, { debug: true });
  assert.throws(() => game.tick([ev({ v: Infinity })]), { message: 'event not JSON: m.e' });
  const unchecked = await loadOne(emitting({ v: Infinity }), schedule(['m.run']));
  assert.doesNotThrow(() => unchecked.tick());
});

test('R18 debug mode rejects params and results that are not JSON', async () => {
  const entry: ModuleEntry = { operations: { op: (_ctx: Ctx, params: unknown) => (params === 'bad' ? { v: NaN } : 1) } };
  const game = await loadOne(entry, { operations: { 'm.op': 'm' } }, { debug: true });
  assert.equal(game.call('m.op'), 1);
  assert.throws(() => game.call('m.op', { v: NaN }), { message: 'params not JSON: m.op' });
  assert.throws(() => game.call('m.op', 'bad'), { message: 'result not JSON: m.op' });
});

test('R18 debug mode delivers -0 as 0 and freezes payloads, inputs and results', async () => {
  const seen: unknown[] = [];
  const entry: ModuleEntry = {
    run(ctx: Ctx) { seen.push(...ctx.events('m.e')); ctx.emit('m.e', { v: -0, list: [-0] }); },
    operations: { op: () => ({ v: -0 }) },
  };
  const patch = { ...schedule(['m.run']), operations: { 'm.op': 'm' } };
  const game = await loadOne(entry, patch, { debug: true });
  const [emitted] = game.tick([ev({ v: -0 })]);
  const input = seen[0] as { v: number };
  assert.ok(Object.is(input.v, 0) && Object.isFrozen(input));
  const payload = emitted.payload as { v: number; list: number[] };
  assert.ok(Object.is(payload.v, 0) && Object.is(payload.list[0], 0));
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.list));
  const result = game.call('m.op') as { v: number };
  assert.ok(Object.is(result.v, 0) && Object.isFrozen(result));
  const plain = await loadOne(entry, patch);
  assert.ok(Object.is((plain.tick()[0].payload as { v: number }).v, -0));
});

test('R18 validate checks state, events, params and results against bundle.schemas', async () => {
  const schemas = { state: { m: 'state.json' }, events: { 'm.e': 'event.json' }, params: { 'm.op': 'params.json' }, results: { 'm.op': 'result.json' } };
  const patch = { ...schedule(['m.run']), operations: { 'm.op': 'm' }, schemas };
  const entry: ModuleEntry = {
    init: () => ({ n: 1 }),
    run(ctx: Ctx) { ctx.emit('m.e', { a: 1 }); ctx.call('m.op', { p: 1 }); },
    operations: { op: () => ({ r: 1 }) },
  };
  const kinds: [string, string][] = [['state', 'm'], ['event', 'm.e'], ['params', 'm.op'], ['result', 'm.op']];
  for (const [kind, id] of kinds) {
    const validate = (schema: string): string | null => (schema === `${kind}.json` ? `bad ${schema}` : null);
    const run = async (): Promise<void> => { (await loadOne(entry, patch, { debug: true, validate })).tick(); };
    await assert.rejects(run, { message: `invalid ${kind} for ${id}: bad ${kind}.json` });
  }
  const calls: [string, unknown][] = [];
  const spy = (schema: string, value: unknown): null => { calls.push([schema, value]); return null; };
  (await loadOne(entry, patch, { debug: true, validate: spy })).tick();
  const state = ['state.json', { n: 1 }];
  assert.deepEqual(calls, [state, ['event.json', { a: 1 }], ['params.json', { p: 1 }], state, ['result.json', { r: 1 }], state]);
  calls.length = 0;
  (await loadOne(entry, patch, { validate: spy })).tick();
  (await loadOne(entry, { ...patch, schemas: undefined }, { debug: true, validate: spy })).tick();
  assert.deepEqual(calls, []);
});

test('R18 validate also checks inputs, and params or a result that is missing', async () => {
  const schemas = { state: {}, events: { 'm.e': 'event.json' }, params: { 'm.op': 'params.json' }, results: { 'm.op': 'result.json' } };
  const calls: [string, unknown][] = [];
  const validate = (schema: string, value: unknown): string | null => { calls.push([schema, value]); return value === undefined ? 'missing' : null; };
  const game = await loadOne({ operations: { op: () => undefined } }, { operations: { 'm.op': 'm' }, schemas }, { debug: true, validate });
  game.tick([ev({ a: 1 })]);
  assert.deepEqual(calls, [['event.json', { a: 1 }]]);
  assert.throws(() => game.call('m.op'), { message: 'invalid params for m.op: missing' });
  assert.throws(() => game.call('m.op', { p: 1 }), { message: 'invalid result for m.op: missing' });
});

test('R19 game.call runs an operation without visibility checks and rejects an undeclared id', async () => {
  const { game } = await visibility(true);
  assert.equal(game.call('c.op'), 'done');
  assert.throws(() => game.call('c.nothing'), { message: 'unknown: c.nothing' });
  const slow = await loadOne({ operations: { slow: async () => 1 } }, { operations: { 'm.slow': 'm' } });
  assert.throws(() => slow.call('m.slow'), { message: 'operation returned a promise: m.slow' });
});

test('R20 snapshot returns JSON copies of the states in load order, without modules that have none', async () => {
  const bundle = bundleOf({ modules: [moduleOf('b'), moduleOf('a'), moduleOf('c')], config: { a: {}, b: {}, c: {} } });
  const entries: Record<string, ModuleEntry> = { b: { init: () => ({ list: [1, -0] }) }, a: {}, c: { init: () => null } };
  const game = await load(bundle, { importer: importerOf(entries) });
  const snapshot = game.snapshot();
  assert.deepEqual(Object.keys(snapshot), ['b', 'c']);
  assert.deepEqual(snapshot, { b: { list: [1, 0] }, c: null });
  (snapshot.b as { list: number[] }).list.push(2);
  assert.deepEqual(game.snapshot().b, { list: [1, 0] });
});

test('R21 errors thrown by module code propagate unchanged', async () => {
  const boom = new Error('boom');
  const thrower = (): never => { throw boom; };
  const same = (error: unknown): boolean => error === boom;
  await assert.rejects(loadOne({ init: thrower }), same);
  await assert.rejects(load(bundleOf(), { importer: () => Promise.reject(boom) }), same);
  const game = await loadOne({ run: thrower, show: thrower, operations: { op: thrower } }, { ...schedule(['m.run'], ['m.show']), operations: { 'm.op': 'm' } });
  assert.throws(() => game.tick(), same);
  assert.throws(() => game.frame(0.01, 0), same);
  assert.throws(() => game.call('m.op'), same);
});

test('R22 load ignores fields it does not know at the bundle root and in a module entry', async () => {
  const bundle = { ...bundleOf(schedule(['m.run'])), x_future: 1, modules: [{ ...moduleOf('m'), x_future: 2 }] };
  let ran = false;
  const game = await load(bundle, { importer: importerOf({ m: { run() { ran = true; } } }) });
  game.tick();
  assert.equal(ran, true);
});
