// A counter that probe_impl may or may not have as a peer.
import type { AddParams, AddResult, Ctx, Operations, State } from '../types.gen.ts';

export function init(): State {
  return { total: 0 };
}

export function peer(ctx: Ctx): void {
  ctx.state.total += 10;
  ctx.emit('probe_peer.note', { tick: ctx.tick });
}

export const operations = {
  add(ctx: Ctx, params: AddParams): AddResult {
    ctx.state.total += params.n;
    return ctx.state.total;
  },
} satisfies Operations;
