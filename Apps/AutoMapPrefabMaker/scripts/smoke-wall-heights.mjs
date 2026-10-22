// Actual Electron controls: generated pipe heights, vertical ranges, and transactional reapplication.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const output = resolve('.local/wall-heights-smoke'), userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 10, conceptMode: 'manual', connectionCount: 1, seed: 417,
  prompt: 'Generated wall pipe height regression', designer: { ...DEFAULT_DESIGNER, elevation: false, lights: false, props: false,
    decorations: false, wallHeight: 6, wallMounts: { enabled: true, singles: true, runs: true, density: 30, runDensity: 40, connectRuns: false } } };
const source = { version: 5, name: '배관 높이 설정 검증', width: 12, height: 10, cellSize: 2,
  rows: ['######D#####', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)),
  ramps: [], maxStepHeight: .4, assetOverrides: [], connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 2.5, kind: 'door' }],
  structureSettings: { ceilingClearance: 6, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 6 } };
const input = resolve(output, 'legacy.baekho.json');
await writeFile(input, JSON.stringify({ formatVersion: 1, map: source, settings, bindings: [] }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, folder) => {
    app.setPath('userData', folder); dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const expand = () => page.locator('details').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
  const control = field => page.locator(`[data-d-control="wall-setting:${field}"]`).last();
  const choose = async (field, value) => { await control(field).selectOption(value); await expand(); };
  const number = async (field, value) => { await control(field).fill(String(value)); await control(field).dispatchEvent('change'); await expand(); };
  const action = async name => { await page.locator(`[data-d-action="${name}"]`).last().click(); await expand(); };
  const open = async path => {
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, path);
    await page.locator('[data-action="open"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
    await page.locator('[data-right-tab="design"]').click(); await expand();
  };
  const save = async name => {
    const path = resolve(output, `${name}.baekho.json`);
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path);
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료'));
    return { path, project: JSON.parse(await readFile(path, 'utf8')) };
  };
  const runs = project => project.map.fixtures.filter(fixture => fixture.wall?.runId);
  const singles = project => project.map.fixtures.filter(fixture => fixture.wall && !fixture.wall.runId);
  const assertHorizontalHeight = (project, expected) => {
    const pipes = runs(project); assert.ok(pipes.length > 0, 'generated horizontal run is nonempty');
    assert.ok(pipes.every(fixture => fixture.wall.sockets.every(socket => Math.abs(socket.position.y - expected) < 1e-6)), `all connected pipe sockets share Y ${expected}`);
  };
  await open(input);
  assert.equal(await control('runHeightMode').inputValue(), 'asset', 'older settings keep the asset height');
  assert.equal(await control('verticalRangeMode').inputValue(), 'full', 'older settings keep the full wall range');
  await choose('runHeightMode', 'fixed'); await choose('runHeightReference', 'floor'); await number('runHeightValue', 1.25);
  await action('place-wall-mounts');
  const low = await save('fixed-low'); assertHorizontalHeight(low.project, 1.25); assert.ok(singles(low.project).length > 0);
  assert.deepEqual(low.project.settings.designer.wallMounts.runHeight, { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 });
  await number('runHeightValue', 2.75);
  const settingsOnly = await save('settings-only'); assert.deepEqual(settingsOnly.project.map.fixtures, low.project.map.fixtures, 'editing a height setting leaves existing geometry intact');
  await action('reapply-wall-runs');
  await page.locator('[data-wall-reapply-result]').last().waitFor();
  const blocked = await save('blocked-height');
  assert.deepEqual(blocked.project.map.fixtures, low.project.map.fixtures, 'occupied panel height rejects new runs and preserves the complete previous layout');
  assert.match(await page.locator('[data-wall-reapply-result]').last().innerText(), /배관 재배치 변경 없음/);
  assert.match(await page.locator('[data-wall-reapply-result]').last().innerText(), /새 높이에서 유효한 배관 구간을 완성할 수 없어/);
  await number('runHeightValue', 3.5); await action('reapply-wall-runs');
  const high = await save('fixed-high'); assertHorizontalHeight(high.project, 3.5);
  assert.deepEqual(singles(high.project), singles(low.project), 'reapplication preserves individual wall fixtures');
  await page.locator('[data-action="undo"]').click(); await expand();
  const undone = await save('undo'); assert.deepEqual(undone.project.map.fixtures, low.project.map.fixtures, 'one Undo restores all prior generated pipe geometry');
  await page.locator('[data-action="redo"]').click(); await expand();
  const redone = await save('redo'); assert.deepEqual(redone.project.map.fixtures, high.project.map.fixtures, 'one Redo restores all reapplied geometry');
  await open(redone.path);
  assert.equal(await control('runHeightMode').inputValue(), 'fixed'); assert.equal(await control('runHeightValue').inputValue(), '3.5');
  const reopened = await save('reopened'); assert.deepEqual(reopened.project.map.fixtures, high.project.map.fixtures);
  await control('runHeightMode').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'fixed-height.png') });

  await open(input); await choose('runHeightMode', 'fixed'); await choose('runHeightReference', 'top'); await number('runHeightValue', .75);
  await action('place-wall-mounts'); const top = await save('from-top'); assertHorizontalHeight(top.project, 5.25);
  await open(input); await choose('runHeightMode', 'random'); await choose('runHeightReference', 'floor');
  await number('runHeightMin', 1); await number('runHeightMax', 3); await action('place-wall-mounts');
  const random = await save('random-height'); assert.ok(runs(random.project).length > 0);
  assert.ok(runs(random.project).every(fixture => fixture.wall.sockets.every(socket => socket.position.y >= 1 - 1e-6 && socket.position.y <= 3 + 1e-6)), 'random run sockets stay within the chosen floor range');
  assert.deepEqual(random.project.settings.designer.wallMounts.runHeight, { mode: 'random', reference: 'floor', min: 1, max: 3 });

  await open(input); await choose('runOrientation', 'vertical'); await choose('verticalRangeMode', 'custom');
  await choose('verticalRangeReference', 'floor'); await number('verticalRangeStart', .5); await number('verticalRangeEnd', 2.5);
  await action('place-wall-mounts');
  const vertical = await save('vertical-range'), verticalRuns = runs(vertical.project); assert.ok(verticalRuns.length > 0);
  assert.ok(verticalRuns.every(fixture => fixture.wall.bounds.every(bounds => bounds.center.y - bounds.size.y / 2 >= .5 - 1e-6 && bounds.center.y + bounds.size.y / 2 <= 2.5 + 1e-6)), 'the complete vertical kit including end caps fits the chosen range');
  assert.deepEqual(vertical.project.settings.designer.wallMounts.verticalRange, { reference: 'floor', start: .5, end: 2.5 });
  await open(vertical.path); assert.equal(await control('verticalRangeMode').inputValue(), 'custom'); assert.equal(await control('verticalRangeEnd').inputValue(), '2.5');
  await control('verticalRangeMode').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'vertical-range.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, horizontal: runs(high.project).length, random: runs(random.project).length, vertical: verticalRuns.length, output }));
} finally { await app.close(); }
