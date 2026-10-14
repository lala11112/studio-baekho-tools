import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const output = resolve('.local/ceiling-override-smoke');
const userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const initial = parseProjectFile({ formatVersion: 1, settings: { ...DEFAULT_SETTINGS, width: 8, height: 8, connectionCount: 1 },
  bindings: ['floor', 'ceiling'].map((role, index) => ({ id: role, label: role, role, prefabGuid: String(index + 1).repeat(32),
    prefabPath: `Assets/${role}.prefab`, scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 })),
  map: { version: 4, name: '천장 지정 제거 확인', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
    rows: ['#D######', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'north', label: '북문', x: 1, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }],
    ceilings: [{ x: 2, row: 2, undersideY: 4 }],
    assetOverrides: ['floor', 'ceiling'].map(role => ({ x: 2, row: 2, role, bindingId: role })) } });
const initialPath = resolve(output, 'initial.baekho.json');
await writeFile(initialPath, JSON.stringify(initial));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Regression smoke; no AI calls', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, initialPath);
  await page.locator('[data-action="open"]').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
  const save = async label => {
    const path = resolve(output, `${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await page.locator('[data-action="save"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/, label);
    return parseProjectFile(JSON.parse(await readFile(path, 'utf8')));
  };
  await page.locator('[data-view="grid"]').click(); await page.locator('[data-brush="#"]').click();
  const point = await page.locator('#map-svg').evaluate(svg => {
    const p = new DOMPoint(2.5, 2.5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  const painted = await save('painted-wall');
  assert.equal(painted.map.rows[2][2], '#'); assert.deepEqual(painted.map.ceilings, []); assert.deepEqual(painted.map.assetOverrides, []);
  assert.deepEqual(validateMap(painted.map).filter(issue => issue.severity === 'error'), []);
  await page.locator('[data-action="undo"]').click();
  assert.deepEqual((await save('undo')).map, initial.map);
  await page.locator('[data-action="redo"]').click();
  assert.deepEqual((await save('redo')).map, painted.map);
  assert.deepEqual(errors, []);
  console.log(`Ceiling override smoke passed: paint wall, native save, Undo and Redo. ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
