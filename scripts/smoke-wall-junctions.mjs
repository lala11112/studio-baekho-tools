// Actual Electron controls and world-space graph checks for horizontal/vertical elbow and tee networks.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } = await tsImport('../src/shared/wall-placeholders.ts', import.meta.url);
const output = resolve('.local/wall-junctions-smoke'), userData = resolve(output, `user-${Date.now()}`); await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 10, conceptMode: 'manual', connectionCount: 1, connectionHeight: 2.5, seed: 417, prompt: 'Connected horizontal and vertical wall pipes',
  designer: { ...DEFAULT_DESIGNER, elevation: false, lights: false, props: false, decorations: false, wallHeight: 6, wallMounts: { enabled: true, singles: false, runs: true, density: 30, runDensity: 40, runOrientation: 'both' } } };
const source = { version: 5, name: '엘보·T자 배관 연결', width: 12, height: 10, cellSize: 2, rows: ['######D#####', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], maxStepHeight: .4, assetOverrides: [], connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 2.5, kind: 'door' }], structureSettings: { ceilingClearance: 6, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 6 } };
const input = resolve(output, 'unregistered.baekho.json'); await writeFile(input, JSON.stringify({ formatVersion: 1, map: source, settings, bindings: [] }));
const near = (a, b) => ['x', 'y', 'z'].every(axis => Math.abs(a[axis] - b[axis]) < 1e-5);
function assertClosedNetworks(map) {
  const walls = (map.fixtures ?? []).filter(fixture => fixture.wall?.runId);
  for (const runId of new Set(walls.map(fixture => fixture.wall.runId))) {
    const group = walls.filter(fixture => fixture.wall.runId === runId), graph = new Map(group.map(fixture => [fixture.id, new Set()]));
    for (const fixture of group) for (const socket of fixture.wall.sockets) {
      const opposite = { x: -socket.direction.x, y: -socket.direction.y, z: -socket.direction.z };
      const matches = group.filter(other => other.id !== fixture.id && other.wall.sockets.some(candidate => near(candidate.position, socket.position) && near(candidate.direction, opposite)));
      assert.equal(matches.length, 1, `${fixture.id} has exactly one matching socket at every endpoint`); graph.get(fixture.id).add(matches[0].id);
    }
    const visited = new Set(), queue = [group[0].id]; while (queue.length) { const id = queue.pop(); if (visited.has(id)) continue; visited.add(id); queue.push(...graph.get(id)); }
    assert.equal(visited.size, group.length, `${runId} is one physically connected socket graph`);
  }
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, folder) => { app.setPath('userData', folder); dialog.showMessageBoxSync = () => 1; ipcMain.removeHandler('baekho:codex-status'); ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] })); }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const expand = () => page.locator('details').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
  const control = name => page.locator(`[data-d-control="${name}"]`).last();
  const action = name => page.locator(`[data-d-action="${name}"]`).last().click();
  const save = async name => { const path = resolve(output, `${name}.baekho.json`); await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path); await page.locator('[data-action="save"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료')); return { path, project: JSON.parse(await readFile(path, 'utf8')) }; };
  const open = async path => { await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, path); await page.locator('[data-action="open"]').click(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다')); await page.locator('[data-right-tab="design"]').click(); await expand(); };
  const select = async fixture => { await page.locator(`[data-d-action="select-fixture"][data-id="${fixture.id}"]`).click(); await expand(); await page.locator(`[data-wall-fixture-editor="${fixture.id}"]`).scrollIntoViewIfNeeded(); };
  await open(input); assert.equal(await control('wall-setting:connectRuns').isChecked(), true, 'missing connection settings default on');
  await action('place-wall-mounts'); await expand();
  const placed = await save('connected'), walls = placed.project.map.fixtures.filter(fixture => fixture.wall), junctions = walls.filter(fixture => ['pipeElbow', 'pipeTee'].includes(fixture.wall.placeholder));
  const tees = junctions.filter(fixture => fixture.wall.placeholder === 'pipeTee'), elbows = junctions.filter(fixture => fixture.wall.placeholder === 'pipeElbow');
  assert.ok(tees.length > 0, 'combined mode adds tee branches'); assert.ok(elbows.length > 0, 'combined mode adds elbow turns'); assertClosedNetworks(placed.project.map);
  for (const junction of junctions) { assert.equal(junction.wall.sockets.length, junction.wall.placeholder === 'pipeTee' ? 3 : 2); assert.ok(junction.wall.sockets.some(socket => Math.abs(socket.direction.y) > .9)); assert.ok(junction.wall.sockets.some(socket => Math.hypot(socket.direction.x, socket.direction.z) > .9)); }
  await select(tees[0]); assert.match(await page.locator(`[data-preview-wall-selection="${tees[0].id}"]`).innerText(), /가로·세로 연결/);
  await page.screenshot({ path: resolve(output, 'connected-network.png') });
  await open(placed.path); const reopened = await save('reopened'); assert.deepEqual(reopened.project.map.fixtures, placed.project.map.fixtures); assertClosedNetworks(reopened.project.map);
  const bindings = WALL_PLACEHOLDER_KINDS.map((kind, index) => { const binding = placeholderWallBinding(kind); binding.id = `actual_${kind}`; binding.label = `실제 ${kind}`; binding.prefabGuid = (index + 1).toString(16).repeat(32); binding.prefabPath = `Assets/${kind}.prefab`; if (binding.wallMount.kind !== 'single') binding.wallMount.family = 'actual-network'; return binding; });
  const wrong = structuredClone(bindings.find(binding => binding.id === 'actual_pipeTee')); wrong.id = 'mismatched_tee'; wrong.prefabGuid = 'f'.repeat(32); wrong.prefabPath = 'Assets/MismatchedTee.prefab'; wrong.wallMount.sockets[0].position.x += .1; bindings.push(wrong);
  const registeredInput = resolve(output, 'registered-later.baekho.json'); await writeFile(registeredInput, JSON.stringify({ ...reopened.project, bindings }));
  await open(registeredInput); await select(tees[0]);
  assert.doesNotMatch(await control('wall-bulk-binding').innerText(), /실제 pipeElbow/); assert.match(await page.locator('[data-wall-bulk-editor="pipeTee"]').innerText(), new RegExp(`같은 종류 ${tees.length}개 한 번에 교체`));
  await control('wall-bulk-binding').selectOption(wrong.id); await expand(); await action('replace-wall-placeholders'); await expand(); const rejected = await save('mismatch-rejected'); assert.deepEqual(rejected.project.map.fixtures, placed.project.map.fixtures, 'incompatible sockets leave the full network unchanged');
  const bulk = async (kind, fixture, name) => { await select(fixture); await control('wall-bulk-binding').selectOption(`actual_${kind}`); await expand(); await action('replace-wall-placeholders'); await expand(); const result = await save(name); assertClosedNetworks(result.project.map); return result; };
  const teeResult = await bulk('pipeTee', tees[0], 'tees-replaced'); assert.equal(teeResult.project.map.fixtures.filter(fixture => fixture.bindingId === 'actual_pipeTee').length, tees.length);
  await page.locator('[data-action="undo"]').click(); await expand(); const teeUndo = await save('tees-one-undo'); assert.deepEqual(teeUndo.project.map.fixtures, placed.project.map.fixtures, 'one undo restores every tee');
  const elbowResult = await bulk('pipeElbow', elbows[0], 'elbows-replaced'); assert.equal(elbowResult.project.map.fixtures.filter(fixture => fixture.bindingId === 'actual_pipeElbow').length, elbows.length);
  await page.locator('[data-action="undo"]').click(); await expand(); const elbowUndo = await save('elbows-one-undo'); assert.deepEqual(elbowUndo.project.map.fixtures, placed.project.map.fixtures, 'one undo restores every elbow');
  await bulk('pipeTee', tees[0], 'tees-final'); const final = await bulk('pipeElbow', elbows[0], 'junctions-final'); await open(final.path); const persisted = await save('junctions-persisted'); assert.deepEqual(persisted.project.map.fixtures, final.project.map.fixtures); assertClosedNetworks(persisted.project.map);
  const disconnectedInput = resolve(output, 'connection-off.baekho.json'); await writeFile(disconnectedInput, JSON.stringify({ formatVersion: 1, map: source, settings: { ...settings, designer: { ...settings.designer, wallMounts: { ...settings.designer.wallMounts, connectRuns: false } } }, bindings: [] }));
  await open(disconnectedInput); assert.equal(await control('wall-setting:connectRuns').isChecked(), false); await action('place-wall-mounts'); await expand(); const disconnected = await save('connection-off-result'); assert.equal(disconnected.project.map.fixtures.filter(fixture => ['pipeElbow', 'pipeTee'].includes(fixture.wall?.placeholder)).length, 0); assertClosedNetworks(disconnected.project.map);
  await control('wall-setting:connectRuns').check(); await expand(); await action('place-wall-mounts'); await expand();
  assert.match(await page.locator('[data-wall-placement-result]').last().innerText(), /현재 맵의 엘보·T자 연결부 [1-9]\d*개/);
  const reconnected = await save('existing-runs-connected'); assert.ok(reconnected.project.map.fixtures.some(fixture => ['pipeElbow', 'pipeTee'].includes(fixture.wall?.placeholder))); assertClosedNetworks(reconnected.project.map);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ success: true, elbows: elbows.length, tees: tees.length, fixtures: walls.length, output }));
} finally { await app.close(); }
