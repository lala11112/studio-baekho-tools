// Actual Electron UI / native IPC / saved projects and ZIP regression. AI calls are intentionally stubbed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const output = resolve('.local/v5-smoke'), userData = resolve(output, `userdata-${Date.now()}`);
await mkdir(userData, { recursive: true });
const fixture = resolve(output, 'TestUnity');
await mkdir(resolve(fixture, 'Assets/Modules'), { recursive: true });
await mkdir(resolve(fixture, 'ProjectSettings'), { recursive: true });
const sources = ['floor', 'wall', 'door', 'ceiling', 'cliff', 'deadzone', 'table', 'crate', 'unmeasured'];
const guid = index => (index + 1).toString(16).padStart(32, '0');
for (const [index, name] of sources.entries()) {
  await writeFile(resolve(fixture, `Assets/Modules/${name}.prefab`), '%YAML 1.1\n');
  await writeFile(resolve(fixture, `Assets/Modules/${name}.prefab.meta`), `fileFormatVersion: 2\nguid: ${guid(index)}\n`);
}
const map = { version: 4, name: 'V5 실제 UI 검증', width: 12, height: 12, cellSize: 2, maxStepHeight: .4,
  rows: ['#####D######', ...Array(10).fill('#..........#'), '############'], elevations: Array.from({ length: 12 }, () => Array(12).fill(2)),
  ramps: [], connections: [{ id: 'north', label: '북쪽 문', x: 5, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [], lockedCells: [{ x: 3, row: 3 }],
};
map.rows[4] = '#...__.....#';
map.ceilings = map.rows.flatMap((row, z) => [...row].flatMap((tile, x) => '.D'.includes(tile) && !(x === 5 && z === 5) ? [{ x, row: z, undersideY: 9 }] : []));
map.wallHeights = map.rows.flatMap((row, z) => [...row].flatMap((tile, x) => tile === '#' ? [{ x, row: z, height: 7 }] : []));
const initial = parseProjectFile({ formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS, width: 12, height: 12, connectionCount: 1,
  designer: { ...DEFAULT_DESIGNER, elevation: false, ceilings: true, props: true } },
  bindings: sources.map((name, index) => ({ id: name, label: name, role: ['table', 'crate', 'unmeasured'].includes(name) ? 'prop' : name,
    prefabGuid: guid(index), prefabPath: `Assets/Modules/${name}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 })) });
assert.deepEqual(validateMap(initial.map).filter(issue => issue.severity === 'error'), []);
const initialPath = resolve(output, 'legacy.baekho.json'); await writeFile(initialPath, JSON.stringify(initial));
const catalogPath = resolve(output, 'catalog.json');
await writeFile(catalogPath, JSON.stringify({ version: 1, assets: [{ guid: guid(6), size: { x: 3, y: 1, z: 3 } }, { guid: guid(7), size: { x: 1, y: 1, z: 1 } }] }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = []; let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no AI calls', models: [] }));
    dialog.showMessageBoxSync = () => 1;
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const idle = async () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expandAll = async () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const action = name => page.locator(`[data-d-action="${name}"]`);
  const control = name => page.locator(`[data-d-control="${name}"]`);
  const design = async () => { await page.locator('[data-right-tab="design"]').click(); await expandAll(); };
  const fill = async (selector, value) => { await expandAll(); const input = page.locator(selector); await input.fill(String(value)); await input.press('Tab'); await expandAll(); };
  const open = async path => {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path);
    await page.locator('[data-action="open"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
  };
  let saveIndex = 0;
  const save = async label => {
    const path = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, path);
    await page.locator('[data-action="save"]').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return { path, project: JSON.parse(await readFile(path, 'utf8')) };
  };
  const choose = async (x, row) => {
    await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate((svg, c) => { const p = new DOMPoint(c.x + .5, c.row + .5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y }; }, { x, row });
    await page.mouse.click(point.x, point.y); await expandAll();
  };
  await open(initialPath);
  let saved = await save('legacy-open');
  assert.deepEqual(saved.project.map.ceilings, initial.map.ceilings); check(saved.project.map.version === 4, 'legacy opening does not migrate absolute roof');

  console.log('v5 UI: presets and generation dimensions do not alter the current map');
  await page.locator('[data-generation-control="preset"]').selectOption('small');
  saved = await save('small-preset'); assert.deepEqual(saved.project.map, initial.map);
  check(saved.project.settings.roomPreset === 'small' && saved.project.settings.sizeMode === 'preset', 'preset is persisted');
  await fill('#width', 20); await fill('#cellSize', 3);
  saved = await save('custom-generation'); check(saved.project.settings.sizeMode === 'custom' && saved.project.settings.width === 20 && saved.project.settings.cellSize === 3, 'custom generation dimensions persisted');
  assert.deepEqual(saved.project.map, initial.map); await open(initialPath);

  console.log('v5 UI: structural repair, explicit roof adoption and highest-floor edit with Undo/Redo');
  await design(); await action('fill-structures').click();
  saved = await save('repair'); assert.deepEqual(saved.project.map.ceilings, initial.map.ceilings);
  check(saved.project.map.pitBottoms.length === 2 && saved.project.map.pitBottoms.every(b => b.kind === 'deadzone' && b.y === -2), 'both connected pit cells receive common lower deadzone');
  check(saved.project.map.structureFills.some(f => f.purpose === 'doorTop'), 'door top is closed');
  await design(); await action('adopt-auto-ceiling').click(); saved = await save('adopt');
  check(saved.project.map.ceilings.filter(c => c.heightMode === 'auto').every(c => c.undersideY === 6), 'auto ceilings align highest floor +4');
  check(saved.project.map.ceilings.find(c => c.x === 3 && c.row === 3).undersideY === 9, 'locked roof remains absolute');
  check(!saved.project.map.ceilings.some(c => c.x === 5 && c.row === 5), 'manual roof opening is preserved');
  await choose(8, 8); await fill('#selectedHeight', 6); saved = await save('raised');
  check(saved.project.map.ceilings.filter(c => c.heightMode === 'auto').every(c => c.undersideY === 10), 'highest-floor editing updates auto ceilings');
  await page.locator('[data-action="undo"]').click(); check((await save('undo')).project.map.ceilings.filter(c => c.heightMode === 'auto').every(c => c.undersideY === 6), 'Undo restores whole roof');
  await page.locator('[data-action="redo"]').click(); saved = await save('redo');
  check(saved.project.map.ceilings.filter(c => c.heightMode === 'auto').every(c => c.undersideY === 10), 'Redo restores highest roof');
  await open(saved.path); assert.deepEqual((await save('roof-roundtrip')).project, saved.project);
  await choose(8, 8); await fill('#selectedHeight', 2);
  await fill('[data-d-control="ceiling-y"]', 8); saved = await save('manual-cell');
  check(saved.project.map.ceilings.find(c => c.x === 8 && c.row === 8).heightMode === 'manual', 'direct cell Y becomes manual');
  await control('ceiling-mode').selectOption('auto');
  await choose(4, 4); await control('pit-kind').selectOption('floor'); await fill('[data-d-control="pit-y"]', -3); await fill('[data-d-control="pit-thickness"]', .5);
  saved = await save('pit-floor'); check(saved.project.map.pitBottoms.every(b => b.kind === 'floor' && b.y === -3 && b.thickness === .5), 'one pit control updates the connected closure');
  await control('pit-kind').selectOption('deadzone'); await fill('[data-d-control="pit-thickness"]', 1);
  await choose(6, 6); await fill('#currentCellSize', 2.25); saved = await save('current-cellsize');
  check(saved.project.map.cellSize === 2.25 && saved.project.settings.cellSize === 2, 'current-map cell spacing does not rewrite next-generation spacing');
  await page.locator('[data-action="undo"]').click();

  console.log('v5 UI: native bounds import, multi-cell props, replacement and whole-object editing');
  await page.locator('[data-right-tab="assets"]').click();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, fixture);
  await page.locator('[data-action="scan"]').click(); await idle();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, catalogPath);
  await page.locator('[data-action="import-prop-catalog"]').click(); await idle();
  saved = await save('catalog'); check(saved.project.bindings.find(b => b.id === 'table').prop.size.x === 3, 'native catalog dimensions imported');
  check(!saved.project.bindings.find(b => b.id === 'unmeasured').prop?.size, 'unmeasured source stays unmeasured');
  await choose(7, 7); await page.locator('[data-insert-prop]').selectOption('table'); saved = await save('table');
  let prop = saved.project.map.propInstances[0]; check(prop.bindingId === 'table' && prop.cells.length === 4, '3m table occupies four 2m cells as one instance');
  await choose(8, 8); check(await page.locator('[data-prop-instance-binding]').getAttribute('data-prop-instance-binding') === prop.id, 'member cell selects the same prop instance');
  await page.locator('[data-prop-instance-binding]').selectOption('crate'); saved = await save('crate');
  check(saved.project.map.propInstances[0].id === prop.id && saved.project.map.propInstances[0].cells.length === 1, 'replacement preserves stable identity and releases old cells');
  check(saved.project.map.rows[8][8] === '.', 'released occupancy returns to floor');
  await choose(7, 7); await page.locator('[data-prop-instance-binding]').selectOption('table');
  await design(); await action('copy').click(); assert.match(await page.locator('#status').innerText(), /소품.*일부/);
  await fill('[data-d-control="area-width"]', 2); await fill('[data-d-control="area-height"]', 2); await action('copy').click();
  await choose(2, 7); await design(); await action('paste').click(); saved = await save('whole-prop-copy');
  check(saved.project.map.propInstances.length === 2 && new Set(saved.project.map.propInstances.map(p => p.id)).size === 2, 'whole prop copy yields distinct complete instances');
  check(saved.project.map.propInstances.every(p => p.cells.length === 4), 'no prop is split');
  const roundtrip = saved; await open(roundtrip.path); assert.deepEqual((await save('final-roundtrip')).project, roundtrip.project);

  console.log('v5 UI: design report overlays, visible lower structures, native v5 bundle');
  await design(); await action('view-design').first().click(); await action('view-deadzone').click();
  check(await page.locator('[data-d-action="view-design"]').first().getAttribute('aria-pressed') === 'true', 'design overlay enabled');
  await page.locator('[data-view="3d"]').click(); await page.locator('#preview canvas').waitFor();
  await page.screenshot({ path: resolve(output, 'v5-structures-props-analysis.png') });
  await action('view-ceiling').click(); await page.screenshot({ path: resolve(output, 'v5-auto-ceiling.png') });
  await choose(7, 7); await page.screenshot({ path: resolve(output, 'v5-measured-prop-inspector.png') });
  await page.locator('[data-right-tab="assets"]').click();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, fixture);
  await page.locator('[data-action="scan"]').click(); await idle();
  const zipPath = resolve(output, 'v5-native-export.zip');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, zipPath);
  check(await page.locator('[data-action="export"]').isEnabled(), await page.locator('#status').innerText());
  await page.locator('[data-action="export"]').click(); await idle(); assert.match(await page.locator('#status').innerText(), /내보내기 완료/);
  const zip = unzipSync(await readFile(zipPath)), manifest = JSON.parse(strFromU8(zip['Map.baekhomap.json']));
  check(manifest.schemaVersion === 5 && manifest.placements.some(p => p.role === 'deadzone' && p.fitSize), 'native export contains v5 deadzone fitting');
  check(manifest.placements.filter(p => p.id.startsWith('prop-instance-')).length === 2 || manifest.placements.filter(p => p.role === 'prop').length === 2, 'one prefab per measured prop instance');
  check(Boolean(zip['Unity/Editor/BaekhoPropCatalog.cs']), 'bounds exporter is included in native ZIP');
  assert.deepEqual(validateMap(roundtrip.project.map).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(errors, []); console.log(`PASS Electron v5: ${assertions} checks; zero renderer errors; ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
