// Unit tests for every humanoid rig and model record: a tree of parts, boxes that do not overlap, left-right symmetry, height, pivots in their own boxes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { Model, Rig } from '../types.gen.ts';

type Box = Model['parts'][string][number];

// Every record of a type by file name, read from the content folder.
const readAll = <T>(type: string): [string, T][] => {
  const dir = new URL(`../content/${type}/`, import.meta.url);
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    .map((file) => [`${type}/${file}`, JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8')) as T]);
};
const rigs = readAll<Rig>('humanoid.rig');
const models = readAll<Model>('humanoid.model').map(([file, model]) => {
  const rig = rigs.find(([rigFile]) => rigFile === `humanoid.rig/${model.rig.replace(/^humanoid\//, '')}.json`);
  assert.ok(rig, `${file}: rig ${model.rig} has no file`);
  return { file, model, rig: rig[1], boxes: Object.entries(model.parts).flatMap(([part, list]) => list.map((box) => ({ part, box }))) };
});

// The other side's name of a part: _l and _r swap, centre parts keep theirs.
const mirrorName = (name: string): string => name.replace(/_l$/, '_R').replace(/_r$/, '_l').replace(/_R$/, '_r');

test('each rig is one tree: one root, every other parent exists and comes first', () => {
  for (const [file, rig] of rigs) {
    const names = Object.keys(rig.parts);
    assert.equal(names.filter((name) => rig.parts[name].parent === null).length, 1, `${file}: roots`);
    for (const [i, name] of names.entries()) {
      const parent = rig.parts[name].parent;
      if (parent !== null) assert.ok(names.indexOf(parent) >= 0 && names.indexOf(parent) < i, `${file}: ${name}: parent ${parent}`);
    }
  }
});

test('each model gives boxes to exactly the parts of the rig it names', () => {
  for (const { file, model, rig } of models) assert.deepEqual(Object.keys(model.parts).sort(), Object.keys(rig.parts).sort(), file);
});

test('every box runs from its low corner to its high corner', () => {
  for (const { file, boxes } of models) {
    for (const { part, box } of boxes) assert.ok([0, 1, 2].every((i) => box.from[i] <= box.to[i]), `${file}: ${part}: ${JSON.stringify(box)}`);
  }
});

test('no two boxes of a model overlap', () => {
  const overlap = (a: Box, b: Box): boolean => [0, 1, 2].every((i) => a.from[i] <= b.to[i] && b.from[i] <= a.to[i]);
  for (const { file, boxes } of models) {
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) assert.ok(!overlap(a.box, b.box), `${file}: ${a.part} ${JSON.stringify(a.box)} overlaps ${b.part} ${JSON.stringify(b.box)}`);
    }
  }
});

test('the body is left-right symmetric: cells, colors and pivots mirror at x = 0', () => {
  for (const { file, boxes } of models) {
    const cells = new Set<string>();
    const mirrored = new Set<string>();
    for (const { part, box } of boxes) {
      for (let x = box.from[0]; x <= box.to[0]; x++) {
        for (let y = box.from[1]; y <= box.to[1]; y++) {
          for (let z = box.from[2]; z <= box.to[2]; z++) {
            cells.add(`${part} ${x},${y},${z} ${box.color}`);
            mirrored.add(`${mirrorName(part)} ${-x},${y},${z} ${box.color}`);
          }
        }
      }
    }
    assert.deepEqual(mirrored, cells, file);
  }
  for (const [file, rig] of rigs) {
    for (const [name, { parent, pivot }] of Object.entries(rig.parts)) {
      const other = rig.parts[mirrorName(name)];
      assert.ok(other, `${file}: ${name} has no mirror part ${mirrorName(name)}`);
      assert.deepEqual([other.parent === null ? null : mirrorName(other.parent), 0 - other.pivot[0], other.pivot[1], other.pivot[2]], [parent, ...pivot], `${file}: ${name}`);
    }
  }
});

test('each body stands on y = 0 and is at most 32 cells tall', () => {
  for (const { file, boxes } of models) {
    const low = Math.min(...boxes.map(({ box }) => box.from[1]));
    const high = Math.max(...boxes.map(({ box }) => box.to[1]));
    assert.equal(low, 0, file);
    assert.ok(high - low + 1 <= 32, `${file}: ${high - low + 1} cells tall`);
  }
});

test('each pivot lies inside or on the surface of its own boxes', () => {
  // A box of cells covers from - 0.5 to to + 0.5 on each axis.
  const touches = (box: Box, p: number[]): boolean => [0, 1, 2].every((i) => box.from[i] - 0.5 <= p[i] && p[i] <= box.to[i] + 0.5);
  for (const { file, model, rig } of models) {
    for (const [name, { pivot }] of Object.entries(rig.parts)) {
      const near = model.parts[name];
      assert.ok(near, `${file}: no boxes for part ${name}`);
      assert.ok(near.some((box) => touches(box, pivot)), `${file}: ${name}: pivot ${JSON.stringify(pivot)}`);
    }
  }
});
