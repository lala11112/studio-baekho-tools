// Creation-time door dimensions through the real Electron UI. AI handlers are local mocks.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const output = resolve('.local/connection-size-smoke');
const userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const room = { version: 4, name: 'Connection size smoke', width: 8, height: 8, cellSize: 2,
  rows: ['________', '_######_', '_#....#_', '_#....#_', '_#....#_', '_#....#_', '_#D####_', '________'],
  elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], maxStepHeight: .4,
  connections: [{ id: 'south', label: 'Existing south', x: 2, row: 6, direction: 180, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
const fixture = { formatVersion: 1, map: room, settings: { prompt: '크기를 직접 정한 연결문이 있는 방', width: 8, height: 8,
  cellSize: 2, elevationStep: 2, maxStepHeight: .4, connectionCount: 1, codexModel: '' }, bindings: [] };
const fixturePath = resolve(output, 'legacy.baekho.json');
await writeFile(fixturePath, JSON.stringify(fixture));
const candidate = structuredClone(room);
candidate.rows[1] = '_#DDD##_'; candidate.rows[6] = '_######_';
candidate.connections = [{ id: 'north', label: 'Requested north', x: 2, row: 1, direction: 0, width: 4.5, height: 3.75, kind: 'door' }];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, { directory, candidate }) => {
    app.setPath('userData', directory);
    globalThis.connectionSizeSmoke = { candidate, requests: [] };
    for (const channel of ['codex-status', 'generate-concept', 'generate-image', 'extract-layout']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local test', models: [] }));
    ipcMain.handle('baekho:generate-concept', () => '넓은 연결문으로 이어지는 고요한 석조 전투장. 중앙 공간을 비워 이동과 회피가 자연스럽게 이어진다.');
    ipcMain.handle('baekho:generate-image', async (_event, settings) => {
      globalThis.connectionSizeSmoke.requests.push({ phase: 'image', settings });
      await new Promise(done => setTimeout(done, 500));
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    });
    ipcMain.handle('baekho:extract-layout', (_event, settings) => {
      globalThis.connectionSizeSmoke.requests.push({ phase: 'extract', settings });
      return globalThis.connectionSizeSmoke.candidate;
    });
    dialog.showMessageBoxSync = () => 1;
  }, { directory: userData, candidate });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-action="codex"]')?.textContent?.includes('연결됨'));
  assert.equal(await page.locator('#connectionWidth').inputValue(), '4');
  assert.equal(await page.locator('#connectionHeight').inputValue(), '3');
  const open = async path => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, path);
    await page.locator('[data-action="open"]').click();
    if (await page.locator('#discard-dialog[open]').count())
      await page.locator('#discard-dialog button[value="discard"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
  };
  let serial = 0;
  const save = async label => {
    const path = resolve(output, `${++serial}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료'));
    return { path, project: JSON.parse(await readFile(path, 'utf8')) };
  };
  const set = async (id, value) => { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); };
  await open(fixturePath);
  await set('connectionWidth', 4.5); await set('connectionHeight', 3.75);
  await set('connectionWidth', 0);
  assert.equal(await page.locator('#connectionWidth').inputValue(), '4.5', 'invalid width is rejected without losing the previous setting');
  const preferences = await save('preferences');
  assert.equal(preferences.project.settings.connectionWidth, 4.5);
  assert.equal(preferences.project.settings.connectionHeight, 3.75);
  assert.deepEqual(preferences.project.map.rows, room.rows, 'size preferences preserve the current map');
  assert.deepEqual(preferences.project.map.connections, room.connections);
  await page.locator('[data-generation-control="preset"]').selectOption('medium');
  assert.equal(await page.locator('#connectionWidth').inputValue(), '4.5', 'preset changes retain chosen dimensions');
  assert.equal(await page.locator('#connectionHeight').inputValue(), '3.75');
  await open(preferences.path);
  assert.equal(await page.locator('#connectionWidth').inputValue(), '4.5', 'saved dimensions survive reopen');
  assert.equal(await page.locator('#connectionHeight').inputValue(), '3.75');
  await page.locator('#connectionWidth').scrollIntoViewIfNeeded();
  await page.locator('.left-panel').screenshot({ path: resolve(output, 'connection-size-controls.png') });

  await page.locator('[data-view="grid"]').click();
  await page.locator('[data-edit-mode="select"]').click();
  const point = await page.locator('#map-svg').evaluate(svg => {
    const p = new DOMPoint(2.5, 1.5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.locator('[data-action="add-connection"]').click();
  assert.equal(await page.locator('[data-connection="width"]').inputValue(), '4.5');
  assert.equal(await page.locator('[data-connection="height"]').inputValue(), '3.75');
  const manual = (await save('manual')).project;
  assert.equal(manual.map.rows[1], '_#DDD##_', 'manual creation opens the complete three-cell aperture');
  assert.deepEqual(manual.map.connections.find(c => c.id === 'south'), room.connections[0], 'existing door dimensions stay intact');
  assert.equal(manual.map.connections.length, 2);

  await page.locator('[data-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('#connectionWidth')?.disabled);
  assert.equal(await page.locator('#connectionHeight').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('맵을 생성했습니다'));
  const requests = await app.evaluate(() => globalThis.connectionSizeSmoke.requests);
  assert.deepEqual(requests.map(r => r.phase), ['image', 'extract']);
  for (const request of requests) {
    assert.equal(request.settings.connectionWidth, 4.5); assert.equal(request.settings.connectionHeight, 3.75);
  }
  const generated = (await save('generated')).project;
  assert.deepEqual(generated.map.connections, candidate.connections);
  assert.equal(generated.map.rows[1], '_#DDD##_');
  assert.deepEqual(errors, []);
  console.log('PASS connection dimensions: defaults, inputs, validation, save/reopen, preset retention, unchanged existing doors, manual wide opening and both AI phases.');
} finally { await app.close(); }
