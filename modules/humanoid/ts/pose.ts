// Poses a humanoid rig from a clip: one rigid transform per part at a given time.
// Pure math on the rig and clip records; no clock, no state, no Node or DOM API.
import type { Clip, Rig } from '../types.gen.ts';

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];
export interface Transform { rotation: Mat3; translation: Vec3 }   // rows of the rotation; a rest point p moves to rotation · p + translation

const IDENTITY: Transform = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0] };

const mul = (a: Mat3, b: Mat3): Mat3 => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])) as Mat3;
const apply = (m: Mat3, p: Vec3): Vec3 => m.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]) as Vec3;

// Rz · Ry · Rx for angles in degrees, right-handed: x is applied first.
function matrix([x, y, z]: Vec3): Mat3 {
  const r = Math.PI / 180;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x * r), Math.sin(x * r), Math.cos(y * r), Math.sin(y * r), Math.cos(z * r), Math.sin(z * r)];
  const rx: Mat3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry: Mat3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz: Mat3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return mul(rz, mul(ry, rx));
}

// The angles of each part that has keys, at `time` seconds: linear between keys, the first key before them, the last after them.
export function sample(clip: Clip, time: number): Record<string, Vec3> {
  const angles: Record<string, Vec3> = {};
  for (const [part, keys] of Object.entries(clip.parts)) {
    const next = keys.findIndex((k) => k.time > time);
    if (next === 0) angles[part] = keys[0].rotation;
    else if (next < 0) angles[part] = keys[keys.length - 1].rotation;
    else {
      const a = keys[next - 1], b = keys[next];
      const f = (time - a.time) / (b.time - a.time);
      angles[part] = [0, 1, 2].map((i) => a.rotation[i] + f * (b.rotation[i] - a.rotation[i])) as Vec3;
    }
  }
  return angles;
}

// Where every rig part is at `time` seconds: it turns about its pivot by its angles (x, then y, then z, in its parent's axes)
// and moves with its parent. The caller wraps time for a loop.
export function pose(rig: Rig, clip: Clip, time: number): Record<string, Transform> {
  const angles = sample(clip, time);
  const out: Record<string, Transform> = {};
  for (const [name, { parent, pivot }] of Object.entries(rig.parts)) {
    const local = matrix(angles[name] ?? [0, 0, 0]);
    const up = parent === null ? IDENTITY : out[parent];
    const turned = apply(local, pivot);
    const shift = apply(up.rotation, [pivot[0] - turned[0], pivot[1] - turned[1], pivot[2] - turned[2]]);
    out[name] = { rotation: mul(up.rotation, local), translation: [shift[0] + up.translation[0], shift[1] + up.translation[1], shift[2] + up.translation[2]] };
  }
  return out;
}
