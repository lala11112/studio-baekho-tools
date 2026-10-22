// Actual Unity Editor checks for authoring metadata and native-pivot wall fixture imports.
// Only the repository's ignored .local/unity-validation project is changed. No paid AI calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
const project = resolve(local, 'unity-validation');
const versionFile = resolve(project, 'ProjectSettings/ProjectVersion.txt');
const versionText = await readFile(versionFile, 'utf8').catch(() => '');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim() ?? '6000.3.10f1';
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor).catch(() => { throw new Error('Set UNITY_EDITOR to an installed Unity Editor executable.'); });
await mkdir(local, { recursive: true });

async function runEditor(create = false, method = 'Run') {
  const log = resolve(local, create ? 'unity-wall-create.log' : method === 'Run' ? 'unity-wall-validation.log' : 'unity-wall-generated-validation.log');
  await new Promise((done, fail) => {
    const child = spawn(editor, ['-batchmode', '-nographics', create ? '-createProject' : '-projectPath', project,
      ...(!create ? ['-executeMethod', `BaekhoWallMountSmoke.${method}`] : []), '-quit', '-logFile', log],
    { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity wall verification timed out; see ${log}`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(`Unity wall verification exited ${code}; see ${log}`)); });
  });
  if (!create) assert.match(await readFile(log, 'utf8'), method === 'Run' ? /BAEKHO_WALL_MOUNT_PASS/ : /BAEKHO_WALL_GENERATED_PASS/);
}

if (!versionText) await runEditor(true);
await mkdir(resolve(project, 'Assets/Editor'), { recursive: true });
await mkdir(resolve(project, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ...['BaekhoMapImporter', 'BaekhoPropCatalog'].map(name => [`unity-importer/Editor/${name}.cs`, `Assets/Editor/${name}.cs`]),
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture', 'BaekhoWallModule'].map(name =>
    [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
  ['tests/unity/BaekhoWallMountSmoke.cs', 'Assets/Editor/BaekhoWallMountSmoke.cs'],
]) await copyFile(resolve(root, source), resolve(project, destination));
await runEditor();
console.log(await readFile(resolve(local, 'wall-validation-result.txt'), 'utf8'));

// Validate actual JsonUtility output against the application's exact parser as well.
const { parseWallMountDefinition, parseLocalBounds, placeWallMounts, wallMountIssues, DEFAULT_WALL_SETTINGS } = await tsImport('../src/shared/wall-mounts.ts', import.meta.url);
const catalog = JSON.parse(await readFile(resolve(local, 'wall-catalog-validation.json'), 'utf8'));
assert.equal(catalog.version, 2);
assert.equal(catalog.assets.length, 10);
for (const entry of catalog.assets) {
  parseLocalBounds(entry.bounds);
  if (entry.wallMount) parseWallMountDefinition(entry.wallMount);
}
const { parsePropBoundsCatalog } = await tsImport('../src/shared/props.ts', import.meta.url);
assert.deepEqual(parsePropBoundsCatalog(catalog), catalog, 'actual Unity catalog round-trips through the complete v2 parser');
assert.deepEqual(catalog.assets.slice(8).map(entry => entry.wallMount.kind), ['elbow', 'tee']);
console.log(`PASS actual Unity v2 catalog -> app parser: ${catalog.assets.length} bounds, ${catalog.assets.filter(entry => entry.wallMount).length} wall definitions`);

const names = ['Pipe1', 'Pipe2', 'Inner', 'Outer', 'Cap', 'DoorLight', 'Legacy', 'CornerLight', 'Elbow', 'Tee'];
const bindings = catalog.assets.map((entry, index) => ({ id: names[index], label: names[index], role: [5, 7].includes(index) ? 'light' : 'decoration',
  prefabGuid: entry.guid, prefabPath: `Assets/BaekhoWallValidation/${names[index]}.prefab`, scale: { x: 1, y: 1, z: 1 },
  offset: { x: 0, y: 0, z: 0 }, rotationY: 0, bounds: entry.bounds, ...(entry.wallMount ? { wallMount: entry.wallMount } : {}) }));
const room = () => ({ version: 5, name: 'Actual Unity wall kit', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
  rows: ['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
  elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 });
const settings = { ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 100 };
const count = (result, bindingId) => result.map.fixtures?.filter(fixture => fixture.bindingId === bindingId).length ?? 0;
const closed = placeWallMounts(room(), settings, bindings);
assert.equal(closed.runCount, 1); assert.equal(count(closed, 'Inner'), 4); assert.equal(count(closed, 'Cap'), 0);
assert.ok(closed.addedModules > 20); assert.deepEqual(closed.issues, []); assert.deepEqual(wallMountIssues(closed.map, bindings), []);
const withPillar = room(); withPillar.rows[3] = withPillar.rows[4] = '#..##..#';
const outer = placeWallMounts(withPillar, settings, bindings);
assert.equal(outer.runCount, 2); assert.equal(count(outer, 'Outer'), 4); assert.deepEqual(wallMountIssues(outer.map, bindings), []);
const withLock = room(); withLock.lockedCells = [{ x: 3, row: 0 }];
const open = placeWallMounts(withLock, settings, bindings);
assert.equal(count(open, 'Cap'), 2); assert.deepEqual(wallMountIssues(open.map, bindings), []);
const evenKit = bindings.filter(binding => binding.id !== 'Pipe1');
const gap = placeWallMounts(room(), settings, evenKit);
assert.ok(count(gap, 'Cap') > 0); assert.ok(gap.issues.some(issue => issue.code === 'wall-run-length'));
assert.deepEqual(wallMountIssues(gap.map, evenKit), []);
const doorway = room(); doorway.rows[0] = '##DD####';
doorway.connections = [{ id: 'north', label: 'North', x: 2, row: 0, direction: 0, width: 4, height: 3, kind: 'door' }];
doorway.structureFills = [2, 3].map(x => ({ id: `top-${x}`, x, row: 0, role: 'wall', purpose: 'doorTop', direction: 0,
  position: { x: (x - 3.5) * 2, y: 3.5, z: 7 }, size: { x: 2, y: 1, z: 2 } }));
const doorLight = placeWallMounts(doorway, { ...settings, singles: true, runs: false, density: 100 }, bindings);
assert.equal(count(doorLight, 'DoorLight'), 1); assert.deepEqual(wallMountIssues(doorLight.map, bindings), []);
const cornerLight = placeWallMounts(room(), { ...settings, singles: true, runs: false, density: 100 }, bindings.filter(binding => binding.id === 'CornerLight'));
assert.equal(count(cornerLight, 'CornerLight'), 4); assert.deepEqual(wallMountIssues(cornerLight.map, bindings), []);
console.log('PASS actual Unity prefabs -> app placement: off-pivot straight kit, 4 inner corners, 4 outer corners, capped locked boundary, fixed-length gaps, wide-door light and 4 two-mount corner lights');

const verticalSettings = { ...settings, runOrientation: 'vertical' };
const vertical = placeWallMounts(room(), verticalSettings, bindings);
assert.ok(vertical.addedModules > 0, 'actual measured straight kit produces vertical runs');
assert.ok(vertical.map.fixtures.every(f => [90, 270].includes(f.wall.rotationZ)), 'vertical native modules carry the local roll');
assert.ok(vertical.map.fixtures.every(f => f.wall.sockets.every(s => Math.abs(s.direction.y) > .999)), 'resolved sockets face up/down');
assert.deepEqual(wallMountIssues(vertical.map, bindings), []);
const { replaceWallPlaceholders } = await tsImport('../src/shared/wall-replacement.ts', import.meta.url);
let converted = placeWallMounts(room(), verticalSettings, []).map;
const temporaryCount = converted.fixtures.length;
assert.ok(temporaryCount > 0);
for (const [kind, bindingId] of [['pipeStraight', 'Pipe1'], ['pipeEndCap', 'Cap']]) converted = replaceWallPlaceholders(converted, kind, bindingId, bindings).map;
assert.ok(converted.fixtures.every(f => !f.wall.placeholder));
assert.deepEqual(wallMountIssues(converted, bindings), []);
console.log(`PASS vertical actual Unity catalog: ${vertical.addedModules} native modules and ${temporaryCount} temporary modules bulk-converted with off-center pivots and preserved sockets`);

const connectedSettings = { ...settings, runDensity: 40, runOrientation: 'both', connectRuns: true };
const connected = placeWallMounts(room(), connectedSettings, bindings);
assert.ok(count(connected, 'Elbow') > 0 && count(connected, 'Tee') > 0, 'actual Unity elbow and tee prefabs both join horizontal and vertical pipes');
assert.ok(connected.map.fixtures.filter(f => ['Elbow', 'Tee'].includes(f.bindingId)).every(f =>
  f.wall.sockets.some(s => Math.abs(s.direction.y) > .999) && f.wall.sockets.some(s => Math.abs(s.direction.y) < .001)), 'junctions preserve mixed horizontal and vertical socket directions');
assert.deepEqual(wallMountIssues(connected.map, bindings), []);
let connectedTemporary = placeWallMounts(room(), connectedSettings, []).map;
const connectedTemporaryCount = connectedTemporary.fixtures.length;
assert.ok(connectedTemporary.fixtures.some(f => ['pipeElbow', 'pipeTee'].includes(f.wall.placeholder)), 'placeholder connected kit also contains junctions');
for (const [kind, bindingId] of [['pipeStraight', 'Pipe1'], ['pipeInnerCorner', 'Inner'], ['pipeOuterCorner', 'Outer'], ['pipeEndCap', 'Cap'], ['pipeElbow', 'Elbow'], ['pipeTee', 'Tee']]) {
  connectedTemporary = replaceWallPlaceholders(connectedTemporary, kind, bindingId, bindings).map;
}
assert.ok(connectedTemporary.fixtures.every(f => !f.wall.placeholder));
assert.deepEqual(wallMountIssues(connectedTemporary, bindings), []);
console.log(`PASS actual Unity elbow/tee catalog: ${count(connected, 'Elbow')} elbows, ${count(connected, 'Tee')} tees; ${connectedTemporaryCount} connected temporary modules bulk-converted with native pivots and socket geometry`);

// Export real application manifests, then re-open Unity to measure their actual renderers,
// colliders and native module sockets. This covers the importer as well as JSON placement math.
const { buildManifest } = await tsImport('../src/shared/map.ts', import.meta.url);
const terrainGuids = JSON.parse(await readFile(resolve(local, 'wall-terrain-validation.json'), 'utf8'));
const terrain = Object.entries(terrainGuids).map(([role, prefabGuid]) => ({ id: `terrain-${role}`, label: role, role, prefabGuid,
  prefabPath: `Assets/BaekhoWallValidation/Terrain${role[0].toUpperCase()}${role.slice(1)}.prefab`,
  scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));
terrain.push({ ...terrain.find(binding => binding.role === 'wall'), id: 'terrain-stair', label: 'stair', role: 'stair', stairNativeRise: 1 });
const allBindings = [...terrain, ...bindings], cases = [];
const writeScenario = async (name, map, checks, clearPoints = []) => {
  const assetPath = `Assets/BaekhoWallValidation/generated-${name}.baekhomap.json`;
  const manifest = buildManifest({ ...map, name: `Generated ${name}` }, allBindings);
  await writeFile(resolve(project, assetPath), JSON.stringify(manifest));
  cases.push({ manifest: assetPath, checks, clearPoints }); return manifest;
};
const manifestRoom = (externalDoor = true) => {
  const map = room();
  if (externalDoor) {
    map.rows[0] = '###D####';
    map.connections = [{ x: 3, row: 0, id: 'entry', label: 'Entry', width: 2, height: 3, direction: 0, kind: 'door' }];
  }
  map.wallHeights = map.rows.flatMap((line, row) => [...line].flatMap((tile, x) => tile === '#' ? [{ x, row, height: 4, heightMode: 'manual' }] : []));
  return map;
};
const fixtureChecks = (map, min, max) => map.fixtures.filter(fixture => fixture.wall?.runId).map(fixture => ({
  objectName: `${fixture.role}_fixture-${fixture.id}`, checkPivot: true, position: fixture.wall.position,
  nativeScale: true, checkSockets: true, socketMin: min, socketMax: max,
}));
for (const [label, runHeight, low, high] of [
  ['fixed-low', { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 }, 1.25, 1.25],
  ['fixed-top', { mode: 'fixed', reference: 'top', min: .75, max: .75 }, 3.25, 3.25],
  ['random', { mode: 'random', reference: 'floor', min: 1, max: 3 }, 1, 3],
]) {
  const generated = placeWallMounts(manifestRoom(), { ...settings, runHeight }, bindings);
  assert.ok(generated.addedModules > 0, `${label} actual Unity kit places generated pipes`);
  assert.deepEqual(wallMountIssues(generated.map, bindings), []);
  const checks = fixtureChecks(generated.map, low, high); assert.ok(checks.length > 0);
  await writeScenario(label, generated.map, checks);
}
const ranged = placeWallMounts(manifestRoom(), { ...settings, runOrientation: 'vertical', verticalRange: { reference: 'floor', start: .5, end: 2.5 } }, bindings);
assert.ok(ranged.addedModules > 0, 'custom vertical range contains actual measured native modules');
assert.ok(ranged.map.fixtures.every(fixture => fixture.wall.bounds.every(bounds => bounds.center.y - bounds.size.y / 2 >= .5 - 1e-6 && bounds.center.y + bounds.size.y / 2 <= 2.5 + 1e-6)), 'complete native vertical kits fit the custom range before export');
await writeScenario('vertical-range', ranged.map, fixtureChecks(ranged.map, .5, 2.5).map(check => ({ ...check, checkGeometryRange: true, minY: .5, maxY: 2.5 })));

for (const [direction, door, wall, outward] of [
  [0, { x: 3, row: 0 }, { x: 2, row: 0 }, [0, -1]],
  [90, { x: 7, row: 3 }, { x: 7, row: 2 }, [1, 0]],
  [180, { x: 3, row: 7 }, { x: 4, row: 7 }, [0, 1]],
  [270, { x: 0, row: 3 }, { x: 0, row: 4 }, [-1, 0]],
]) {
  const map = manifestRoom(false), setTile = (cell, tile) => { map.rows[cell.row] = map.rows[cell.row].slice(0, cell.x) + tile + map.rows[cell.row].slice(cell.x + 1); };
  setTile(door, 'D'); map.connections = [{ ...door, id: 'lower-door', label: 'Lower door', width: 2, height: 3, direction, kind: 'door' }];
  map.wallHeights = map.wallHeights.filter(height => height.x !== door.x || height.row !== door.row);
  const highFloor = { x: wall.x - outward[0], row: wall.row - outward[1] }, stair = { x: wall.x - outward[0] * 2, row: wall.row - outward[1] * 2 };
  map.elevations[wall.row][wall.x] = map.elevations[highFloor.row][highFloor.x] = 2;
  setTile(stair, 'R'); map.ramps = [{ ...stair, direction, rise: 2 }];
  map.wallHeights.find(height => height.x === wall.x && height.row === wall.row).height = 6;
  const originalId = `wall-${wall.x}-${wall.row}`;
  const manifest = await writeScenario(`lower-door-${direction}`, map, [
    { objectName: `wall_${originalId}`, checkGeometry: true, minY: 2, maxY: 8 },
    { objectName: `wall_${originalId}-base`, checkGeometry: true, minY: 0, maxY: 2 },
  ], [{ x: (door.x - 3.5) * 2, y: 1, z: (3.5 - door.row) * 2 }]);
  const closure = manifest.placements.find(placement => placement.id === `${originalId}-base`);
  assert.ok(closure, 'saved raised-wall map exports an added wall foot without altering its wall');
  assert.equal(map.elevations[wall.row][wall.x], 2, 'export does not rewrite authored wall terrain');
}
await writeFile(resolve(local, 'wall-generated-expectations.json'), JSON.stringify({ cases }));
await runEditor(false, 'RunGeneratedManifest');
console.log(await readFile(resolve(local, 'wall-generated-validation-result.txt'), 'utf8'));
