// Actual Electron controls: horizontal/vertical pipe review and transactional same-kind replacement.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { placeholderWallBinding } = await tsImport('../src/shared/wall-placeholders.ts', import.meta.url);
const output = resolve('.local/wall-bulk-vertical-smoke'), userData = resolve(output, `user-${Date.now()}`); await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 10, conceptMode: 'manual', connectionCount: 1, connectionHeight: 2.5, seed: 417, prompt: 'Vertical pipes and bulk replacement regression',
  designer: { ...DEFAULT_DESIGNER, elevation: false, lights: false, props: false, decorations: false, wallHeight: 6, wallMounts: { enabled: true, singles: false, runs: true, density: 30, runDensity: 40, connectRuns: false } } };
const source = { version: 5, name: '가로·세로 배관 일괄 교체', width: 12, height: 10, cellSize: 2, rows: ['######D#####', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], maxStepHeight: .4, assetOverrides: [], connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 2.5, kind: 'door' }], structureSettings: { ceilingClearance: 6, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 6 } };
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
  const select = async fixture => { await page.locator(`[data-d-action="select-fixture"][data-id="${fixture.id}"]`).click(); await expand(); await page.locator(`[data-wall-fixture-editor="${fixture.id}"]`).scrollIntoViewIfNeeded(); };
  await open(input); assert.equal(await control('wall-setting:runOrientation').inputValue(), 'horizontal', 'older projects default to horizontal');
  await control('wall-setting:runOrientation').selectOption('both'); await expand(); await action('place-wall-mounts'); await expand();
  const placed = await save('both'), walls = placed.project.map.fixtures.filter(fixture => fixture.wall), straight = walls.filter(fixture => fixture.wall.placeholder === 'pipeStraight');
  const horizontal = straight.filter(fixture => !fixture.wall.rotationZ), vertical = straight.filter(fixture => fixture.wall.rotationZ);
  assert.ok(horizontal.length > 0, 'horizontal pipes are visible in combined mode'); assert.ok(vertical.length > 0, 'vertical pipes are visible in combined mode');
  assert.equal(placed.project.settings.designer.wallMounts.runOrientation, 'both'); assert.ok(walls.every(fixture => fixture.wall.placeholder && !fixture.bindingId));
  await select(vertical[0]); assert.match(await page.locator(`[data-preview-wall-selection="${vertical[0].id}"]`).innerText(), /세로 부품/);
  await page.screenshot({ path: resolve(output, 'both-orientations.png') });
  await open(placed.path); assert.equal(await control('wall-setting:runOrientation').inputValue(), 'both');
  const reopened = await save('reopened'); assert.deepEqual(reopened.project.map.fixtures, placed.project.map.fixtures);
  const real = placeholderWallBinding('pipeStraight'); real.id = 'actual_pipe'; real.label = '실제 1m 배관'; real.prefabGuid = '7'.repeat(32); real.prefabPath = 'Assets/Pipe.prefab'; real.wallMount.family = 'actual-pipes';
  const wrong = structuredClone(real); wrong.id = 'mismatched_pipe'; wrong.label = '연결점 불일치'; wrong.prefabGuid = '8'.repeat(32); wrong.prefabPath = 'Assets/Mismatch.prefab'; wrong.wallMount.sockets[0].position.x -= .1;
  const panel = placeholderWallBinding('wallPanel'); panel.id = 'actual_panel'; panel.label = '다른 종류 패널'; panel.prefabGuid = '9'.repeat(32); panel.prefabPath = 'Assets/Panel.prefab';
  const registeredInput = resolve(output, 'registered-later.baekho.json'); await writeFile(registeredInput, JSON.stringify({ ...reopened.project, bindings: [real, wrong, panel] }));
  await open(registeredInput); await select(vertical[0]);
  const bulk = page.locator(`[data-wall-bulk-editor="pipeStraight"]`);
  assert.match(await bulk.innerText(), new RegExp(`같은 종류 ${straight.length}개 한 번에 교체`));
  assert.doesNotMatch(await control('wall-bulk-binding').innerText(), /다른 종류 패널/);
  await control('wall-bulk-binding').selectOption(wrong.id); await expand();
  const unchangedSelection = await save('selection-only'); assert.deepEqual(unchangedSelection.project.map.fixtures, placed.project.map.fixtures, 'selecting bulk prefab must not change the selected item');
  await action('replace-wall-placeholders'); await expand(); assert.match(await page.locator('#status').innerText(), /교체|연결점/);
  const rejected = await save('mismatch-rejected'); assert.deepEqual(rejected.project.map.fixtures, placed.project.map.fixtures, 'mismatch rolls every item back');
  await control('wall-bulk-binding').selectOption(real.id); await expand(); await action('replace-wall-placeholders'); await expand();
  const replaced = await save('bulk-replaced'), changed = replaced.project.map.fixtures.filter(fixture => fixture.bindingId === real.id);
  assert.equal(changed.length, straight.length); assert.ok(changed.some(fixture => fixture.wall.rotationZ)); assert.ok(changed.some(fixture => !fixture.wall.rotationZ));
  const near = (a, b) => ['x', 'y', 'z'].every(axis => Math.abs(a[axis] - b[axis]) < 1e-6);
  const angle = value => ((value ?? 0) % 360 + 360) % 360;
  for (const fixture of changed) {
    const old = straight.find(item => item.id === fixture.id); assert.ok(near(fixture.wall.position, old.wall.position)); assert.equal(!!fixture.wall.rotationZ, !!old.wall.rotationZ); assert.equal(fixture.wall.placeholder, undefined);
    assert.equal(angle(fixture.wall.rotationY), angle(old.wall.rotationY), 'an identical native prefab keeps the existing yaw'); assert.equal(angle(fixture.wall.rotationZ), angle(old.wall.rotationZ), 'an identical native prefab keeps the existing roll');
    assert.ok(fixture.wall.sockets.every(socket => old.wall.sockets.some(previous => near(socket.position, previous.position) && near(socket.direction, previous.direction))), 'equivalent orientations keep every world socket');
    assert.ok(fixture.wall.bounds.every(bounds => old.wall.bounds.some(previous => near(bounds.center, previous.center) && near(bounds.size, previous.size))), 'measured world extent stays fixed');
  }
  const withoutAuthored = fixtures => fixtures.map(fixture => { const copy = structuredClone(fixture); delete copy.wall.authored; return copy; });
  assert.deepEqual(withoutAuthored(replaced.project.map.fixtures.filter(fixture => fixture.wall.placeholder)), withoutAuthored(placed.project.map.fixtures.filter(fixture => fixture.wall.placeholder !== 'pipeStraight')), 'other temporary kinds keep their geometry and identity');
  await page.locator('[data-action="undo"]').click(); await expand(); const restored = await save('one-undo'); assert.deepEqual(restored.project.map.fixtures, placed.project.map.fixtures, 'one Undo restores the entire bulk operation');
  await open(input); await control('wall-setting:runOrientation').selectOption('vertical'); await expand(); await action('place-wall-mounts'); await expand();
  const verticalOnly = await save('vertical-only'); const verticalParts = verticalOnly.project.map.fixtures.filter(fixture => fixture.wall?.placeholder === 'pipeStraight'); assert.ok(verticalParts.length > 0); assert.ok(verticalParts.every(fixture => fixture.wall.rotationZ));
  await open(verticalOnly.path); assert.equal(await control('wall-setting:runOrientation').inputValue(), 'vertical');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ success: true, horizontal: horizontal.length, vertical: vertical.length, replaced: changed.length, output }));
} finally { await app.close(); }
