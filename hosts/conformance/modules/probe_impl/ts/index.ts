// Step interpreter: runs the probe.step records of a trace and logs what each runtime rule did with them.
import type { Ctx, Operations, State, probe } from '../types.gen.ts';

type Entry = State['log'][number];

function act(ctx: Ctx, step: probe.Step): unknown {
  const id = step.id as string;
  switch (step.do) {
    case 'emit': ctx.emit(id, step.payload); return null;
    case 'events': return ctx.events(id);
    case 'call': return ctx.call(id, step.payload);
    case 'has': return ctx.has(id);
    case 'config': return ctx.config;
    case 'configOf': return ctx.configOf(id);
    case 'records': return ctx.records(id);
    case 'time': return { tick: ctx.tick, dt: ctx.dt };
  }
}

function run(ctx: Ctx, where: string): void {
  for (const step of Object.values(ctx.records<probe.Step>('probe.step'))) {
    if (step.in !== where || step.tick !== ctx.tick) continue;
    const entry: Entry = { tick: ctx.tick, in: step.in, do: step.do };
    if (step.id !== undefined) entry.id = step.id;
    try {
      entry.result = JSON.parse(JSON.stringify(act(ctx, step)) ?? 'null');   // JSON.stringify(undefined) is undefined
    } catch (e) {
      entry.error = (e as Error).message;
    }
    ctx.state.log.push(entry);
  }
}

export function init(ctx: Ctx): State {
  ctx.state = { log: [] };
  run(ctx, 'init');
  return ctx.state;
}

export function first(ctx: Ctx): void {
  run(ctx, 'first');
}

export function second(ctx: Ctx): void {
  run(ctx, 'second');
}

export const operations = {
  log(ctx: Ctx): probe.LogResult {
    return ctx.state.log;
  },
} satisfies Operations;
