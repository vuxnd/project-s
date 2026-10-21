// physics_basic on JavaScript hosts: semi-implicit Euler boxes on the plane y = 0, with inelastic contacts and stacking.
import type { Ctx, Operations, State, physics } from '../types.gen.ts';

export function init(): State {
  return { bodies: {} };
}

export function integrate(ctx: Ctx): void {
  const { bodies } = ctx.state;
  const records = ctx.records<physics.Body>('physics.body');
  for (const spawn of ctx.events<physics.SpawnEvent>('physics.spawn')) {
    if (Object.hasOwn(bodies, spawn.id) || !Object.hasOwn(records, spawn.body)) continue;
    bodies[spawn.id] = { position: [...spawn.position], velocity: [0, 0, 0], size: [...records[spawn.body].size], resting: false };
  }
  const { gravity } = ctx.configOf<physics.Config>('physics');
  const { substeps } = ctx.config;
  const h = ctx.dt / substeps;
  for (const id of Object.keys(bodies).sort()) {
    const { position, velocity, resting } = bodies[id];
    if (resting) continue;
    for (let step = 0; step < substeps; step++) {
      for (let k = 0; k < 3; k++) {
        velocity[k] += gravity[k] * h;
        position[k] += velocity[k] * h;
      }
    }
  }
}

export function collide(ctx: Ctx): void {
  const { bodies } = ctx.state;
  const ids = Object.keys(bodies).sort();
  for (const id of ids) {
    const body = bodies[id];
    if (body.resting) continue;
    const { position: p, size: s } = body;
    const bottom = p[1] - s[1] / 2;
    let support: number | undefined;
    let on = 'ground';
    if (bottom <= 0) {
      support = 0;
    } else {
      // The first resting body in id order that overlaps this one in x and z, reaches up to its bottom and has a lower centre.
      for (const other of ids) {
        const { position: q, size: t, resting } = bodies[other];
        const top = q[1] + t[1] / 2;
        if (other !== id && resting && Math.abs(p[0] - q[0]) < (s[0] + t[0]) / 2 && Math.abs(p[2] - q[2]) < (s[2] + t[2]) / 2 && top >= bottom && q[1] < p[1]) {
          support = top;
          on = other;
          break;
        }
      }
    }
    if (support === undefined) continue;
    p[1] = support + s[1] / 2;
    body.velocity = [0, 0, 0];
    body.resting = true;
    const contact: physics.ContactEvent = { id, with: on };
    ctx.emit('physics.contact', contact);
  }
}

export const operations = {
  position(ctx: Ctx, params: physics.PositionParams): physics.PositionResult {
    const { bodies } = ctx.state;
    return Object.hasOwn(bodies, params.id) ? [...bodies[params.id].position] : null;
  },
  bodies(ctx: Ctx): physics.BodiesResult {
    const { bodies } = ctx.state;
    return Object.keys(bodies).sort().map((id) => ({ id, position: [...bodies[id].position], size: [...bodies[id].size] }));
  },
} satisfies Operations;
