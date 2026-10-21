// Unit tests for render_boxes with a fake ctx, canvas and 2D context: the rectangles of two bodies, and one physics.spawn per click.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draw, init } from '../web/index.ts';
import type { Config, Ctx, physics } from '../types.gen.ts';

const BODIES: physics.BodiesResult = [
  { id: 'crate_a', position: [0.25, 1, 0], size: [1, 1, 1] },
  { id: 'plank', position: [0, 0.25, 0], size: [4, 0.5, 2] },
];
const CLICKS: Config = { scale: 40, clickBody: 'sandbox_rules/crate' };
const NO_CLICKS: Config = { scale: 40 };

// An 800 by 600 canvas that keeps its listeners and the rectangles filled on its 2D context; dispatch calls the listeners of an event type.
function fakeCanvas() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const fills: number[][] = [];
  const context = { fillStyle: '', fillRect: (...rect: number[]) => { fills.push(rect); } };
  return {
    width: 800,
    height: 600,
    fills,
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    getContext: (kind: string) => (kind === '2d' ? context : null),
    dispatch: (type: string, event: unknown) => { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

// A ctx like the runtime's: init receives it, and its result becomes ctx.state afterwards.
function setup(config: Config) {
  const canvas = fakeCanvas();
  const emitted: { event: string; payload: unknown }[] = [];
  const ctx = {
    module: 'render_boxes',
    state: undefined,
    config,
    host: { canvas },
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    call: (id: string) => {
      assert.equal(id, 'physics.bodies');
      return BODIES;
    },
  } as unknown as Ctx;
  ctx.state = init(ctx);
  return { ctx, canvas, emitted };
}

const click = (offsetX: number, offsetY: number) => ({ offsetX, offsetY });

test('draw fills the canvas, then one rectangle per body with x from the centre and y up from the bottom edge', () => {
  const { ctx, canvas } = setup(NO_CLICKS);
  draw(ctx);
  assert.deepEqual(canvas.fills, [
    [0, 0, 800, 600],
    [390, 540, 40, 40],
    [320, 580, 160, 20],
  ]);
});

test('a click is only queued; the next draw emits one physics.spawn for it and the draw after that none', () => {
  const { ctx, canvas, emitted } = setup(CLICKS);
  canvas.dispatch('pointerdown', click(400, 300));
  assert.deepEqual(emitted, []);
  assert.deepEqual(ctx.state.pending, [[400, 300]]);
  draw(ctx);
  assert.deepEqual(emitted, [{ event: 'physics.spawn', payload: { id: 'click_1', body: 'sandbox_rules/crate', position: [0, 7.5, 0] } }]);
  assert.deepEqual(ctx.state, { pending: [], clicks: 1 });
  draw(ctx);
  assert.equal(emitted.length, 1);
});

test('two clicks before a draw give two spawns in click order, and the ids go on counting', () => {
  const { ctx, canvas, emitted } = setup(CLICKS);
  canvas.dispatch('pointerdown', click(0, 600));
  canvas.dispatch('pointerdown', click(800, 0));
  draw(ctx);
  canvas.dispatch('pointerdown', click(400, 600));
  draw(ctx);
  assert.deepEqual(emitted.map((e) => e.payload), [
    { id: 'click_1', body: 'sandbox_rules/crate', position: [-10, 0, 0] },
    { id: 'click_2', body: 'sandbox_rules/crate', position: [10, 15, 0] },
    { id: 'click_3', body: 'sandbox_rules/crate', position: [0, 0, 0] },
  ]);
});

test('without clickBody a click spawns nothing and is dropped from the queue', () => {
  const { ctx, canvas, emitted } = setup(NO_CLICKS);
  canvas.dispatch('pointerdown', click(400, 300));
  draw(ctx);
  assert.deepEqual(emitted, []);
  assert.deepEqual(ctx.state, { pending: [], clicks: 0 });
});
