// sandbox_rules on JavaScript hosts: at tick 0, one physics.spawn for every sandbox_rules.spawn record.
import type { Ctx, Spawn, physics } from '../types.gen.ts';

export function start(ctx: Ctx): void {
  if (ctx.tick !== 0) return;
  for (const [id, record] of Object.entries(ctx.records<Spawn>('sandbox_rules.spawn'))) {
    const spawn: physics.SpawnEvent = { id: id.slice(id.indexOf('/') + 1), body: record.body, position: [...record.position] };
    ctx.emit('physics.spawn', spawn);
  }
}
