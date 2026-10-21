// Unit tests for the voxel preview: box expansion, shading per face direction, depth order, PNG bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { encodePng } from '../png.ts';
import { cells, extent, render, VIEWS } from '../raster.ts';
import type { Box, Image } from '../raster.ts';

const RED: Box = { from: [0, 0, 0], to: [0, 0, 0], color: '#c80000' };
const pixel = (image: Image, x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const centre = (image: Image): number[] => pixel(image, image.width >> 1, image.height >> 1);

test('a box covers every cell from from to to, and a later box wins', () => {
  const filled = cells([{ from: [0, 0, 0], to: [1, 0, 2], color: '#000000' }, { from: [1, 0, 2], to: [1, 0, 2], color: '#ffffff' }]);
  assert.equal(filled.size, 6);
  assert.equal(filled.get('1,0,2'), '#ffffff');
});

test('the front view shows the front face at 0.85 on the background', () => {
  const image = render([RED], VIEWS.front);
  assert.deepEqual([image.width, image.height], [80, 80]);   // 1 cell and 2 margin cells each side, 16 px per cell
  assert.deepEqual(centre(image), [170, 0, 0, 255]);
  assert.deepEqual(pixel(image, 0, 0), [0x4b, 0x51, 0x57, 255]);
});

test('the quarter view shows three face directions in three shades', () => {
  const image = render([RED], VIEWS.quarter);
  const reds = new Set<number>();
  for (let i = 0; i < image.width * image.height; i++) if (image.data[i * 4 + 1] === 0) reds.add(image.data[i * 4]);
  assert.deepEqual([...reds].sort((a, b) => a - b), [140, 170, 200]);
});

test('the nearer cube hides the one behind it', () => {
  const back: Box = { from: [0, 0, -1], to: [0, 0, -1], color: '#0000c8' };
  assert.deepEqual(centre(render([RED, back], VIEWS.front)), [170, 0, 0, 255]);
  assert.deepEqual(centre(render([back, RED], VIEWS.front)), [170, 0, 0, 255]);
  assert.deepEqual(centre(render([RED, back], VIEWS.back)), [0, 0, 170, 255]);
});

test('extent gives the centre and the diagonal of the bounding box of the cells', () => {
  // Two cells at opposite corners of a box 2 x 3 x 6 cells; the diagonal is sqrt(4 + 9 + 36) = 7.
  const filled = cells([{ from: [-1, 2, 3], to: [-1, 2, 3], color: '#000000' }, { from: [0, 4, 8], to: [0, 4, 8], color: '#000000' }]);
  assert.deepEqual(extent(filled), { centre: [-0.5, 3, 5.5], diagonal: 7 });
  assert.deepEqual(extent(cells([RED])), { centre: [0, 0, 0], diagonal: Math.sqrt(3) });
});

test('with centre set the image size is constant and a cell at the centre stays in the middle pixels', () => {
  const cell: Box = { from: [3, 2, 1], to: [3, 2, 1], color: '#c80000' };
  for (const view of [VIEWS.front, VIEWS.quarter, { yaw: 100, pitch: -60 }]) {
    const image = render([cell], view, { centre: [3, 2, 1] });
    assert.deepEqual([image.width, image.height], [92, 92], `${view.yaw} ${view.pitch}`);   // ceil((sqrt(3) + 2 * 2) * 16)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (pixel(image, x, y)[0] === 0x4b) continue;   // background
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    for (const x of [45, 46]) for (const y of [45, 46]) assert.equal(pixel(image, x, y)[1], 0, `${view.yaw} ${view.pitch}: pixel ${x},${y}`);
    // The silhouette of a cube is symmetric about its centre, so it is symmetric about the middle of the image.
    assert.ok(Math.abs(minX + maxX + 1 - 92) <= 2 && Math.abs(minY + maxY + 1 - 92) <= 2, `${view.yaw} ${view.pitch}: ${minX} ${maxX} ${minY} ${maxY}`);
  }
});

test('the PNG holds the image rows behind filter byte 0, with valid chunk CRCs', () => {
  const image: Image = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 128]) };
  const png = encodePng(image);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: { type: string; body: Buffer }[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const typed = png.subarray(at + 4, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(typed));
    chunks.push({ type: typed.subarray(0, 4).toString('latin1'), body: typed.subarray(4) });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([...chunks[0].body], [0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  assert.deepEqual([...inflateSync(chunks[1].body)], [0, 1, 2, 3, 255, 4, 5, 6, 128]);
});
