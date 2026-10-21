// Unit tests for sandbox_rules with a fake ctx: three physics.spawn events at tick 0 and none at tick 1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../ts/index.ts';
import type { Ctx, Spawn } from '../types.gen.ts';

const RECORDS: Record<string, Spawn> = {
  'sandbox_rules/crate_a': { body: 'sandbox_rules/crate', position: [0, 6, 0] },
  'sandbox_rules/crate_b': { body: 'sandbox_rules/crate', position: [0.25, 9, 0] },
  'sandbox_rules/plank': { body: 'sandbox_rules/plank', position: [0, 3.25, 0] },
};

// What start emits when it runs as the given tick.
function emittedAt(tick: number): { event: string; payload: unknown }[] {
  const emitted: { event: string; payload: unknown }[] = [];
  const ctx = {
    module: 'sandbox_rules',
    state: undefined,
    tick,
    records: () => RECORDS,
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
  } as unknown as Ctx;
  start(ctx);
  return emitted;
}

test('tick 0 emits one physics.spawn per spawn record, with the id after the slash', () => {
  assert.deepEqual(emittedAt(0), [
    { event: 'physics.spawn', payload: { id: 'crate_a', body: 'sandbox_rules/crate', position: [0, 6, 0] } },
    { event: 'physics.spawn', payload: { id: 'crate_b', body: 'sandbox_rules/crate', position: [0.25, 9, 0] } },
    { event: 'physics.spawn', payload: { id: 'plank', body: 'sandbox_rules/plank', position: [0, 3.25, 0] } },
  ]);
});

test('tick 1 and later emit nothing', () => {
  assert.deepEqual(emittedAt(1), []);
  assert.deepEqual(emittedAt(300), []);
});
