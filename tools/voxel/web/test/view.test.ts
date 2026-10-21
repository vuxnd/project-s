// Tests for tools/voxel/web/view.ts: the pure functions and start with a fake environment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BACKGROUND, DEFAULT_MODEL, boxes, fitScale, modelUrl, nextView, start } from '../view.ts';
import type { Size, ViewEnv } from '../view.ts';
import { cells, extent, render, VIEWS } from '../../raster.ts';
import type { Image } from '../../raster.ts';

const USAGE = 'usage: ?model=<path of a model .json from the repository root>';

const leg = { from: [0, 0, 0], to: [2, 3, 0], color: '#112233' };
const arm = { from: [0, 4, 0], to: [2, 11, 5], color: '#445566' };
const record = { $version: 1, rig: 'humanoid/base', parts: { leg: [leg], arm: [arm] } };

test('boxes lists the boxes of every part in part order', () => {
  assert.deepEqual(boxes(record), [leg, arm]);
  assert.deepEqual(boxes({ parts: {} }), []);
});

test('modelUrl defaults to the base humanoid and rejects a malformed path', () => {
  assert.equal(modelUrl(''), `/${DEFAULT_MODEL}`);
  assert.equal(modelUrl('?model=a/b.json'), '/a/b.json');
  for (const search of ['?model=', '?model=a', '?model=../a.json', '?model=/a.json', '?model=a//b.json', '?model=a%5Cb.json']) {
    assert.throws(() => modelUrl(search), { name: 'Error', message: USAGE }, search);
  }
});

// Cells 3 x 4 x 12: the diagonal is 13, so with the margin of 2 cells on each side 17 cells fit the shorter side.
const block = cells([{ from: [5, 0, 0], to: [7, 3, 11], color: '#102030' }]);

test('fitScale divides the shorter window side by the diagonal plus the margin, rounded down', () => {
  assert.equal(fitScale(block, 800, 510), 30);
  assert.equal(fitScale(block, 510, 800), 30);
  assert.equal(fitScale(block, 800, 500), 29);
  assert.equal(fitScale(block, 5, 5), 1);
});

test('with the scale from fitScale and a centre, the image is a square of the shorter window side at every angle', () => {
  const scale = fitScale(block, 800, 510);
  const { centre } = extent(block);
  for (let yaw = 0; yaw < 360; yaw += 30) {
    for (const pitch of [-80, -30, 0, 45, 80]) {
      const image = render([{ from: [5, 0, 0], to: [7, 3, 11], color: '#102030' }], { yaw, pitch }, { scale, centre });
      assert.ok(image.width === 510 && image.height === 510, `${yaw} ${pitch}: ${image.width} x ${image.height}`);
    }
  }
});

test('nextView turns yaw with horizontal drag and pitch with vertical drag, 0.5 degrees per pixel', () => {
  assert.deepEqual(nextView({ yaw: 35, pitch: 20 }, 0, 0), { yaw: 35, pitch: 20 });
  assert.deepEqual(nextView({ yaw: 35, pitch: 20 }, 10, 0), { yaw: 30, pitch: 20 });
  assert.deepEqual(nextView({ yaw: 35, pitch: 20 }, -20, 0), { yaw: 45, pitch: 20 });
  assert.deepEqual(nextView({ yaw: 35, pitch: 20 }, 0, 10), { yaw: 35, pitch: 25 });
});

test('nextView clamps pitch to -80..80 degrees', () => {
  assert.equal(nextView({ yaw: 0, pitch: 70 }, 0, 100).pitch, 80);
  assert.equal(nextView({ yaw: 0, pitch: -70 }, 0, -100).pitch, -80);
  assert.equal(nextView({ yaw: 0, pitch: 80 }, 0, 1).pitch, 80);
});

// Images are megabytes, so a failed deepEqual would take minutes to print its diff: compare the sizes, then the bytes.
const sameBytes = (a: Image, b: Image): boolean => Buffer.from(a.data).equals(Buffer.from(b.data));
function assertSameImage(actual: Image, expected: Image, message: string): void {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${message}: size`);
  assert.ok(sameBytes(actual, expected), `${message}: pixels differ`);
}

// An environment that records what start does; `fetched` lists the requested URLs. A frame callback runs at once,
// or waits in `frames` when the test passes a list.
function fakeEnv(fetchJson: (url: string) => Promise<unknown>, search = '', frames?: (() => void)[]) {
  const log = { fetched: [] as string[], draws: [] as { image: Image; size: Size }[], reports: [] as string[] };
  let drag: (dx: number, dy: number) => void = () => {};
  let resize: () => void = () => {};
  let size: Size = { width: 800, height: 600 };
  const env: ViewEnv = {
    search,
    size: () => size,
    async fetchJson(url) {
      log.fetched.push(url);
      return fetchJson(url);
    },
    draw: (image, s) => { log.draws.push({ image, size: s }); },
    requestFrame: (callback) => { if (frames) frames.push(callback); else callback(); },
    onDrag: (handler) => { drag = handler; },
    onResize: (handler) => { resize = handler; },
    report: (message) => { log.reports.push(message); },
  };
  return { env, log, drag: (dx: number, dy: number) => drag(dx, dy), resize: (s: Size) => { size = s; resize(); } };
}

test('start fetches the default model, draws once, and draws again after a drag', async () => {
  const { env, log, drag } = fakeEnv(async () => record);
  await start(env);
  assert.deepEqual(log.fetched, [`/${DEFAULT_MODEL}`]);
  assert.equal(log.draws.length, 1);
  assert.deepEqual(log.reports, []);
  const first = log.draws[0];
  assert.deepEqual(first.size, { width: 800, height: 600 });
  assert.deepEqual([...first.image.data.slice(0, 4)], [0xc9, 0xd3, 0xd8, 255]);   // the page background in the corner
  const filled = cells(boxes(record));
  const options = { scale: fitScale(filled, 800, 600), background: BACKGROUND, centre: extent(filled).centre };
  assertSameImage(first.image, render(boxes(record), VIEWS.quarter, options), 'first draw');
  drag(40, 0);
  assert.equal(log.draws.length, 2);
  assert.deepEqual([log.draws[1].image.width, log.draws[1].image.height], [first.image.width, first.image.height]);
  assert.ok(!sameBytes(log.draws[1].image, first.image), 'the drag changed the pixels');
});

test('start draws once for the drags of one frame, with the view after the last', async () => {
  const frames: (() => void)[] = [];
  const { env, log, drag } = fakeEnv(async () => record, '', frames);
  await start(env);
  drag(10, 0);
  drag(10, 0);
  drag(10, 5);
  assert.equal(log.draws.length, 1);
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.equal(log.draws.length, 2);
  drag(1, 0);
  assert.equal(frames.length, 1);   // the next frame asks again
  const filled = cells(boxes(record));
  const options = { scale: fitScale(filled, 800, 600), background: BACKGROUND, centre: extent(filled).centre };
  assertSameImage(log.draws[1].image, render(boxes(record), nextView(nextView(nextView({ ...VIEWS.quarter }, 10, 0), 10, 0), 10, 5), options), 'second draw');
});

test('start draws again with a new scale after a resize', async () => {
  const { env, log, resize } = fakeEnv(async () => record);
  await start(env);
  resize({ width: 1600, height: 1200 });
  assert.equal(log.draws.length, 2);
  assert.deepEqual(log.draws[1].size, { width: 1600, height: 1200 });
  assert.ok(log.draws[1].image.width > log.draws[0].image.width);
});

test('start fetches the model of the address', async () => {
  const { env, log } = fakeEnv(async () => record, '?model=x/y.json');
  await start(env);
  assert.deepEqual(log.fetched, ['/x/y.json']);
});

test('start shows the usage line when the fetch fails, the record is not a model or the address is malformed', async () => {
  for (const [fetchJson, search] of [
    [async () => { throw new Error('404'); }, ''],
    [async () => ({ nothing: true }), ''],
    [async () => ({ parts: {} }), ''],
    [async () => record, '?model=../x.json'],
  ] as const) {
    const { env, log } = fakeEnv(fetchJson, search);
    await start(env);
    assert.deepEqual(log.reports, [USAGE], search);
    assert.equal(log.draws.length, 0);
  }
});

test('start shows the usage line for a rig record, which has no parts of boxes', async () => {
  for (const rigRecord of [{ $version: 1, rig: 'humanoid/base', bones: {} }, { $version: 1, parts: { spine: { parent: 'hips' } } }]) {
    const { env, log } = fakeEnv(async () => rigRecord);
    await start(env);
    assert.deepEqual(log.reports, [USAGE], JSON.stringify(rigRecord));
    assert.equal(log.draws.length, 0);
  }
});

test('the base model keeps 2 cells of background around it at every angle', async () => {
  const base = JSON.parse(await readFile(new URL('../../../../modules/humanoid/content/humanoid.model/base.json', import.meta.url), 'utf8'));
  const list = boxes(base);
  const filled = cells(list);
  const { centre } = extent(filled);
  const scale = fitScale(filled, 800, 600);
  for (let yaw = 0; yaw < 360; yaw += 30) {
    for (const pitch of [-80, -45, 0, 45, 80]) {
      const { width, height, data } = render(list, { yaw, pitch }, { scale, centre, background: BACKGROUND });
      let margin = Infinity;   // empty pixels between the shaded ones and the nearest image border
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] === 0xc9 && data[i + 1] === 0xd3 && data[i + 2] === 0xd8) continue;
          margin = Math.min(margin, x, y, width - 1 - x, height - 1 - y);
        }
      }
      assert.ok(margin >= 2 * scale, `${yaw} ${pitch}: margin ${margin} px, scale ${scale}`);
    }
  }
});

test('importing view.ts in Node starts nothing', async (t) => {
  const calls: string[] = [];
  const { fetch } = globalThis;
  t.after(() => {
    Object.assign(globalThis, { fetch });
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });
  Object.assign(globalThis, { fetch: () => calls.push('fetch'), requestAnimationFrame: () => calls.push('requestAnimationFrame') });
  assert.equal(typeof document, 'undefined');
  const specifier = new URL('../view.ts?again', import.meta.url).href;   // a new instance, so its top level runs again
  const again = await import(specifier);
  assert.equal(typeof again.start, 'function');
  assert.deepEqual(calls, []);
});
