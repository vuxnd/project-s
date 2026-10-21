// Tests for hosts/js/web/host.ts: bundleUrl, the fixed-step loop with fake clocks, and start with a fake environment (plan.md 4.13).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_TICKS_PER_FRAME, bundleUrl, start, step } from '../host.ts';
import type { Clock, WebEnv } from '../host.ts';
import { load } from '../../runtime.ts';
import type { Bundle, Ctx, Game, ModuleEntry } from '../../runtime.ts';

const USAGE = 'usage: ?root=<root>&game=<game>';

test('bundleUrl maps root and game to the web bundle path', () => {
  assert.equal(bundleUrl('?root=examples&game=sandbox'), '/build/examples/games/sandbox/web/bundle.json');
  assert.equal(bundleUrl('?game=sandbox&root=examples'), '/build/examples/games/sandbox/web/bundle.json');
  assert.equal(bundleUrl('root=examples&game=sandbox'), '/build/examples/games/sandbox/web/bundle.json');
  assert.equal(bundleUrl('?root=hosts/conformance&game=probe_a'), '/build/hosts/conformance/games/probe_a/web/bundle.json');
  assert.equal(bundleUrl('?root=hosts%2Fconformance&game=g'), '/build/hosts/conformance/games/g/web/bundle.json');
  assert.equal(bundleUrl('?root=a.b-c_1&game=g2_x'), '/build/a.b-c_1/games/g2_x/web/bundle.json');
  assert.equal(bundleUrl(`?root=examples&game=a${'b'.repeat(63)}`), `/build/examples/games/a${'b'.repeat(63)}/web/bundle.json`);
});

test('bundleUrl maps root . to the repository build folder', () => {
  assert.equal(bundleUrl('?root=.&game=sandbox'), '/build/games/sandbox/web/bundle.json');
});

test('bundleUrl rejects a missing or malformed root or game with the usage text', () => {
  const bad = [
    '', '?', '?root=examples', '?game=sandbox', '?root=&game=sandbox', '?root=examples&game=',
    '?root=..&game=g', '?root=a/../b&game=g', '?root=/etc&game=g', '?root=a//b&game=g', '?root=examples/&game=g',
    '?root=a/./b&game=g', '?root=.x&game=g', '?root=a%20b&game=g', '?root=a%5Cb&game=g', '?root=..%2Fx&game=g',
    '?root=examples&game=Sandbox', '?root=examples&game=1abc', '?root=examples&game=a-b', '?root=examples&game=a%2Fb',
    `?root=examples&game=a${'b'.repeat(64)}`,
  ];
  for (const search of bad) assert.throws(() => bundleUrl(search), { name: 'Error', message: USAGE }, search);
});

// A game that counts the ticks the loop runs and records each frame run as [dt, alpha].
function fakeGame(): { game: Pick<Game, 'tick' | 'frame'>; log: { ticks: number; frames: [number, number][] } } {
  const log = { ticks: 0, frames: [] as [number, number][] };
  const game = {
    tick() { log.ticks++; return []; },
    frame(dt: number, alpha: number) { log.frames.push([dt, alpha]); return []; },
  };
  return { game, log };
}

const newClock = (): Clock => ({ last: null, acc: 0 });

test('step renders the first call without ticking and starts the clock', () => {
  const { game, log } = fakeGame();
  const clock = newClock();
  assert.equal(step(clock, 5000, 60, game), 0);
  assert.deepEqual(clock, { last: 5000, acc: 0 });
  assert.deepEqual(log, { ticks: 0, frames: [[0, 0]] });
});

test('step runs one tick for each fixed step of elapsed time and renders once', () => {
  const { game, log } = fakeGame();
  const clock = newClock();
  step(clock, 1000, 60, game);
  assert.equal(step(clock, 1050, 60, game), 3);   // 50 ms is 3 steps of 1/60 s
  assert.equal(log.ticks, 3);
  assert.equal(log.frames.length, 2);
  const [dt, alpha] = log.frames[1];
  assert.equal(dt, 0.05);
  assert.ok(alpha >= 0 && alpha < 0.001, String(alpha));
  assert.equal(clock.last, 1050);
  assert.equal(step(clock, 1050, 60, game), 0);   // no time passed, no tick
  assert.equal(log.ticks, 3);
});

test('step carries the rest of a step to the next call and passes it as alpha', () => {
  const { game, log } = fakeGame();
  const clock = newClock();
  step(clock, 0, 64, game);   // 1/64 s is 15.625 ms; the times below are exact in binary
  assert.equal(step(clock, 7.8125, 64, game), 0);
  assert.equal(step(clock, 31.25, 64, game), 2);
  assert.equal(step(clock, 50.78125, 64, game), 1);
  assert.deepEqual(log.frames, [[0, 0], [0.0078125, 0.5], [0.0234375, 0], [0.01953125, 0.25]]);
  assert.equal(log.ticks, 3);
});

test('step runs at most 8 ticks, counts a long pause as 0.25 s and keeps alpha in [0, 1)', () => {
  assert.equal(MAX_TICKS_PER_FRAME, 8);
  const { game, log } = fakeGame();
  const clock = newClock();
  step(clock, 0, 60, game);
  assert.equal(step(clock, 1000, 60, game), 8);   // 0.25 s is 15 steps; 8 run
  assert.equal(log.ticks, 8);
  const [dt, alpha] = log.frames[1];
  assert.equal(dt, 0.25);
  assert.ok(alpha >= 0 && alpha < 1, String(alpha));
  assert.ok(clock.acc >= 0 && clock.acc < 1 / 60, String(clock.acc));

  const exact = fakeGame();
  const other = newClock();
  step(other, 0, 64, exact.game);
  assert.equal(step(other, 3_600_000, 64, exact.game), 8);   // an hour counts as 0.25 s too
  assert.deepEqual(exact.log.frames[1], [0.25, 0]);
  assert.equal(other.acc, 0);
  assert.equal(step(other, 3_600_000 + 15.625, 64, exact.game), 1);   // the backlog is gone: one step of time is one tick
});

test('step keeps the fraction of a step when it drops the backlog, also when exactly one step is left', () => {
  const { game, log } = fakeGame();
  const clock = newClock();
  step(clock, 0, 64, game);
  step(clock, 7.8125, 64, game);   // half a step waits
  assert.equal(step(clock, 1007.8125, 64, game), 8);   // 0.25 s plus the half step is 16.5 steps; 8 run, 8 are dropped
  assert.deepEqual(log.frames[2], [0.25, 0.5]);
  assert.equal(clock.acc, 0.0078125);

  const nine = fakeGame();
  const other = newClock();
  step(other, 0, 64, nine.game);
  assert.equal(step(other, 140.625, 64, nine.game), 8);   // 9 steps: 8 run and the ninth is dropped
  assert.deepEqual(nine.log.frames[1], [0.140625, 0]);
  assert.equal(other.acc, 0);
});

// A web bundle for the module `m`; its fixed system counts ticks and its frame system counts frame runs.
const WEB_BUNDLE: Bundle = {
  format: 1, game: 'g', host: 'web', fixedHz: 64,
  modules: [{ id: 'm', entry: 'mods/m/web/index.ts', sees: ['m'], absent: [], packages: [] }],
  contracts: {}, operations: {}, events: {}, types: {}, config: { m: {} }, records: {}, assets: [],
  schedule: { fixed: ['m.count'], frame: ['m.draw'] },
};

// Keeps the ctx.host the module was given in `seen`.
function counter(seen: { host?: unknown }): ModuleEntry {
  return {
    init(ctx: Ctx) { seen.host = ctx.host; return { ticks: 0, frames: 0 }; },
    count(ctx: Ctx) { (ctx.state as { ticks: number }).ticks++; },
    draw(ctx: Ctx) { (ctx.state as { frames: number }).frames++; },
  };
}

// A WebEnv that serves WEB_BUNDLE, records the frame callbacks it is given instead of calling them, and keeps what it was asked.
function fakeEnv(patch: Partial<WebEnv> = {}) {
  const callbacks: ((now: number) => void)[] = [];
  const asked = { urls: [] as string[], entries: [] as string[], reports: [] as string[] };
  const seen: { host?: unknown } = {};
  const env: WebEnv = {
    search: '?root=examples&game=g',
    async fetchJson(url) { asked.urls.push(url); return structuredClone(WEB_BUNDLE); },
    requestFrame(callback) { callbacks.push(callback); },
    canvas: { name: 'canvas' },
    audio: { name: 'audio' },
    report(message) { asked.reports.push(message); },
    async importer(entry) { asked.entries.push(entry); return counter(seen); },
    ...patch,
  };
  return { env, callbacks, asked, seen };
}

// Runs the oldest waiting frame callback at time `now`.
function runFrame(callbacks: ((now: number) => void)[], now: number): void {
  const callback = callbacks.shift();
  assert.ok(callback, 'a frame callback is waiting');
  callback(now);
}

test('start fetches the web bundle, loads it with the canvas and audio as ctx.host and runs the loop', async () => {
  const { env, callbacks, asked, seen } = fakeEnv();
  const game = await start(env);
  assert.deepEqual(asked.urls, ['/build/examples/games/g/web/bundle.json']);
  assert.deepEqual(asked.entries, ['mods/m/web/index.ts']);
  const host = seen.host as { canvas: unknown; audio: unknown };
  assert.deepEqual(Object.keys(host), ['canvas', 'audio']);
  assert.equal(host.canvas, env.canvas);
  assert.equal(host.audio, env.audio);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(game.snapshot(), { m: { ticks: 0, frames: 0 } });

  runFrame(callbacks, 1000);   // the first frame draws and does not tick
  assert.deepEqual(game.snapshot(), { m: { ticks: 0, frames: 1 } });
  runFrame(callbacks, 1000 + 3 * 15.625);   // 3 steps of 1/64 s
  assert.deepEqual(game.snapshot(), { m: { ticks: 3, frames: 2 } });
  assert.equal(game.ticks, 3);
  runFrame(callbacks, 1000 + 3.5 * 15.625);   // half a step more: a frame run and no tick
  assert.deepEqual(game.snapshot(), { m: { ticks: 3, frames: 3 } });
  runFrame(callbacks, 1000 + 4 * 15.625);   // the other half completes the step
  assert.deepEqual(game.snapshot(), { m: { ticks: 4, frames: 4 } });
  assert.equal(callbacks.length, 1);   // each frame asks for the next
  assert.deepEqual(asked.reports, []);
});

test('start imports module entries from the site root when no importer is given', async (t) => {
  // load imports root + entry and root is '/', so an entry that is a file's absolute posix path without its first '/' loads that file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'index.mjs');
  fs.writeFileSync(file, [
    'export function init() { return { ticks: 0, frames: 0 }; }',
    'export function count(ctx) { ctx.state.ticks++; }',
    'export function draw(ctx) { ctx.state.frames++; }',
    '',
  ].join('\n'));
  const entry = file.replaceAll('\\', '/').replace(/^\//, '');
  const bundle: Bundle = { ...WEB_BUNDLE, modules: [{ ...WEB_BUNDLE.modules[0], entry }] };
  const { env, callbacks, asked } = fakeEnv({ importer: undefined, async fetchJson() { return bundle; } });
  const game = await start(env);
  assert.deepEqual(asked.reports, []);
  runFrame(callbacks, 0);
  runFrame(callbacks, 15.625);
  assert.deepEqual(game.snapshot(), { m: { ticks: 1, frames: 2 } });
});

test('start reports a bundle for another host and loads nothing', async () => {
  const { env, callbacks, asked } = fakeEnv({ async fetchJson() { return { ...WEB_BUNDLE, host: 'node' }; } });
  await assert.rejects(start(env));
  assert.equal(asked.reports.length, 1);
  assert.deepEqual(asked.entries, []);
  assert.equal(callbacks.length, 0);
});

test('start reports a bundle that is not there with the build command', async () => {
  const { env, callbacks, asked } = fakeEnv({ async fetchJson() { throw new Error('404 /build/x'); }, search: '?root=hosts/conformance&game=probe' });
  await assert.rejects(start(env));
  assert.deepEqual(asked.reports, ['bundle not found: run npm run build -- probe --host web --root hosts/conformance']);
  assert.equal(callbacks.length, 0);
});

test('start reports a missing or malformed address parameter without fetching', async () => {
  const { env, callbacks, asked } = fakeEnv({ search: '?game=g' });
  await assert.rejects(start(env), { message: USAGE });
  assert.deepEqual(asked.reports, [USAGE]);
  assert.deepEqual(asked.urls, []);
  assert.equal(callbacks.length, 0);
});

test('start reports an error from load', async () => {
  const { env, callbacks, asked } = fakeEnv({ async fetchJson() { return { ...WEB_BUNDLE, format: 2 }; } });
  await assert.rejects(start(env), { message: 'bundle format 2; this host reads 1' });
  assert.deepEqual(asked.reports, ['bundle format 2; this host reads 1']);
  assert.equal(callbacks.length, 0);
});

test('start loads in debug mode: state that is not JSON is reported at load (R18)', async () => {
  const { env, callbacks, asked } = fakeEnv({ async importer() { return { ...counter({}), init: () => ({ v: NaN }) }; } });
  await assert.rejects(start(env), { message: 'state not JSON: m' });
  assert.deepEqual(asked.reports, ['state not JSON: m']);
  assert.equal(callbacks.length, 0);
});

test('start reports an error module code throws in the loop and stops the loop', async () => {
  const broken: ModuleEntry = { ...counter({}), count() { throw new Error('boom'); } };
  const { env, callbacks, asked } = fakeEnv({ async importer() { return broken; } });
  await start(env);
  runFrame(callbacks, 0);   // the first frame runs no fixed system
  assert.deepEqual(asked.reports, []);
  runFrame(callbacks, 20);   // 20 ms is past 1/64 s, so the fixed system runs
  assert.deepEqual(asked.reports, ['boom']);
  assert.equal(callbacks.length, 0);
});

// Input to tick (README, Input): the same input at the same time lands in a different tick under a different frame schedule.
// Module m queues a click in its listener, its frame system emits m.click, and its fixed system keeps the tick number in which it first sees the event.
async function clickSeenAt(frameMs: number): Promise<{ seen: number | null; ticksAfterEmit: number; perFrame: number }> {
  let press = (): void => { throw new Error('no listener'); };
  const canvas = { addEventListener(_type: string, listener: () => void) { press = listener; } };
  const entry: ModuleEntry = {
    init(ctx: Ctx) { canvas.addEventListener('pointerdown', () => { (ctx.state as { pending: number }).pending++; }); return { pending: 0, seen: null }; },
    emit(ctx: Ctx) {
      const state = ctx.state as { pending: number };
      for (; state.pending > 0; state.pending--) ctx.emit('m.click', {});
    },
    read(ctx: Ctx) {
      const state = ctx.state as { seen: number | null };
      if (state.seen === null && ctx.events('m.click').length > 0) state.seen = ctx.tick;
    },
  };
  const bundle: Bundle = { ...WEB_BUNDLE, fixedHz: 60, events: { 'm.click': 'm' }, schedule: { fixed: ['m.read'], frame: ['m.emit'] } };
  const game = await load(bundle, { host: { canvas }, importer: async () => entry, debug: true });
  const clock = newClock();
  step(clock, 0, 60, game);   // the first frame only draws
  press();   // between the first and the second frame
  const perFrame = step(clock, frameMs, 60, game);   // the ticks due run, then the frame system emits the click
  const ticksAfterEmit = game.ticks;
  for (let n = 2; n <= 4; n++) step(clock, n * frameMs, 60, game);
  return { seen: (game.snapshot() as { m: { seen: number | null } }).m.seen, ticksAfterEmit, perFrame };
}

test('the tick in which a fixed system sees a browser input follows the frame schedule, for the same input time', async () => {
  const hair = 1000 / 60 + 0.01;   // a frame period a hair over one tick, so float rounding cannot lose a tick
  const one = await clickSeenAt(hair);   // frames every 1/60 s: one tick per frame
  const two = await clickSeenAt(2 * hair);   // frames every 2/60 s: two ticks per frame
  assert.deepEqual([one.perFrame, two.perFrame], [1, 2]);
  assert.equal(one.seen, 1);
  assert.equal(two.seen, 2);
  // The event is emitted in the frame run after the ticks of that frame, so the first tick that sees it is the one after them.
  assert.equal(one.seen, one.ticksAfterEmit);
  assert.equal(two.seen, two.ticksAfterEmit);
  assert.ok(two.seen! > one.seen!);
});

test('importing host.ts in Node starts nothing', async (t) => {
  const calls: string[] = [];
  const { fetch } = globalThis;
  t.after(() => {
    Object.assign(globalThis, { fetch });
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });
  Object.assign(globalThis, { fetch: () => calls.push('fetch'), requestAnimationFrame: () => calls.push('requestAnimationFrame') });
  assert.equal(typeof document, 'undefined');
  const specifier = new URL('../host.ts?again', import.meta.url).href;   // a new instance, so its top level runs again
  const again = await import(specifier);
  assert.equal(typeof again.start, 'function');
  assert.deepEqual(calls, []);
});
