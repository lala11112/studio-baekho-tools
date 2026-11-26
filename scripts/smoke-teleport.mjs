import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const output = resolve('.local/teleport-smoke');
const userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const map = { version: 5, name: '순간이동 화면 검증', width: 10, height: 10, cellSize: 2, maxStepHeight: .4,
  rows: ['####D#####', ...Array(8).fill('#........#'), '##########'],
  elevations: Array.from({ length: 10 }, () => Array(10).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'north', label: '북쪽 문', kind: 'door', x: 4, row: 0, direction: 0, width: 2, height: 3 }],
};
const project = parseProjectFile({ formatVersion: 1, map, bindings: [], settings: { ...DEFAULT_SETTINGS,
  conceptMode: 'manual', prompt: '순간이동 검증', width: 10, height: 10, connectionCount: 1, connectionWidth: 2,
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, teleports: false, teleportCount: 1 },
} });
assert.deepEqual(validateMap(project.map).filter(issue => issue.severity === 'error'), []);
const fixturePath = resolve(output, 'original.baekho.json');
await writeFile(fixturePath, JSON.stringify(project, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [], evidence = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, userData) => {
    app.setPath('userData', userData); BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1050 });
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Teleport smoke: no paid AI calls', models: [] }));
    dialog.showMessageBoxSync = () => 1;
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = name => page.locator(`[data-action="${name}"]`);
  const tool = name => page.locator(`[data-d-action="${name}"]`);
  const control = name => page.locator(`[data-d-control="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const input = async (name, value) => { await expand(); await control(name).fill(String(value)); await control(name).press('Tab'); await expand(); };
  const design = async () => { await page.locator('[data-right-tab="design"]').click(); await expand(); };
  const open = async filePath => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, filePath);
    await action('open').click();
    if (await page.locator('#discard-dialog[open]').isVisible()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
    await expand();
  };
  let saveIndex = 0;
  const save = async label => {
    const filePath = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
    await action('save').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/, label);
    const saved = parseProjectFile(JSON.parse(await readFile(filePath, 'utf8')));
    assert.deepEqual(validateMap(saved.map, saved.bindings).filter(issue => issue.severity === 'error'), []);
    return { project: saved, filePath };
  };
  const choose = async (x, row) => {
    await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate((svg, { x, row }) => {
      const p = new DOMPoint(x + .5, row + .5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
    }, { x, row });
    await page.mouse.click(point.x, point.y); await design();
  };

  await open(fixturePath);
  assert.equal(await page.locator('[data-d-feature="teleports"]').isChecked(), false);
  await page.locator('[data-d-feature="teleports"]').check(); await expand();
  assert.equal(await control('setting:teleportCount').inputValue(), '1');
  assert.equal(await control('setting:teleportCount').getAttribute('max'), '64');
  await input('setting:teleportCount', 3);
  await control('preset').selectOption('start'); await expand();
  assert.equal(await page.locator('[data-d-feature="teleports"]').isChecked(), true);
  assert.equal(await control('setting:teleportCount').inputValue(), '3');
  const configured = await save('configured'); await open(configured.filePath);
  assert.equal(await control('setting:teleportCount').inputValue(), '3');
  evidence.push('generation toggle/count/default/range, preset preservation and save/reopen');

  await choose(4, 4); await control('marker-kind').selectOption('teleport'); await expand(); await tool('add-marker').click(); await expand();
  assert.equal(await control('marker:offset.y').count(), 0, 'Teleport vertical offset is fixed to the floor');
  const initial = (await save('manual')).project;
  assert.equal(initial.map.markers.length, 1); const marker = initial.map.markers[0];
  assert.equal(marker.kind, 'teleport'); assert.deepEqual(marker.clearance, { radius: .4, height: 2 }); assert.equal(marker.offset.y, 0);
  await input('marker:x', 5);
  assert.equal((await save('moved')).project.map.markers[0].x, 5);
  await action('undo').click();
  assert.equal((await save('undo')).project.map.markers[0].x, 4);
  await action('redo').click(); await expand();
  assert.equal((await save('redo')).project.map.markers[0].x, 5);
  await tool('select-marker').click(); await expand();
  await input('marker:x', 0);
  assert.match(await page.locator('#status').innerText(), /순간이동|평지|바닥|착지/);
  assert.equal((await save('invalid-move-preserved')).project.map.markers[0].x, 5);
  await tool('select-marker').click(); await expand();
  await input('marker:label', '안전 착지 A'); await input('marker:contentKey', 'arrival_A');
  await control('marker:direction').selectOption('90'); await expand();
  await input('marker:offset.x', .2);
  const edited = (await save('metadata')).project.map.markers[0];
  assert.equal(edited.label, '안전 착지 A'); assert.equal(edited.contentKey, 'arrival_A'); assert.equal(edited.direction, 90); assert.equal(edited.offset.x, .2);
  evidence.push('manual add, clearance snapshot, edit, invalid move rollback, Undo/Redo');

  await page.locator('[data-view="3d"]').click();
  const previewKey = page.locator('[data-preview-teleport-selection]');
  assert.equal(await previewKey.getAttribute('data-preview-teleport-selection'), marker.id);
  assert.equal(await previewKey.getAttribute('data-teleport-radius'), '0.4');
  assert.match(await previewKey.innerText(), /착지 반경 0.4m/);
  await page.screenshot({ path: resolve(output, 'selected-landing.png') });
  evidence.push('dedicated teleport label, selected landing radius and preview');

  await choose(5, 4); await tool('copy').click(); await tool('rotate').click();
  await choose(7, 7); await tool('paste').click();
  const copied = (await save('rotated-copy')).project;
  assert.equal(copied.map.markers.length, 2);
  const pasted = copied.map.markers.find(item => item.id !== marker.id);
  assert.deepEqual(pasted.clearance, marker.clearance); assert.equal(pasted.direction, 180);
  const roundtrip = await save('roundtrip'); await open(roundtrip.filePath);
  assert.deepEqual((await save('reopened')).project.map.markers, copied.map.markers);
  evidence.push('copy/rotation retain clearance, marker identities and persistence');

  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, evidence, errors }, null, 2));
  console.log(`Teleport UI smoke passed (${evidence.length} scenarios): ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: false, evidence, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await app.close();
}
