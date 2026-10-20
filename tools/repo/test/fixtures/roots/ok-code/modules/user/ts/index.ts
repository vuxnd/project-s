import type { Ctx, api } from '../types.gen.ts';

export function use(ctx: Ctx): void {
  const params: api.EchoParams = { text: 'hello' };
  ctx.call<api.EchoResult>('api.echo', params);
}
