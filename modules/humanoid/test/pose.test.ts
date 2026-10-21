// Unit tests for humanoid posing: clip sampling, the order and direction of rotations, the parent chain, and the walk clip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { Clip, Model, Rig } from '../types.gen.ts';
import { pose, sample, type Transform, type Vec3 } from '../ts/pose.ts';

const read = <T>(path: string): T => JSON.parse(fs.readFileSync(new URL(`../content/${path}`, import.meta.url), 'utf8')) as T;
const rig = read<Rig>('humanoid.rig/base.json');
const model = read<Model>('humanoid.model/base.json');
const walk = read<Clip>('humanoid.clip/walk.json');

// Rounded to 1e-9; + 0 turns -0 into 0.
const round = (values: number[]): number[] => values.map((v) => Math.round(v * 1e9) / 1e9 + 0);
const place = (t: Transform, p: Vec3): Vec3 => [0, 1, 2].map((i) => t.rotation[i][0] * p[0] + t.rotation[i][1] * p[1] + t.rotation[i][2] * p[2] + t.translation[i]) as Vec3;
const mirrorName = (name: string): string => name.replace(/_l$/, '_R').replace(/_r$/, '_l').replace(/_R$/, '_r');

test('sample blends keys linearly and holds the first and last key outside them', () => {
  const clip: Clip = { rig: 'humanoid/base', duration: 2, parts: { arm: [{ time: 0.5, rotation: [10, 0, 0] }, { time: 1.5, rotation: [30, 0, -20] }] } };
  assert.deepEqual(round(sample(clip, 0).arm), [10, 0, 0]);
  assert.deepEqual(round(sample(clip, 1).arm), [20, 0, -10]);
  assert.deepEqual(round(sample(clip, 2).arm), [30, 0, -20]);
});

test('a clip without keys leaves every part at rest', () => {
  const posed = pose(rig, { rig: 'humanoid/base', duration: 1, parts: {} }, 0.3);
  for (const name of Object.keys(rig.parts)) {
    assert.deepEqual(posed[name].rotation.map(round), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], name);
    assert.deepEqual(round(posed[name].translation), [0, 0, 0], name);
  }
});

test('a positive x angle swings a hanging point backward, and a child moves with its parent', () => {
  const two: Rig = { parts: { hips: { parent: null, pivot: [0, 8, 0] }, leg: { parent: 'hips', pivot: [0, 4, 0] } } };
  const posed = pose(two, { rig: 'x', duration: 1, parts: { hips: [{ time: 0, rotation: [90, 0, 0] }] } }, 0);
  assert.deepEqual(round(place(posed.leg, [0, 0, 0])), [0, 8, -8]);
});

test('angles apply x first, then y, then z', () => {
  const one: Rig = { parts: { root: { parent: null, pivot: [0, 0, 0] } } };
  const posed = pose(one, { rig: 'x', duration: 1, parts: { root: [{ time: 0, rotation: [90, 90, 0] }] } }, 0);
  assert.deepEqual(round(place(posed.root, [0, 1, 0])), [1, 0, 0]);
});

test('the walk is mirrored: the right side at t is the left side half a cycle later, as [x, -y, -z]', () => {
  for (let i = 0; i < 20; i++) {
    const t = i / 20;
    const now = sample(walk, t);
    const later = sample(walk, (t + walk.duration / 2) % walk.duration);
    for (const name of Object.keys(rig.parts)) {
      const [x, y, z] = later[mirrorName(name)] ?? [0, 0, 0];
      assert.deepEqual(round(now[name] ?? [0, 0, 0]), round([x, -y, -z]), `${name} at ${t}`);
    }
  }
});

test('the walk keeps the feet near the floor: the lowest posed cell corner stays between y = -1 and y = 0', () => {
  for (let i = 0; i <= 20; i++) {
    const posed = pose(rig, walk, walk.duration * i / 20);
    const low = Math.min(...Object.entries(model.parts).flatMap(([part, boxes]) => boxes.flatMap((box) => {
      const corners: Vec3[] = [];
      for (const x of [box.from[0] - 0.5, box.to[0] + 0.5]) for (const y of [box.from[1] - 0.5, box.to[1] + 0.5]) for (const z of [box.from[2] - 0.5, box.to[2] + 0.5]) corners.push([x, y, z]);
      return corners.map((corner) => place(posed[part], corner)[1]);
    })));
    assert.ok(low >= -1 && low <= 0, `at ${i}/20: lowest corner ${low}`);
  }
});
