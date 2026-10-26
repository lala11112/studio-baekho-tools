/** Live render QA only: no bridge installation, script compilation, asset creation, or AI invocation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { UnityService } from '../electron/services/unity';
import type { Catalog, PreviewFrameRequest } from '../src/shared/types';

const output = path.resolve('artifacts');
await mkdir(output, { recursive: true });
const unity = new UnityService();
const buffers: { name: string; bytes: Buffer; hash: string }[] = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const started = Date.now();
let sessionId = '';
let sourceFiles = new Map<string, string>();
let connection;
let catalog: Catalog;
try {
  connection = await unity.connect();
  console.log(`Connected to ${connection.projectName}; reading existing catalog.`);
  catalog = await unity.call('catalog');
  const blueprint = structuredClone(catalog.template);
  assert.ok(blueprint.model, 'Drone template must provide a model.');
  const selected = blueprint.attacks[0];
  assert.ok(selected, 'Drone template must provide an attack.');
  const clip = blueprint.animation.states[String(selected.values.animName)] ?? blueprint.animation.states.Idle;
  assert.ok(clip, 'Drone attack or idle clip must be mapped.');
  for (const ref of [blueprint.template, blueprint.model, blueprint.animation.controller, clip]) {
    if (!ref?.path || sourceFiles.has(ref.path)) continue;
    sourceFiles.set(ref.path, hash(await readFile(path.resolve(connection.projectRoot, ref.path))));
  }
  const opened = await unity.call('preview_open', { blueprint });
  sessionId = opened.sessionId;
  assert.ok(sessionId);
  const base: PreviewFrameRequest = { sessionId, sequence: 0, time: 0, yaw: 25, pitch: 12, zoom: 1, clip, blueprint, attackId: selected.id, showHitboxes: false };
  const capture = async (name: string, changes: Partial<PreviewFrameRequest>) => {
    const request = { ...base, ...changes, sequence: buffers.length + 1 };
    const frame = await unity.call('preview_frame', request);
    assert.equal(frame.sequence, request.sequence);
    const url = await unity.previewImage(frame.imagePath, sessionId);
    assert.match(url, /^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(url.substring(url.indexOf(',') + 1), 'base64');
    assert.ok(bytes.length > 1000, 'Render must contain more than an empty tiny JPEG.');
    const destination = path.join(output, name);
    await writeFile(destination, bytes);
    buffers.push({ name, bytes, hash: hash(bytes) });
    console.log(`Rendered ${name}: ${bytes.length} bytes.`);
  };
  await capture('preview-drone-start.jpg', { time: 0 });
  await capture('preview-drone-pose.jpg', { time: .6 });
  await capture('preview-drone-orbit.jpg', { time: .6, yaw: 95, pitch: 24, zoom: 1.2 });
  await capture('preview-drone.jpg', { time: .6, showHitboxes: true });
  assert.notEqual(buffers[0].hash, buffers[1].hash, 'Animation must change the actual model image while hitboxes are hidden.');
  assert.notEqual(buffers[1].hash, buffers[2].hash, 'Orbit/zoom must change the rendered image.');
  assert.notEqual(buffers[1].hash, buffers[3].hash, 'Hitbox overlay must change the rendered image.');
  await unity.call('preview_close', { sessionId });
  sessionId = '';
  for (const [file, before] of sourceFiles) assert.equal(hash(await readFile(path.resolve(connection.projectRoot, file))), before, `Preview changed source asset ${file}.`);
} finally {
  if (sessionId) await unity.call('preview_close', { sessionId }).catch(() => undefined);
  await unity.dispose();
}

const userData = await mkdtemp(path.join(tmpdir(), 'baekho-enemy-live-preview-'));
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'FORGE_DEV_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
const application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, ...(process.argv.includes('--no-gpu') ? ['--disable-gpu'] : [])], env });
const errors: string[] = [];
let page;
try {
  page = await application.firstWindow();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  const pixelStats = await application.evaluate(({ nativeImage }, images) => images.map(item => {
    const image = nativeImage.createFromBuffer(Buffer.from(item.data, 'base64'));
    if (image.isEmpty()) throw new Error(`Cannot decode ${item.name}`);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const sample = [bitmap[0], bitmap[1], bitmap[2]];
    let nonBackground = 0, bright = 0, red = 0, magenta = 0;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const difference = Math.abs(bitmap[offset] - sample[0]) + Math.abs(bitmap[offset + 1] - sample[1]) + Math.abs(bitmap[offset + 2] - sample[2]);
      if (difference > 45) nonBackground++;
      if (Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) > 90) bright++;
      if (bitmap[offset + 2] > 120 && bitmap[offset + 2] > bitmap[offset + 1] * 1.4 && bitmap[offset + 2] > bitmap[offset] * 1.4) red++;
      if (bitmap[offset] > 180 && bitmap[offset + 2] > 180 && bitmap[offset + 1] < 80) magenta++;
    }
    return { name: item.name, width: size.width, height: size.height, nonBackground, bright, red, magenta };
  }), buffers.map(frame => ({ name: frame.name, data: frame.bytes.toString('base64') })));
  for (const stats of pixelStats) {
    assert.equal(stats.width, 512); assert.equal(stats.height, 512);
    assert.ok(stats.nonBackground > 1000, `${stats.name} needs visible model pixels.`);
    assert.ok(stats.bright > 500, `${stats.name} cannot be a uniformly dark background.`);
    assert.ok(stats.magenta < 500, `${stats.name} shows Unity's magenta missing-material error.`);
  }
  assert.ok(pixelStats[3].red > pixelStats[1].red + 50, 'Active hitbox should add red overlay pixels.');
  if (!process.argv.includes('--skip-desktop')) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1540, height: 1000 }));
    await page.locator('[data-action="connect"]').first().click();
    await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('.project-status')?.textContent?.includes('Four-Tiger-Sword'), undefined, { timeout: 120000 });
    await page.waitForFunction(() => { const image = document.querySelector('#preview-image') as HTMLImageElement; return image && !image.hidden && image.naturalWidth === 512 || document.querySelector('#preview-warning')?.textContent?.includes('Error invoking remote method'); });
    assert.equal(await page.locator('#preview-image').evaluate(image => (image as HTMLImageElement).naturalWidth), 512, await page.locator('#preview-warning').innerText());
    await page.locator('[data-tab="attacks"]').click();
    await page.locator('.attack-row').first().click();
    const previous = await page.locator('#preview-image').getAttribute('src');
    await page.locator('#timeline').fill('0.6');
    await page.waitForFunction(old => (document.querySelector('#preview-image') as HTMLImageElement)?.src !== old, previous);
    await page.waitForFunction(minimumRed => {
      const image = document.querySelector('#preview-image') as HTMLImageElement;
      if (!image?.complete || image.naturalWidth !== 512) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, 512, 512).data;
      let red = 0;
      for (let index = 0; index < pixels.length; index += 4)
        if (pixels[index] > 120 && pixels[index] > pixels[index + 1] * 1.4 && pixels[index] > pixels[index + 2] * 1.4) red++;
      return red > minimumRed;
    }, pixelStats[1].red + 300);
    await page.screenshot({ path: path.join(output, 'live-desktop.png'), fullPage: true });
    console.log('Captured real connected Electron UI: artifacts/live-desktop.png');
    // Dispatch the application's existing close listener and let its read-only preview-close RPC settle.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.waitForTimeout(250);
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, mode: 'Live Unity PreviewRenderUtility + real Electron, no generated code or asset creation', project: connection!.projectName, clip: buffers.length ? 'Drone attack mapped in catalog' : '', elapsedMs: Date.now() - started, frames: buffers.map(frame => ({ name: frame.name, hash: frame.hash, bytes: frame.bytes.length })), pixelStats, sourcesUnchanged: [...sourceFiles.keys()], desktopScreenshot: process.argv.includes('--skip-desktop') ? null : 'artifacts/live-desktop.png' };
  await writeFile(path.join(output, 'preview-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'live-desktop-failed.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await application.close();
  assert.equal(path.dirname(path.resolve(userData)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
  assert.ok(path.basename(userData).startsWith('baekho-enemy-live-preview-'));
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
