// Draws voxel boxes as flat-shaded unit cubes in an orthographic view, with a depth buffer; a box may be moved as a rigid body.
// Uses no Node or DOM API, so a browser page can import it unchanged.
export type Vec3 = [number, number, number];
export interface Transform { rotation: [Vec3, Vec3, Vec3]; translation: Vec3 }   // rows of the rotation; a point p moves to rotation · p + translation
export interface Box { from: Vec3; to: Vec3; color: string; transform?: Transform }   // every cell from `from` to `to`, both included, moved by `transform`
export interface View { yaw: number; pitch: number }          // degrees; yaw 0 looks from +Z (the front), yaw 90 from +X, pitch from above
export interface Image { width: number; height: number; data: Uint8Array }   // RGBA, rows top first

export const VIEWS: Record<string, View> = {
  front: { yaw: 0, pitch: 0 },
  quarter: { yaw: 35, pitch: 20 },
  side: { yaw: 90, pitch: 0 },
  back: { yaw: 180, pitch: 0 },
};

const SCALE = 16;          // pixels per cell
export const MARGIN = 2;   // empty cells around the model
const BACKGROUND = '#4b5157';

// One shade per face direction; u and v span the face.
const FACES: { normal: Vec3; u: Vec3; v: Vec3; shade: number }[] = [
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 1 },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.55 },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.85 },
  { normal: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.85 },
  { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.7 },
  { normal: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.7 },
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const turn = (t: Transform | undefined, v: Vec3): Vec3 => (t === undefined ? v : t.rotation.map((row) => dot(row, v)) as Vec3);
const move = (t: Transform | undefined, p: Vec3): Vec3 => (t === undefined ? p : turn(t, p).map((x, i) => x + t.translation[i]) as Vec3);

export function parseColor(hex: string): Vec3 {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Vec3;
}

// The color of each filled cell, by "x,y,z"; a later box wins where boxes overlap.
export function cells(boxes: Box[]): Map<string, string> {
  const filled = new Map<string, string>();
  for (const { from, to, color } of boxes) {
    for (let x = from[0]; x <= to[0]; x++) {
      for (let y = from[1]; y <= to[1]; y++) {
        for (let z = from[2]; z <= to[2]; z++) filled.set(key(x, y, z), color);
      }
    }
  }
  return filled;
}

// Camera axes: d points from the model to the camera, r is screen right, u screen up.
function axes(view: View): { d: Vec3; r: Vec3; u: Vec3 } {
  const yaw = (view.yaw * Math.PI) / 180;
  const pitch = (view.pitch * Math.PI) / 180;
  const d: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u: Vec3 = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  return { d, r, u };
}

// The centre and the diagonal length of the bounding box of the filled cells.
export function extent(filled: Map<string, string>): { centre: Vec3; diagonal: number } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const k of filled.keys()) {
    k.split(',').forEach((v, i) => {
      min[i] = Math.min(min[i], Number(v));
      max[i] = Math.max(max[i], Number(v));
    });
  }
  return {
    centre: [0, 1, 2].map((i) => (min[i] + max[i]) / 2) as Vec3,
    diagonal: Math.hypot(...[0, 1, 2].map((i) => max[i] - min[i] + 1)),
  };
}

// With `centre`, the image is a square of constant size with that point in its middle, so the model turns in place;
// without it, the image is cropped to the projected model.
export function render(boxes: Box[], view: View, options: { scale?: number; background?: string; centre?: Vec3 } = {}): Image {
  const scale = options.scale ?? SCALE;
  const filled = cells(boxes);   // at rest: the size of a centred image does not change as boxes move
  const { d, r, u } = axes(view);
  // Boxes with one transform move together and hide the faces they share; a face against a box of another transform is drawn.
  const groups = new Map<Transform | undefined, Box[]>();
  for (const box of boxes) groups.set(box.transform, [...(groups.get(box.transform) ?? []), box]);
  const centres = [...groups].flatMap(([transform, list]) => {
    const own = cells(list);
    return [...own.keys()].map((k) => ({ c: k.split(',').map(Number) as Vec3, color: own.get(k)!, own, transform }));
  });

  let left: number, top: number, width: number, height: number;
  if (options.centre !== undefined) {
    const side = Math.ceil((extent(filled).diagonal + 2 * MARGIN) * scale);
    width = height = side;
    left = dot(options.centre, r) - side / 2 / scale;
    top = dot(options.centre, u) + side / 2 / scale;
  } else {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { c, transform } of centres) {
      for (const corner of [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z): Vec3 => [c[0] + x, c[1] + y, c[2] + z])))) {
        const at = move(transform, corner);
        const sx = dot(at, r), sy = dot(at, u);
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
    left = minX - MARGIN;
    top = maxY + MARGIN;
    width = Math.ceil((maxX - minX + 2 * MARGIN) * scale);
    height = Math.ceil((maxY - minY + 2 * MARGIN) * scale);
  }

  const data = new Uint8Array(width * height * 4);
  const background = new Uint8Array([...parseColor(options.background ?? BACKGROUND), 255]);
  new Uint32Array(data.buffer).fill(new Uint32Array(background.buffer)[0]);   // one word per pixel; both reads and writes use the platform byte order, so the bytes land in order
  const depth = new Float64Array(width * height).fill(-Infinity);

  for (const { c, color: hex, own, transform } of centres) {
    const color = parseColor(hex);
    for (const face of FACES) {
      const n = face.normal;
      if (dot(turn(transform, n), d) <= 1e-9 || own.has(key(c[0] + n[0], c[1] + n[1], c[2] + n[2]))) continue;
      // The face is o + s*U + t*V for s, t in [0, 1]; in screen space o -> (ox, oy), U -> (ux, uy), V -> (vx, vy). A moved face keeps the shade of its rest direction.
      const o = move(transform, [0, 1, 2].map((i) => c[i] + 0.5 * n[i] - 0.5 * face.u[i] - 0.5 * face.v[i]) as Vec3);
      const fu = turn(transform, face.u), fv = turn(transform, face.v);
      const ox = dot(o, r), oy = dot(o, u), od = dot(o, d);
      const ux = dot(fu, r), uy = dot(fu, u), ud = dot(fu, d);
      const vx = dot(fv, r), vy = dot(fv, u), vd = dot(fv, d);
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-9) continue;
      const xs = [ox, ox + ux, ox + vx, ox + ux + vx], ys = [oy, oy + uy, oy + vy, oy + uy + vy];
      const px0 = Math.max(0, Math.floor((Math.min(...xs) - left) * scale));
      const px1 = Math.min(width - 1, Math.ceil((Math.max(...xs) - left) * scale));
      const py0 = Math.max(0, Math.floor((top - Math.max(...ys)) * scale));
      const py1 = Math.min(height - 1, Math.ceil((top - Math.min(...ys)) * scale));
      const shaded = color.map((v) => Math.round(v * face.shade));
      for (let py = py0; py <= py1; py++) {
        for (let px = px0; px <= px1; px++) {
          const qx = left + (px + 0.5) / scale - ox, qy = top - (py + 0.5) / scale - oy;
          const s = (qx * vy - qy * vx) / det, t = (ux * qy - uy * qx) / det;
          if (s < 0 || s > 1 || t < 0 || t > 1) continue;
          const z = od + s * ud + t * vd;
          const i = py * width + px;
          if (z <= depth[i]) continue;
          depth[i] = z;
          data.set(shaded, i * 4);
        }
      }
    }
  }
  return { width, height, data };
}
