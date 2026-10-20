import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
const output = resolve('.local/vegetation-smoke');
const userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 12, connectionCount: 1, conceptMode: 'manual',
  prompt: 'Vegetation UI regression', designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, decorations: true } };
const bindings = ['floor', 'wall', 'door', 'decoration', 'vegetation'].map((role, index) => ({
  id: role, role, label: role, prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${role}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
  ...(['decoration', 'vegetation'].includes(role) ? { prop: { category: role, tags: [], blocksMovement: false,
    size: { x: 3, y: 2, z: 4 }, placement: 'floor', roomTypes: ['battle'], weight: 1 } } : {}),
}));
let map = { version: 5, name: 'Vegetation UI', width: 12, height: 12, cellSize: 2,
  rows: ['######D#####', ...Array(10).fill('#..........#'), '############'],
  elevations: Array.from({ length: 12 }, () => Array(12).fill(0)), ramps: [], assetOverrides: [], maxStepHeight: .4,
  connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
map = insertPropInstance(map, { x: 2, row: 2 }, 'decoration', settings, bindings);
map = insertPropInstance(map, { x: 7, row: 7 }, 'vegetation', settings, bindings);
const input = resolve(output, 'input.baekho.json');
await writeFile(input, JSON.stringify({ formatVersion: 1, map, settings, bindings }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, path) => {
    app.setPath('userData', path); dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, input);
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await expand();
  assert.equal(await page.locator('[data-d-feature="decorations"]').isChecked(), true);
  assert.equal(await page.locator('[data-d-feature="vegetation"]').isChecked(), false);
  await page.locator('[data-d-feature="vegetation"]').check(); await expand();
  for (const [key, value] of [['decorationDensity', 3], ['vegetationDensity', 8]]) {
    const control = page.locator(`[data-d-control="setting:${key}"]`);
    await control.fill(String(value)); await control.press('Tab'); await expand();
  }
  await page.locator('[data-right-tab="assets"]').click(); await expand();
  assert.equal(await page.locator('#newAssetRole option[value="decoration"]').innerText(), '장식');
  assert.equal(await page.locator('#newAssetRole option[value="vegetation"]').innerText(), '식생');
  const classification = () => page.locator('[data-prop-binding="decoration"][data-prop-field="role"]');
  await classification().selectOption('vegetation'); await expand();
  assert.equal(await classification().inputValue(), 'vegetation');
  await page.locator('[data-action="undo"]').click(); await expand();
  assert.equal(await classification().inputValue(), 'decoration');
  await page.locator('[data-action="redo"]').click(); await expand();
  assert.equal(await classification().inputValue(), 'vegetation');
  const saved = resolve(output, 'saved.baekho.json');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, saved);
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료'));
  const project = JSON.parse(await readFile(saved, 'utf8'));
  assert.equal(project.settings.designer.decorationDensity, 3); assert.equal(project.settings.designer.vegetationDensity, 8);
  assert.equal(project.settings.designer.decorations, true); assert.equal(project.settings.designer.vegetation, true);
  assert.equal(project.bindings.find(b => b.id === 'decoration').role, 'vegetation');
  assert.deepEqual(project.map.propInstances, map.propInstances.map(p => ({ ...p, role: 'vegetation' })));
  await page.locator('[data-view="grid"]').click();
  await page.screenshot({ path: resolve(output, 'vegetation.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS vegetation UI: independent toggles/densities, distinct asset roles, existing classification, Undo/Redo, save and footprint preservation.');
} finally {
  await app.close();
}
