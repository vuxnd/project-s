// render_boxes on the web host: draws every physics body as a rectangle and turns each click on the canvas into one physics.spawn.
import type { Ctx, State, physics } from '../types.gen.ts';

type Host = { canvas: HTMLCanvasElement };

export function init(ctx: Ctx): State {
  // The listener only queues the click; draw emits its spawn, so there is one event per click. ctx.state is the module's current state whenever the listener runs.
  (ctx.host as Host).canvas.addEventListener('pointerdown', (event) => {
    ctx.state.pending.push([event.offsetX, event.offsetY]);
  });
  return { pending: [], clicks: 0 };
}

// Canvas x runs right from the left edge and y down from the top; the world has x = 0 at the canvas centre and y = 0 at its bottom edge, with `scale` pixels per metre.
export function draw(ctx: Ctx): void {
  const { canvas } = ctx.host as Host;
  const { width: w, height: h } = canvas;
  const { scale: s, clickBody } = ctx.config;
  const { state } = ctx;
  if (clickBody !== undefined) {
    for (const [px, py] of state.pending) {
      state.clicks += 1;
      const spawn: physics.SpawnEvent = { id: `click_${state.clicks}`, body: clickBody, position: [(px - w / 2) / s, (h - py) / s, 0] };
      ctx.emit('physics.spawn', spawn);
    }
  }
  state.pending = [];

  const context = canvas.getContext('2d')!;
  context.fillStyle = '#111';
  context.fillRect(0, 0, w, h);
  context.fillStyle = '#e8a33d';
  for (const { position: [x, y], size: [sx, sy] } of ctx.call<physics.BodiesResult>('physics.bodies')) {
    context.fillRect(w / 2 + (x - sx / 2) * s, h - (y + sy / 2) * s, sx * s, sy * s);
  }
}
