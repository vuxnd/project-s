// Voxel viewer page: fetches a model record, draws it with the rasterizer, turns it as the pointer drags and plays a clip on a loop.
import { pose } from '../../../modules/humanoid/ts/pose.ts';
import type { Clip, Rig } from '../../../modules/humanoid/types.gen.ts';
import { cells, extent, MARGIN, render, VIEWS } from '../raster.ts';
import type { Box, Image, Transform, Vec3, View } from '../raster.ts';

export const DEFAULT_MODEL = 'modules/humanoid/content/humanoid.model/base.json';
export const BACKGROUND = '#c9d3d8';   // the page background in index.html
export const MAX_PITCH = 80;
export const DEGREES_PER_PIXEL = 0.5;

const USAGE = 'usage: ?model=<path of a model .json from the repository root>';
export const CLIP_USAGE = 'usage: ?clip=<path of a clip .json from the repository root>, a clip of the rig the model names';

export interface Size { width: number; height: number }

export interface ViewEnv {
  search: string;
  size(): Size;                                              // the canvas in device pixels
  fetchJson(url: string): Promise<unknown>;
  draw(image: Image, size: Size): void;                      // paints the image centred on a canvas of this size
  requestFrame(callback: () => void): void;                  // runs the callback before the next paint
  onDrag(handler: (dx: number, dy: number) => void): void;   // pointer movement in CSS pixels
  onResize(handler: () => void): void;
  report(message: string): void;
  now(): number;                                             // milliseconds, increasing; performance.now() in the page
}

const isRecordPath = (path: string): boolean => /\.json$/.test(path) && path.split('/').every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment));

// The URL of the model record: a path from the repository root, or the default when the parameter is absent.
export function modelUrl(search: string): string {
  const path = new URLSearchParams(search).get('model') ?? DEFAULT_MODEL;
  if (!isRecordPath(path)) throw new Error(USAGE);
  return `/${path}`;
}

// The URL of the clip record, or undefined when the address names none; a malformed path throws CLIP_USAGE.
export function clipUrl(search: string): string | undefined {
  const path = new URLSearchParams(search).get('clip');
  if (path === null) return undefined;
  if (!isRecordPath(path)) throw new Error(CLIP_USAGE);
  return `/${path}`;
}

// The rig record `rig` (<module>/<name>) in the root that holds the clip at `clip`; anything else throws CLIP_USAGE.
export function rigUrl(clip: string, rig: string): string {
  const root = /^(.*?)\/modules\/[^/]+\/content\//.exec(clip);
  const id = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(rig);
  if (root === null || id === null) throw new Error(CLIP_USAGE);
  return `${root[1]}/modules/${id[1]}/content/humanoid.rig/${id[2]}.json`;
}

// Every box of every part, in part order; with transforms, each box carries its part's transform.
export function boxes(record: unknown, transforms?: Record<string, Transform>): Box[] {
  const parts = (record as { parts: Record<string, Box[]> }).parts;
  if (transforms === undefined) return Object.values(parts).flat();
  return Object.entries(parts).flatMap(([name, list]) => list.map((box) => ({ ...box, transform: transforms[name] })));
}

// Pixels per cell, a whole number: the diagonal of the bounding box of the cells plus the margin fits the shorter side
// of the window, so the model fits at every angle.
export function fitScale(filled: Map<string, string>, width: number, height: number): number {
  return Math.max(1, Math.floor(Math.min(width, height) / (extent(filled).diagonal + 2 * MARGIN)));
}

// Dragging right or down moves the near surface of the model with the pointer.
export function nextView(view: View, dx: number, dy: number): View {
  return {
    yaw: view.yaw - dx * DEGREES_PER_PIXEL,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, view.pitch + dy * DEGREES_PER_PIXEL)),
  };
}

// Draws once the model is loaded, once per frame that saw a drag, and again after each resize; a bad address or record is
// reported as the usage line. With a clip, it draws the pose of every frame instead, looping the clip from the start; a bad
// clip, or one of another rig than the model's, is reported as the clip usage line.
export async function start(env: ViewEnv): Promise<void> {
  let model: unknown, list: Box[], filled: Map<string, string>, centre: Vec3;
  try {
    model = await env.fetchJson(modelUrl(env.search));
    list = boxes(model);
    if (list.length === 0) throw new Error('no boxes');
    filled = cells(list);
    ({ centre } = extent(filled));
  } catch {
    env.report(USAGE);
    return;
  }
  let play: { clip: Clip; rig: Rig } | undefined;
  try {
    const clipAt = clipUrl(env.search);
    if (clipAt !== undefined) {
      const clip = await env.fetchJson(clipAt) as Clip;
      if (clip.rig !== (model as { rig: string }).rig) throw new Error('the clip is of another rig');
      const rig = await env.fetchJson(rigUrl(clipAt, clip.rig)) as Rig;
      boxes(model, pose(rig, clip, 0));   // a malformed record fails here, not inside a frame
      play = { clip, rig };
    }
  } catch {
    env.report(CLIP_USAGE);
    return;
  }
  let view: View = { ...VIEWS.quarter };
  let pending = false;
  let shown = list;
  const redraw = (): void => {
    const size = env.size();
    env.draw(render(shown, view, { scale: fitScale(filled, size.width, size.height), background: BACKGROUND, centre }), size);
  };
  env.onDrag((dx, dy) => {
    view = nextView(view, dx, dy);
    if (play !== undefined || pending) return;   // while playing, the next frame draws the new view
    pending = true;
    env.requestFrame(() => {
      pending = false;
      redraw();
    });
  });
  env.onResize(redraw);
  if (play === undefined) {
    redraw();
    return;
  }
  const { clip, rig } = play;
  const begin = env.now();
  const frame = (): void => {
    shown = boxes(model, pose(rig, clip, ((env.now() - begin) / 1000) % clip.duration));
    redraw();
    env.requestFrame(frame);
  };
  frame();
}

if (typeof document !== 'undefined') {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const caption = document.getElementById('caption') as HTMLElement;
  const context = canvas.getContext('2d')!;
  let active: PointerEvent | null = null;   // the pointer that drags; other pointers are ignored until it ends
  const end = (e: PointerEvent): void => {
    if (active !== null && e.pointerId === active.pointerId) active = null;
  };
  start({
    search: location.search,
    size: () => ({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) }),
    async fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response.json();
    },
    draw(image, size) {
      if (canvas.width !== size.width || canvas.height !== size.height) {   // resizing clears the canvas, so only when the size changed
        canvas.width = size.width;
        canvas.height = size.height;
      }
      const pixels = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
      context.putImageData(pixels, Math.floor((size.width - image.width) / 2), Math.floor((size.height - image.height) / 2));
    },
    requestFrame: (callback) => { requestAnimationFrame(() => { callback(); }); },
    onDrag(handler) {
      canvas.addEventListener('pointerdown', (e) => {
        if (active !== null || e.button !== 0) return;
        active = e;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (active === null || e.pointerId !== active.pointerId) return;
        handler(e.clientX - active.clientX, e.clientY - active.clientY);
        active = e;
      });
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('lostpointercapture', end);   // the drag also ends when the capture is lost without a pointerup
    },
    onResize(handler) {
      addEventListener('resize', handler);
      const watchDensity = (): void => {   // the query matches only the current ratio, so it changes once, when the page moves to another screen
        matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
          handler();
          watchDensity();
        }, { once: true });
      };
      watchDensity();
    },
    report: (message) => { caption.textContent = message; },
    now: () => performance.now(),
  });
}
