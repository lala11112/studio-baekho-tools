// v0.5.1 integration: real Electron preview/save/export; synthetic source bounds, no AI or Unity launch.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { DEFAULT_SETTINGS, parseProjectFile, validateMap, buildManifest } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { configureStructures, DEFAULT_STRUCTURE_SETTINGS, floorSlabBounds, resolvedStructureFill } = await tsImport('../src/shared/structures.ts', import.meta.url);
const { placeProps, propPosition, propValidationIssues } = await tsImport('../src/shared/props.ts', import.meta.url);
const { analyzeLevelDesign, obstacleTactics } = await tsImport('../src/shared/level-design.ts', import.meta.url);
const output = resolve('.local/v051-smoke'), userData = resolve(output, `userdata-${Date.now()}`), fixture = resolve(output, 'TestUnity');
await mkdir(userData, { recursive: true }); await mkdir(resolve(fixture, 'Assets/Modules'), { recursive: true }); await mkdir(resolve(fixture, 'ProjectSettings'), { recursive: true });
const roleNames = ['floor', 'wall', 'door', 'ceiling', 'cliff', 'deadzone', 'stair', 'slope', 'crate', 'table', 'rock', 'floor-thick'];
const bindings = roleNames.map((name, index) => ({ id: name, label: name, role: ['crate', 'table', 'rock'].includes(name) ? 'prop' : name === 'floor-thick' ? 'floor' : name,
  prefabGuid: (index + 1).toString(16).padStart(32, '0'), prefabPath: `Assets/Modules/${name}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  ...(['stair', 'slope'].includes(name) ? { stairNativeRise: 1.5 } : {}),
  ...(['crate', 'table', 'rock'].includes(name) ? { prop: { category: { crate: '상자', table: '가구', rock: '바위' }[name], tags: [], blocksMovement: true,
    size: { crate: { x: 1.2, y: 1, z: 1.2 }, table: { x: 2.6, y: 1.2, z: 1.4 }, rock: { x: 1.6, y: 1.8, z: 1.5 } }[name], placement: 'floor', roomTypes: ['battle'], weight: 1 } } : {}) }));
for (const binding of bindings) { await writeFile(resolve(fixture, binding.prefabPath), '%YAML 1.1\n'); await writeFile(resolve(fixture, `${binding.prefabPath}.meta`), `fileFormatVersion: 2\nguid: ${binding.prefabGuid}\n`); }
const byId = id => bindings.find(binding => binding.id === id);
byId('floor-thick').scale.y = 2.5; byId('floor-thick').offset.y = .2;
byId('table').scale = { x: 1.2, y: 1.3, z: 1 }; byId('table').rotationY = 15; byId('table').offset.x = .05;
byId('wall').offset.y = .1;
byId('stair').offset = { x: .05, y: .15, z: -.05 };
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const near = (actual, expected, label) => { assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`); assertions++; };
let assertions = 0;
const room = (width, height, name) => ({ version: 5, name, width, height, cellSize: 2, maxStepHeight: .4,
  rows: Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, x) => row === 0 && x === Math.floor(width / 2) ? 'D' : row === 0 || row === height - 1 || x === 0 || x === width - 1 ? '#' : '.').join('')),
  elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], connections: [{ id: 'north', label: '북문', x: Math.floor(width / 2), row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] });
const tile = (map, x, row, value) => { const chars = [...map.rows[row]]; chars[x] = value; map.rows[row] = chars.join(''); };
const settingsFor = (map, seed = 237) => ({ ...DEFAULT_SETTINGS, width: map.width, height: map.height, cellSize: map.cellSize, connectionCount: 1, seed, roomPreset: 'medium', sizeMode: 'custom', sizeResolved: true,
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: true }, levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } });

// A connected two-level terrace with native stair and slope sources, plus an internal pit.
let terrain = room(12, 12, '0.5.1 바닥 두께 · 계단 바닥 기준');
for (let row = 4; row <= 10; row++) for (let x = 5; x <= 10; x++) terrain.elevations[row][x] = 2;
for (let row = 6; row <= 9; row++) for (let x = 7; x <= 10; x++) terrain.elevations[row][x] = 4;
for (const ramp of [{ x: 5, row: 3, direction: 180, rise: 2 }, { x: 6, row: 7, direction: 90, rise: 2 }, { x: 8, row: 5, direction: 180, rise: 2, kind: 'slope' }]) { tile(terrain, ramp.x, ramp.row, 'R'); terrain.ramps.push(ramp); }
tile(terrain, 2, 7, '_'); tile(terrain, 2, 8, '_');
// Keep normal floor selection deterministic, with one deliberately thicker/offset override.
for (let row = 0; row < terrain.height; row++) for (let x = 0; x < terrain.width; x++) if ('.DPR'.includes(terrain.rows[row][x])) terrain.assetOverrides.push({ x, row, role: 'floor', bindingId: x === 7 && row === 6 ? 'floor-thick' : 'floor' });
terrain = configureStructures(terrain, DEFAULT_STRUCTURE_SETTINGS);
const terrainSettings = { ...settingsFor(terrain), designer: { ...DEFAULT_DESIGNER, props: false, elevation: true, slopes: true, cliffs: true, structureFill: true } };
assert.deepEqual(validateMap(terrain).filter(issue => issue.severity === 'error'), []);
const terrainManifest = buildManifest(terrain, bindings);
const authoredFills = JSON.stringify(terrain.structureFills);
for (const fill of terrain.structureFills.filter(fill => ['heightGap', 'pitSide'].includes(fill.purpose))) {
  const physical = resolvedStructureFill(terrain, fill, bindings), slab = floorSlabBounds(terrain, fill, bindings), placement = terrainManifest.placements.find(p => p.id === `fill-${fill.id}`);
  if (!physical) { check(!placement, 'fully occupied vertical gap emits no duplicate support'); continue; }
  near(placement.position.y + placement.fitSize.y / 2, slab.bottom, 'support contacts actual slab underside');
  near(placement.position.y - placement.fitSize.y / 2, fill.position.y - fill.size.y / 2 + (fill.role === 'wall' ? .1 : 0), 'support lower endpoint stays fixed including own offset');
  assert.deepEqual(placement.position, physical.position); assert.deepEqual(placement.fitSize, physical.size);
}
check(authoredFills === JSON.stringify(terrain.structureFills), 'export resolves slab trim without rewriting authored topology');
const calibrated = terrain.structureFills.find(fill => fill.x === 7 && fill.row === 6 && fill.purpose === 'heightGap');
near(floorSlabBounds(terrain, calibrated, bindings).bottom, 4 + .2 - 2 * .12 * 2.5, 'overridden floor thickness multiplier and offset applied once');
for (const ramp of terrain.ramps) {
  const role = ramp.kind ?? 'stair', placement = terrainManifest.placements.find(p => p.id === `${role}-${ramp.x}-${ramp.row}`), binding = byId(role);
  check(placement.surface === 'bottom' && !placement.centerXZ, 'stairs/slopes request calibrated native bottom center path');
  near(placement.position.y, terrain.elevations[ramp.row][ramp.x] + binding.offset.y, 'stair bottom elevation plus explicit offset'); near(placement.scale.y, ramp.rise / binding.stairNativeRise, 'stair rise calibration preserved');
}

const tactics = room(18, 16, '0.5.1 비대칭 우회 · 재접근 전투 소품'), tacticalSettings = settingsFor(tactics);
const intentions = [{ x: 4, row: 5 }, { x: 13, row: 5 }, { x: 4, row: 10 }, { x: 13, row: 10 }]; intentions.forEach(c => tile(tactics, c.x, c.row, 'P'));
const cleared = structuredClone(tactics); intentions.forEach(c => tile(cleared, c.x, c.row, '.'));
const before = analyzeLevelDesign(cleared, tacticalSettings), reserved = [...before.reservedEntryCells, ...before.combatCells, ...before.routes.flat()];
const tacticalBindings = bindings.filter(binding => binding.id !== 'floor-thick');
const generated = placeProps(tactics, tacticalSettings, tacticalBindings, undefined, reserved, { tactical: true }).map;
assert.deepEqual(generated, placeProps(tactics, tacticalSettings, [...tacticalBindings].reverse(), undefined, reserved, { tactical: true }).map, 'same seed and catalog identity produce same layout');
check(generated.propInstances.length === intentions.length, 'tactical relocation retains exact requested object count');
const occupied = new Set(generated.propInstances.flatMap(p => p.cells.map(c => `${c.x},${c.row}`)));
check(!generated.propInstances.every(p => p.cells.every(c => occupied.has(`${generated.width - 1 - c.x},${c.row}`))), 'final obstacle footprints break mirrored placement');
check(generated.propInstances.some(p => !intentions.some(c => p.x === c.x && p.row === c.row)), 'generated tactical positions are evaluated beyond original image markers');
check(new Set(generated.propInstances.map(p => p.category)).size > 1, 'equal viable catalog has distinct obstacle kinds');
assert.deepEqual(propValidationIssues(generated, tacticalBindings).filter(issue => issue.severity === 'error'), []);
const evidence = obstacleTactics(generated, tacticalSettings), report = analyzeLevelDesign(generated, tacticalSettings);
check(evidence.length === generated.propInstances.length && evidence.every(e => e.detourMeters > 0 && e.routes.every(route => route.length > 2)), 'each obstacle has two separate local bypass routes and added travel distance');
check(report.combatCells.length > 0 && !report.issues.some(issue => issue.severity === 'error'), 'all entry routes and dodge space remain usable');
const tacticalManifest = buildManifest(generated, tacticalBindings);
for (const prop of generated.propInstances) {
  const binding = tacticalBindings.find(binding => binding.id === prop.bindingId), placement = tacticalManifest.placements.find(p => p.id === `prop-instance-${prop.id}`);
  assert.deepEqual(placement.position, propPosition(generated, prop, binding)); assert.deepEqual(placement.scale, binding.scale);
  check(placement.surface === 'bottom' && placement.centerXZ === true && !placement.fitSize, 'measured prop native scale is preserved with bottom-center bounds alignment');
}
const large = room(40, 40, '40셀 성능 검증'), largeSettings = settingsFor(large);
for (const c of [{ x: 8, row: 10 }, { x: 31, row: 10 }, { x: 8, row: 29 }, { x: 31, row: 29 }, { x: 15, row: 14 }, { x: 24, row: 14 }]) tile(large, c.x, c.row, 'P');
const started = performance.now(); const largeResult = placeProps(large, largeSettings, tacticalBindings, undefined, [], { tactical: true }); const elapsed = performance.now() - started;
check(largeResult.map.propInstances.length === 6 && elapsed < 15000, `40×40, six measured obstacles completes within 15s (${Math.round(elapsed)}ms)`);
await writeFile(resolve(output, 'tactical-evidence.json'), JSON.stringify({ seed: tacticalSettings.seed, intentions, instances: generated.propInstances, evidence, report, maximumMapElapsedMs: elapsed }, null, 2));
const cases = [{ name: 'geometry', map: terrain, settings: terrainSettings, bindings, manifest: terrainManifest }, { name: 'tactics', map: generated, settings: tacticalSettings, bindings: tacticalBindings, manifest: tacticalManifest }];
for (const item of cases) { item.path = resolve(output, `${item.name}.baekho.json`); item.project = parseProjectFile({ formatVersion: 1, map: item.map, settings: item.settings, bindings: item.bindings }); await writeFile(item.path, JSON.stringify(item.project)); }
if (process.argv.includes('--source-only')) { console.log(`PASS v0.5.1 source: ${assertions} checks; 40×40 placement ${Math.round(elapsed)}ms; ${output}`); process.exit(0); }

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env }), rendererErrors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => rendererErrors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, directory) => { app.setPath('userData', directory); ipcMain.removeHandler('baekho:codex-status'); ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no AI calls', models: [] })); dialog.showMessageBoxSync = () => 1; }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const idle = async () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  for (const item of cases) {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, item.path);
    await page.locator('[data-action="open"]').click(); await idle(); assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
    await page.locator('[data-view="3d"]').click(); await page.locator('[data-right-tab="design"]').click(); await page.locator('details').evaluateAll(items => items.forEach(detail => { detail.open = true; }));
    if (item.name === 'tactics') {
      const obstacleButton = page.locator('[data-d-action="design-obstacle"]');
      check(await obstacleButton.count() === evidence.length, 'designer lists each measured obstacle with two bypasses');
      await obstacleButton.first().click();
      check(await page.locator('[data-d-action="view-design"]').first().getAttribute('aria-pressed') === 'true', 'obstacle selection turns on path overlay');
      await page.locator('[data-right-tab="cell"]').click();
      const origin = evidence[0].cells[0], selected = generated.propInstances.find(prop => prop.cells.some(c => c.x === origin.x && c.row === origin.row));
      check(await page.locator('[data-prop-instance-binding]').getAttribute('data-prop-instance-binding') === selected.id, 'obstacle button selects its origin and complete instance');
      await page.screenshot({ path: resolve(output, 'tactics-selected-obstacle.png') });
      await page.locator('[data-right-tab="design"]').click();
    }
    await page.screenshot({ path: resolve(output, `${item.name}-preview.png`) });
    const savedPath = resolve(output, `${item.name}-saved.baekho.json`);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, savedPath);
    await page.locator('[data-action="save"]').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/);
    const saved = JSON.parse(await readFile(savedPath, 'utf8')); assert.deepEqual(saved, item.project); check(true, `${item.name}: actual UI preserves complete saved data`);
    await page.locator('[data-right-tab="assets"]').click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixture);
    await page.locator('[data-action="scan"]').click(); await idle();
    const zipPath = resolve(output, `${item.name}-export.zip`);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, zipPath);
    check(await page.locator('[data-action="export"]').isEnabled(), await page.locator('#status').innerText());
    await page.locator('[data-action="export"]').click(); await idle(); assert.match(await page.locator('#status').innerText(), /내보내기 완료/);
    const zip = unzipSync(await readFile(zipPath)), manifest = JSON.parse(strFromU8(zip['Map.baekhomap.json'])); assert.deepEqual(manifest, item.manifest); check(manifest.schemaVersion === 5, `${item.name}: native v5 ZIP geometry exactly matches analyzed structure`);
  }
  assert.deepEqual(rendererErrors, []); console.log(`PASS Electron v0.5.1: ${assertions} checks; 40×40 placement ${Math.round(elapsed)}ms; zero renderer errors; ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await app.close();
}
