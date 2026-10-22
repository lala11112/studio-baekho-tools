// Real Electron workflow: review temporary wall layouts, persist them, then replace a selected item.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER, applyGeneratedFeatures } = await tsImport('../src/shared/features.ts', import.meta.url);
const { placeholderWallBinding } = await tsImport('../src/shared/wall-placeholders.ts', import.meta.url);
const output = resolve('.local/wall-placeholders-smoke'), userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 10, conceptMode: 'manual', connectionCount: 1, connectionHeight: 2.5, seed: 417, prompt: 'Temporary wall layout regression',
  designer: { ...DEFAULT_DESIGNER, elevation: false, lights: false, props: false, decorations: false, wallHeight: 4, wallMounts: { enabled: true, singles: true, runs: true, density: 30, runDensity: 40 } } };
const source = { version: 5, name: '임시 벽 부착물 테스트', width: 12, height: 10, cellSize: 2, rows: ['######D#####', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], maxStepHeight: .4, assetOverrides: [], connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 2.5, kind: 'door' }], structureSettings: { ceilingClearance: 4, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 4 } };
const input = resolve(output, 'unregistered.baekho.json'); await writeFile(input, JSON.stringify({ formatVersion: 1, map: source, settings, bindings: [] }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, folder) => { app.setPath('userData', folder); dialog.showMessageBoxSync = () => 1; ipcMain.removeHandler('baekho:codex-status'); ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] })); }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const expand = () => page.locator('details').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
  const control = name => page.locator(`[data-d-control="${name}"]`).last();
  const action = name => page.locator(`[data-d-action="${name}"]`).last().click();
  const save = async name => { const path = resolve(output, `${name}.baekho.json`); await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path); await page.locator('[data-action="save"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료')); return { path, project: JSON.parse(await readFile(path, 'utf8')) }; };
  const open = async path => { await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, path); await page.locator('[data-action="open"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다')); await page.locator('[data-right-tab="design"]').click(); await expand(); };
  await open(input);
  assert.equal(await control('wall-setting:placeholderFallback').isChecked(), true, 'missing fallback settings default on');
  assert.match(await page.locator('[data-wall-readiness]').last().innerText(), /벽용 등록 0개.*프리팹 없이도 배치 확인 가능/s);
  await action('place-wall-mounts'); await expand();
  const placed = await save('placed'), walls = placed.project.map.fixtures.filter(fixture => fixture.wall);
  assert.ok(walls.length > 0); assert.ok(walls.every(fixture => fixture.wall.placeholder && !fixture.bindingId)); assert.deepEqual(placed.project.bindings, []);
  assert.match(await page.locator('[data-wall-placement-result]').last().innerText(), new RegExp(`추가한 임시 부착물 ${walls.length}개 · 실제 프리팹 0개`));
  const light = walls.find(fixture => fixture.wall.placeholder === 'wallLight'); assert.ok(light, 'temporary wall light exists');
  const select = async fixture => { await page.locator(`[data-d-action="select-fixture"][data-id="${fixture.id}"]`).click(); await expand(); await page.locator(`[data-wall-fixture-editor="${fixture.id}"]`).scrollIntoViewIfNeeded(); };
  await select(light);
  assert.match(await page.locator(`[data-preview-wall-selection="${light.id}"]`).innerText(), /임시 벽 조명.*배치 확인용 형상/s);
  assert.equal(await control('wall-edit:bindingId').inputValue(), '');
  assert.match(await control('wall-edit:bindingId').innerText(), /임시 유지 · 실제 프리팹 선택/);
  await page.screenshot({ path: resolve(output, 'temporary-wall-preview.png') });
  await control('wall-edit:height').fill('-.1'); await control('wall-edit:height').press('Tab'); await expand();
  const moved = await save('moved'); assert.ok(Math.abs(moved.project.map.fixtures.find(item => item.id === light.id).wall.position.y - light.wall.position.y + .1) < 1e-6);
  await page.locator('[data-action="undo"]').click(); await expand(); const undone = await save('move-undone'); assert.deepEqual(undone.project.map.fixtures, placed.project.map.fixtures);
  await open(placed.path); const reopened = await save('reopened'); assert.deepEqual(reopened.project.map.fixtures, placed.project.map.fixtures); assert.deepEqual(reopened.project.bindings, []);
  // Simulates registering a real, measured prefab after the layout has already been saved.
  const real = placeholderWallBinding('wallLight'); real.id = 'real_wall_light'; real.label = '실제 벽등'; real.prefabGuid = '9'.repeat(32); real.prefabPath = 'Assets/WallLight.prefab';
  const withBinding = resolve(output, 'registered-later.baekho.json'); await writeFile(withBinding, JSON.stringify({ ...reopened.project, bindings: [real] }));
  await open(withBinding); await select(light); assert.equal(await control('wall-edit:bindingId').inputValue(), '');
  await control('wall-edit:bindingId').selectOption(real.id); await expand();
  const replaced = await save('replaced'), realFixture = replaced.project.map.fixtures.find(item => item.id === light.id);
  assert.equal(realFixture.bindingId, real.id); assert.equal(realFixture.wall.placeholder, undefined); assert.deepEqual(realFixture.wall.position, light.wall.position);
  assert.match(await page.locator(`[data-preview-wall-selection="${light.id}"]`).innerText(), /실제 벽등/);
  await page.locator('[data-action="undo"]').click(); await expand(); const restore = await save('replacement-undone');
  assert.equal(restore.project.map.fixtures.find(item => item.id === light.id).wall.placeholder, 'wallLight'); assert.equal(restore.project.map.fixtures.find(item => item.id === light.id).bindingId, undefined);
  // Mock only paid IPC. The actual generator uses the empty catalog for both on/off conditions.
  const offSettings = structuredClone(settings); offSettings.designer.wallMounts.placeholderFallback = false;
  const onMap = applyGeneratedFeatures(source, settings, undefined, []), offMap = applyGeneratedFeatures(source, offSettings, undefined, []);
  await app.evaluate(({ ipcMain }, payload) => {
    ipcMain.removeHandler('baekho:generate-image'); ipcMain.removeHandler('baekho:extract-layout');
    ipcMain.handle('baekho:generate-image', () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwAAAAABJRU5ErkJggg==');
    ipcMain.handle('baekho:extract-layout', (_event, currentSettings, _image, _region, catalog) => { globalThis.__wallPlaceholderCatalog = catalog; return currentSettings.designer.wallMounts.placeholderFallback === false ? payload.off : payload.on; });
  }, { on: onMap, off: offMap });
  await open(input); await page.locator('[data-action="generate"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('맵을 생성했습니다')); await expand();
  const generated = await save('generated'); assert.ok(generated.project.map.fixtures.some(fixture => fixture.wall?.placeholder)); assert.deepEqual(generated.project.bindings, []);
  assert.deepEqual(await app.evaluate(() => globalThis.__wallPlaceholderCatalog), []);
  const offInput = resolve(output, 'fallback-off.baekho.json'); await writeFile(offInput, JSON.stringify({ formatVersion: 1, map: source, settings: offSettings, bindings: [] }));
  await open(offInput); assert.equal(await control('wall-setting:placeholderFallback').isChecked(), false);
  await page.locator('[data-action="generate"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('맵을 생성했습니다')); const disabled = await save('disabled'); assert.equal((disabled.project.map.fixtures ?? []).filter(fixture => fixture.wall).length, 0);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ success: true, temporaryFixtures: walls.length, replacement: real.id, output }));
} finally { await app.close(); }
