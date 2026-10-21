// Writes PNG previews of a model record, one per view: node tools/voxel/render.ts <model.json> <out prefix>
// writes <out prefix>-front.png, -quarter.png, -side.png and -back.png.
import fs from 'node:fs';
import { encodePng } from './png.ts';
import { render, VIEWS } from './raster.ts';
import type { Box } from './raster.ts';

const [file, prefix] = process.argv.slice(2);
if (file === undefined || prefix === undefined) {
  console.error('usage: node tools/voxel/render.ts <model.json> <out prefix>');
  process.exit(2);
}
const model = JSON.parse(fs.readFileSync(file, 'utf8')) as { parts: Record<string, Box[]> };
const boxes = Object.values(model.parts).flat();
for (const [name, view] of Object.entries(VIEWS)) {
  const out = `${prefix}-${name}.png`;
  fs.writeFileSync(out, encodePng(render(boxes, view)));
  console.log(out);
}
