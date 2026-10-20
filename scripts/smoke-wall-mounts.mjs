// Real desktop registration, additive placement, independent selection and Undo/Redo. No AI calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER, applyGeneratedFeatures } = await tsImport('../src/shared/features.ts', import.meta.url);
const { defaultWallMount } = await tsImport('../src/shared/wall-mounts.ts', import.meta.url);
const output = resolve('.local/wall-mounts-smoke'), userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const measured = (id, label, role = 'light') => {
  const binding = { id, label, role, prefabGuid: (id === 'wall_light' ? '1' : '2').repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 }, bounds: { center: { x: 0, y: 0, z: .15 }, size: { x: .7, y: .3, z: .3 } } };
  binding.wallMount = { ...defaultWallMount(binding), sites: [id === 'door_light' ? 'doorTop' : 'wall'], heightMode: id === 'door_light' ? 'top' : 'center', height: id === 'door_light' ? .4 : 0, spacing: 2, probability: 100 };
  return binding;
};
const bindings = [measured('wall_light', '벽 조명'), measured('door_light', '문 위 조명')];
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 10, conceptMode: 'manual', connectionCount: 1, seed: 417, prompt: 'Wall fixture desktop regression', designer: { ...DEFAULT_DESIGNER, elevation: false, lights: false, props: false, decorations: false, wallHeight: 4, wallMounts: { enabled: true, singles: true, runs: false, density: 20, runDensity: 40 } } };
const source = { version: 5, name: '벽 부착물 테스트', width: 12, height: 10, cellSize: 2, rows: ['######D#####', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], maxStepHeight: .4, assetOverrides: [], connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 2.5, kind: 'door' }], structureSettings: { ceilingClearance: 4, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 4 } };
const input = resolve(output, 'input.baekho.json'); await writeFile(input, JSON.stringify({ formatVersion: 1, map: source, settings, bindings }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, folder) => { app.setPath('userData', folder); dialog.showMessageBoxSync = () => 1; ipcMain.removeHandler('baekho:codex-status'); ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] })); }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const expand = () => page.locator('details').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
  const control = name => page.locator(`[data-d-control="${name}"]`).last();
  const action = name => page.locator(`[data-d-action="${name}"]`).click();
  const save = async name => { const path = resolve(output, `${name}.baekho.json`); await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path); await page.locator('[data-action="save"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료')); return JSON.parse(await readFile(path, 'utf8')); };
  const choose = async (x, row) => { await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click(); const point = await page.locator('#map-svg').evaluate((svg, cell) => { const point = new DOMPoint(cell.x + .5, cell.row + .5).matrixTransform(svg.getScreenCTM()); return { x: point.x, y: point.y }; }, { x, row }); await page.mouse.click(point.x, point.y); await page.locator('[data-view="3d"]').click(); await page.locator('[data-right-tab="design"]').click(); await expand(); };
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, input);
  await page.locator('[data-action="open"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다')); await expand();
  await page.locator('[data-right-tab="assets"]').click(); await expand();
  assert.equal(await page.locator('[data-wall-binding="door_light"][data-wall-field="kind"]').inputValue(), 'single');
  assert.equal(await page.locator('[data-wall-binding="door_light"][data-wall-field="sites.doorTop"]').isChecked(), true);
  await page.locator('[data-wall-binding="door_light"][data-wall-field="probability"]').fill('100'); await page.locator('[data-wall-binding="door_light"][data-wall-field="probability"]').press('Tab'); await expand();
  await choose(0, 3); await control('wall-binding').selectOption('wall_light'); await expand(); await action('insert-wall-fixture'); await expand();
  const manual = await save('manual'); assert.equal(manual.map.fixtures.filter(fixture => fixture.wall).length, 1); assert.equal(manual.map.fixtures[0].wall.authored, true);
  await page.locator('[data-right-tab="assets"]').click(); await expand(); await action('place-wall-mounts'); await expand();
  assert.match(await page.locator('[data-wall-placement-result]').innerText(), /개별 부착물/);
  const placed = await save('placed'), mounts = placed.map.fixtures.filter(fixture => fixture.wall);
  assert.ok(mounts.length > 1); assert.ok(mounts.some(fixture => fixture.wall.doorId === 'entry'));
  assert.deepEqual(placed.map.rows, source.rows); assert.deepEqual(placed.map.elevations, source.elevations); assert.deepEqual(placed.map.connections, source.connections);
  await page.locator('[data-wall-binding="wall_light"][data-wall-field="enabled"]').evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); }); await expand();
  assert.equal(await page.locator('[data-wall-binding="wall_light"][data-wall-field="enabled"]').isChecked(), true, 'used mount geometry cannot be disabled silently');
  const preserved = await save('preserved-binding'); assert.deepEqual(preserved.map.fixtures, placed.map.fixtures); assert.ok(preserved.bindings.find(binding => binding.id === 'wall_light').wallMount);
  const fixture = mounts.find(fixture => fixture.wall.doorId === 'entry');
  await page.locator('[data-right-tab="design"]').click(); await expand(); await page.locator(`[data-d-action="select-fixture"][data-id="${fixture.id}"]`).click(); await expand();
  assert.equal(await page.locator(`[data-preview-wall-selection="${fixture.id}"]`).count(), 1);
  assert.equal(await page.locator('[data-d-control="fixture:anchor"]').count(), 0);
  await page.locator(`[data-wall-fixture-editor="${fixture.id}"]`).scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'wall-fixture-editor.png') });
  await control('wall-edit:height').fill('-.1'); await control('wall-edit:height').press('Tab'); await expand();
  const edited = await save('edited'), updated = edited.map.fixtures.find(item => item.id === fixture.id); assert.ok(Math.abs(updated.wall.position.y - fixture.wall.position.y + .1) < 1e-6); assert.equal(updated.wall.authored, true); assert.equal(await control('wall-edit:height').inputValue(), '0');
  await page.locator('[data-action="undo"]').click(); await expand(); const undo = await save('undo'); assert.equal(undo.map.fixtures.find(item => item.id === fixture.id).wall.position.y, fixture.wall.position.y);
  await action('delete-wall-fixture'); await expand(); const deleted = await save('deleted'); assert.equal(deleted.map.fixtures.some(item => item.id === fixture.id), false);
  await page.locator('[data-action="undo"]').click(); await expand(); await action('place-wall-mounts'); await expand(); const repeated = await save('repeated'); assert.equal(repeated.map.fixtures.filter(item => item.wall).length, mounts.length);
  await page.screenshot({ path: resolve(output, 'wall-mounts.png') });
  // Both cell edits and paint strokes must roll back if a mounted fixture loses its support.
  const supported = mounts.find(item => !item.wall.doorId), support = supported.wall.support[0];
  await choose(support.x, support.row); await page.locator('[data-right-tab="cell"]').click(); await expand();
  await page.locator('#selectedTile').selectOption('.'); await expand();
  const cellRejected = await save('cell-support-rejected'); assert.deepEqual(cellRejected.map.rows, placed.map.rows); assert.deepEqual(cellRejected.map.fixtures, placed.map.fixtures);
  await page.locator('[data-view="grid"]').click(); await page.locator('[data-brush="."]').click();
  const supportPoint = await page.locator('#map-svg').evaluate((svg, cell) => { const point = new DOMPoint(cell.x + .5, cell.row + .5).matrixTransform(svg.getScreenCTM()); return { x: point.x, y: point.y }; }, support);
  await page.mouse.click(supportPoint.x, supportPoint.y); await expand(); const paintRejected = await save('paint-support-rejected'); assert.deepEqual(paintRejected.map.rows, placed.map.rows); assert.deepEqual(paintRejected.map.fixtures, placed.map.fixtures);
  // Mock only the paid IPC operations: assert the real renderer carries mounted assets into extraction.
  const generated = applyGeneratedFeatures({ ...source, connections: source.connections.map(door => ({ ...door, height: settings.connectionHeight })) }, settings, undefined, bindings);
  await app.evaluate(({ ipcMain }, map) => {
    ipcMain.removeHandler('baekho:generate-image'); ipcMain.removeHandler('baekho:extract-layout');
    ipcMain.handle('baekho:generate-image', () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwAAAAABJRU5ErkJggg==');
    ipcMain.handle('baekho:extract-layout', (_event, _settings, _image, _region, catalog) => { globalThis.__wallSmokeCatalog = catalog; return map; });
  }, generated);
  await page.locator('[data-action="generate"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('맵을 생성했습니다'));
  const extractionCatalog = await app.evaluate(() => globalThis.__wallSmokeCatalog);
  assert.ok(extractionCatalog.some(binding => binding.id === 'wall_light' && binding.wallMount)); assert.ok(extractionCatalog.some(binding => binding.id === 'door_light' && binding.wallMount));
  const generationResult = await save('generated'); assert.ok(generationResult.map.fixtures.some(fixture => fixture.wall));
  assert.match(await page.locator('[data-wall-generation-result]').innerText(), /벽 부착물 \d+개/);
  // Legacy projects keep their off setting, but an empty wall result must explain it.
  const legacySettings = structuredClone(settings); delete legacySettings.designer.wallMounts;
  const legacyInput = resolve(output, 'legacy-off.baekho.json');
  await writeFile(legacyInput, JSON.stringify({ formatVersion: 1, map: source, settings: legacySettings, bindings }));
  await app.evaluate(({ dialog, ipcMain }, payload) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [payload.input] });
    ipcMain.removeHandler('baekho:extract-layout'); ipcMain.handle('baekho:extract-layout', () => payload.map);
  }, { input: legacyInput, map: applyGeneratedFeatures({ ...source, connections: source.connections.map(door => ({ ...door, height: settings.connectionHeight })) }, legacySettings, undefined, bindings) });
  await page.locator('[data-action="open"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다')); await expand();
  assert.match(await page.locator('[data-wall-readiness]').first().innerText(), /등록 2개.*크기 확인 2개.*꺼짐/s);
  await page.locator('[data-action="generate"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('맵을 생성했습니다'));
  assert.match(await page.locator('[data-wall-generation-result]').innerText(), /벽 부착물 0개.*꺼져/s);
  assert.match(await page.locator('#status').innerText(), /벽 부착물 0개/);
  const unchangedSetting = await save('legacy-warning'); assert.equal(unchangedSetting.settings.designer.wallMounts, undefined);
  await page.screenshot({ path: resolve(output, 'wall-empty-result.png') });
  assert.deepEqual(errors, []); console.log(JSON.stringify({ success: true, fixtures: mounts.length, output }));
} finally { await app.close(); }
