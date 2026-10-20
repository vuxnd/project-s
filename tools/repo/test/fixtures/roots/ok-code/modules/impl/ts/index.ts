import type { Ctx, Operations, State, api } from '../types.gen.ts';

export function init(): State {
  return { calls: 0, seen: {}, last: null };
}

export const operations = {
  echo(ctx: Ctx, params: api.EchoParams): api.EchoResult {
    ctx.state.calls += 1;
    ctx.state.seen[params.text] = (ctx.state.seen[params.text] ?? 0) + 1;
    ctx.state.last = params.text;
    return { text: `${ctx.configOf<api.Config>('api').greeting} ${params.text}`, length: params.text.length };
  },
} satisfies Operations;
