// Browser host (plan.md 4.13): fetches a web bundle, loads it on the JS runtime and runs the fixed-step loop.
import { load } from '../runtime.ts';
import type { Bundle, Game, ModuleEntry } from '../runtime.ts';

export const MAX_TICKS_PER_FRAME = 8;

export interface Clock { last: number | null; acc: number }

const USAGE = 'usage: ?root=<root>&game=<game>';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The root and game of the page address; a missing or malformed one is a usage error.
function parseSearch(search: string): { root: string; game: string } {
  const params = new URLSearchParams(search);
  const root = params.get('root') ?? '';
  const game = params.get('game') ?? '';
  const rootOk = root === '.' || root.split('/').every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment));
  if (!rootOk || !/^[a-z][a-z0-9_]{0,63}$/.test(game)) throw new Error(USAGE);
  return { root, game };
}

export function bundleUrl(search: string): string {
  const { root, game } = parseSearch(search);
  return `/build/${root === '.' ? '' : `${root}/`}games/${game}/web/bundle.json`;
}

// One animation frame: runs the fixed ticks that `now` makes due, then one frame run; returns the number of ticks.
export function step(clock: Clock, now: number, fixedHz: number, game: Pick<Game, 'tick' | 'frame'>): number {
  if (clock.last === null) {
    clock.last = now;
    game.frame(0, 0);
    return 0;
  }
  const dt = 1 / fixedHz;
  const frame = Math.min((now - clock.last) / 1000, 0.25);   // a hidden tab must not come back as a burst of ticks
  clock.last = now;
  clock.acc += frame;
  let ticks = 0;
  while (clock.acc >= dt && ticks < MAX_TICKS_PER_FRAME) {
    game.tick();
    clock.acc -= dt;
    ticks++;
  }
  if (clock.acc >= dt) clock.acc %= dt;   // past the cap: drop the backlog, keep the fraction of a tick
  game.frame(frame, clock.acc * fixedHz);
  return ticks;
}

export interface WebEnv {
  search: string;
  fetchJson(url: string): Promise<unknown>;
  requestFrame(callback: (now: number) => void): void;
  canvas: unknown;
  audio: unknown;
  report(message: string): void;
  importer?: (entry: string) => Promise<ModuleEntry>;   // tests only; the browser uses the runtime default
}

// Every failure is reported, and `start` then rejects; the loop stops at the first error module code throws.
export async function start(env: WebEnv): Promise<Game> {
  try {
    const { root, game: id } = parseSearch(env.search);
    let fetched: unknown;
    try {
      fetched = await env.fetchJson(bundleUrl(env.search));
    } catch {
      throw new Error(`bundle not found: run npm run build -- ${id} --host web --root ${root}`);
    }
    const bundle = fetched as Bundle;
    if (bundle.host !== 'web') throw new Error(`bundle host ${bundle.host}; this host is web`);
    const game = await load(bundle, { root: '/', host: { canvas: env.canvas, audio: env.audio }, importer: env.importer });
    const clock: Clock = { last: null, acc: 0 };
    const frame = (now: number): void => {
      try {
        step(clock, now, bundle.fixedHz, game);
      } catch (e) {
        env.report(messageOf(e));
        return;
      }
      env.requestFrame(frame);
    };
    env.requestFrame(frame);
    return game;
  } catch (e) {
    env.report(messageOf(e));
    throw e;
  }
}

if (typeof document !== 'undefined') {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const status = document.getElementById('status') as HTMLElement;
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const audio = new AudioContext();
  const resume = (): void => { void audio.resume(); };   // browsers keep audio suspended until a user gesture
  document.addEventListener('pointerdown', resume, { once: true });
  document.addEventListener('keydown', resume, { once: true });
  start({
    search: location.search,
    async fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response.json();
    },
    requestFrame: (callback) => { requestAnimationFrame(callback); },
    canvas,
    audio,
    report: (message) => { status.textContent = message; },
  }).catch(() => {});   // start has already reported the failure
}
