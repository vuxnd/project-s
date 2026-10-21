// Unit tests for physics_basic with a fake ctx: spawning, free fall, substeps, ground contact, stacking and the two operations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collide, init, integrate, operations } from '../ts/index.ts';
import type { Ctx, physics } from '../types.gen.ts';

const DT = 1 / 60;
const RECORDS: Record<string, physics.Body> = {
  'test/box': { size: [1, 1, 1], mass: 1 },
  'test/plank': { size: [4, 0.5, 2], mass: 4 },
};

const spawn = (id: string, position: physics.SpawnEvent['position'], body = 'test/box'): physics.SpawnEvent => ({ id, body, position });

// One physics_basic with a ctx whose events and records come from here; tick() runs integrate and collide once, as the fixed loop does.
function simulation(options: { gravity?: physics.Config['gravity']; substeps?: number } = {}) {
  let ticks = 0;
  let delivered: physics.SpawnEvent[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const ctx = {
    module: 'physics_basic',
    state: init(),
    config: { substeps: options.substeps ?? 1 },
    host: {},
    get tick() { return ticks; },
    dt: DT,
    alpha: 0,
    configOf: () => ({ gravity: options.gravity ?? [0, -10, 0] }),
    records: () => RECORDS,
    events: (id: string) => (id === 'physics.spawn' ? delivered : []),
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    call: () => { throw new Error('physics_basic calls nothing'); },
    has: () => true,
  } as unknown as Ctx;
  const tick = (...spawns: physics.SpawnEvent[]): void => {
    delivered = spawns;
    integrate(ctx);
    collide(ctx);
    ticks += 1;
  };
  const run = (count: number): void => {
    for (let i = 0; i < count; i++) tick();
  };
  return { ctx, emitted, tick, run };
}

test('a spawn creates a body with the size of its record and moves it in the same tick', () => {
  const sim = simulation();
  sim.tick(spawn('a', [1, 50, 2]));
  const { a } = sim.ctx.state.bodies;
  assert.deepEqual(a.size, [1, 1, 1]);
  assert.equal(a.resting, false);
  assert.deepEqual([a.position[0], a.position[2]], [1, 2]);
  assert.ok(Math.abs(a.velocity[1] - -10 * DT) < 1e-12);
  assert.ok(Math.abs(a.position[1] - (50 - 10 * DT * DT)) < 1e-12);
});

test('a spawn of an id that exists, or of a record that does not exist, is ignored', () => {
  const sim = simulation();
  sim.tick(spawn('a', [0, 50, 0]));
  sim.tick(spawn('a', [9, 90, 9]), spawn('b', [0, 10, 0], 'test/nothing'));
  assert.deepEqual(Object.keys(sim.ctx.state.bodies), ['a']);
  assert.equal(sim.ctx.state.bodies.a.position[0], 0);
});

test('a free fall over 60 steps stays within 0.2 of 0.5 g t^2 and touches nothing', () => {
  const sim = simulation();
  sim.tick(spawn('a', [0, 100, 0]));
  sim.run(59);
  assert.equal(sim.ctx.tick, 60);
  const t = 60 * DT;
  assert.ok(Math.abs(sim.ctx.state.bodies.a.position[1] - (100 + 0.5 * -10 * t * t)) <= 0.2);
  assert.equal(sim.ctx.state.bodies.a.resting, false);
  assert.deepEqual(sim.emitted, []);
});

test('substeps divide a tick into equal steps', () => {
  const sim = simulation({ substeps: 4 });
  sim.tick(spawn('a', [0, 100, 0]));
  const h = DT / 4;
  // n semi-implicit Euler steps from rest fall g h^2 n (n + 1) / 2, here n = 4.
  assert.ok(Math.abs(sim.ctx.state.bodies.a.position[1] - (100 - 10 * h * h * 10)) < 1e-9);
});

test('a body that reaches the ground rests on it at half its height and emits one contact', () => {
  const sim = simulation();
  sim.tick(spawn('a', [0, 3, 0]));
  sim.run(119);
  const { a } = sim.ctx.state.bodies;
  assert.deepEqual([a.resting, a.position[1], a.velocity], [true, 0.5, [0, 0, 0]]);
  assert.deepEqual(sim.emitted, [{ event: 'physics.contact', payload: { id: 'a', with: 'ground' } }]);
});

test('a body lands on a resting one and rests on its top', () => {
  const sim = simulation();
  sim.tick(spawn('a', [0, 0.5, 0]));
  sim.tick(spawn('b', [0.25, 3, 0]));
  sim.run(120);
  const { a, b } = sim.ctx.state.bodies;
  assert.deepEqual([a.position[1], b.position[1], b.resting], [0.5, 1.5, true]);
  assert.deepEqual(sim.emitted.map((e) => e.payload), [{ id: 'a', with: 'ground' }, { id: 'b', with: 'a' }]);
});

test('a body that only touches the side of a resting one falls to the ground', () => {
  const sim = simulation();
  sim.tick(spawn('a', [0, 0.5, 0]));
  sim.tick(spawn('b', [1, 3, 0]));
  sim.run(120);
  assert.equal(sim.ctx.state.bodies.b.position[1], 0.5);
  assert.deepEqual(sim.emitted.map((e) => e.payload), [{ id: 'a', with: 'ground' }, { id: 'b', with: 'ground' }]);
});

test('position returns a copy of the centre, or null for an unknown id; bodies lists id, position and size sorted by id', () => {
  const sim = simulation();
  sim.tick(spawn('b', [1, 30, 0]), spawn('a', [0, 40, 0], 'test/plank'));
  const centre = operations.position(sim.ctx, { id: 'b' });
  assert.deepEqual(centre, sim.ctx.state.bodies.b.position);
  assert.notEqual(centre, sim.ctx.state.bodies.b.position);
  assert.equal(operations.position(sim.ctx, { id: 'nobody' }), null);
  const listed = operations.bodies(sim.ctx);
  assert.deepEqual(listed.map((body) => body.id), ['a', 'b']);
  assert.deepEqual(listed.map((body) => body.size), [[4, 0.5, 2], [1, 1, 1]]);
  assert.deepEqual(listed[1].position, sim.ctx.state.bodies.b.position);
});
