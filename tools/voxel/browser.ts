// Browser check of the voxel viewer in headless Chromium: the model draws and turns on drag, the walk clip plays, a bad clip
// path shows the usage line, and the page logs no error. Serves the repository on a free port, writes screenshots under
// build/browser/, prints one summary line and exits 1 on a failure. Needs the Chromium that npx playwright install chromium downloads.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../hosts/js/web/serve.ts';

const PAGE = 'tools/voxel/web/index.html';
const CLIP = 'modules/humanoid/content/humanoid.clip/walk.json';
const CLIP_USAGE = 'usage: ?clip=<path of a clip .json from the repository root>, a clip of the rig the model names';

const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(root, 'build', 'browser');
fs.mkdirSync(out, { recursive: true });

let checks = 0, failures = 0;
const check = (ok: boolean, what: string): void => {
  checks++;
  if (!ok) {
    failures++;
    console.error(`browser: ${what}`);
  }
};

const server = createServer({ root });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${PAGE}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const open = (query: string): Promise<unknown> => page.goto(`${base}${query}`, { waitUntil: 'networkidle' });
  const caption = (): Promise<string> => page.evaluate(() => document.body.innerText.trim());
  const shot = (name: string): Promise<Buffer> => page.screenshot({ path: path.join(out, `${name}.png`) });
  const drag = async (dx: number): Promise<void> => {
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(400 + dx, 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(100);   // the frame the drag queued
  };

  await open('');
  check((await caption()) === 'Drag to turn', `caption after load: ${await caption()}`);
  const still = await shot('model');
  await drag(180);   // 90 degrees of yaw
  check(!still.equals(await shot('model-turned')), 'a drag does not change the image');

  await open(`?clip=${CLIP}`);
  check((await caption()) === 'Drag to turn', `caption with the clip: ${await caption()}`);
  const first = await shot('walk');
  await page.waitForTimeout(250);
  check(!first.equals(await shot('walk-later')), 'the image does not change over 250 ms: the clip is not playing');

  await open('?clip=nope');
  check((await caption()) === CLIP_USAGE, `caption with a bad clip: ${await caption()}`);
  check(errors.length === 0, `page errors: ${errors.join('; ')}`);
} finally {
  await browser.close();
  server.close();
}
console.log(`browser: ${checks} checks, ${failures} failures, screenshots in build/browser`);
process.exitCode = failures === 0 ? 0 : 1;
