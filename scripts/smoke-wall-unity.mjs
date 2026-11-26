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

async function runEditor(create = false, method = 'Run', graphics = false) {
  const log = resolve(local, create ? 'unity-wall-create.log' : method === 'Run' ? 'unity-wall-validation.log' : method === 'RunVisualComparison' ? 'unity-wall-visual-validation.log' : 'unity-wall-generated-validation.log');
  await new Promise((done, fail) => {
    const child = spawn(editor, ['-batchmode', ...(!graphics ? ['-nographics'] : []), create ? '-createProject' : '-projectPath', project,
      ...(!create ? ['-executeMethod', `BaekhoWallMountSmoke.${method}`] : []), '-quit', '-logFile', log],
    { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity wall verification timed out; see ${log}`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(`Unity wall verification exited ${code}; see ${log}`)); });
  });
  if (!create) assert.match(await readFile(log, 'utf8'), method === 'Run' ? /BAEKHO_WALL_MOUNT_PASS/ : method === 'RunVisualComparison' ? /BAEKHO_WALL_VISUAL_PASS/ : method === 'PrepareVisualComparison' ? /BAEKHO_WALL_VISUAL_PREPARE_PASS/ : /BAEKHO_WALL_GENERATED_PASS/);
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
const visualProjects = await Promise.all(['before', 'after'].map(async phase => ({ phase, value: await readFile(resolve(local, `composition-visual/${phase}.baekho.json`), 'utf8').then(JSON.parse).catch(() => undefined) })));
if (visualProjects.every(p => p.value)) await writeFile(resolve(local, 'wall-visual-binding-input.json'), JSON.stringify({ assets: visualProjects[1].value.bindings.filter(b => b.prop).map(b => ({ id: b.id, size: b.prop.size })) }));
await runEditor();
console.log(await readFile(resolve(local, 'wall-validation-result.txt'), 'utf8'));

// Validate actual JsonUtility output against the application's exact parser as well.
const { parseWallMountDefinition, parseLocalBounds, placeWallMounts, wallMountIssues, DEFAULT_WALL_SETTINGS, NEW_WALL_SETTINGS, reapplyWallRuns } = await tsImport('../src/shared/wall-mounts.ts', import.meta.url);
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
const { buildManifest, DEFAULT_SETTINGS } = await tsImport('../src/shared/map.ts', import.meta.url);
const terrainGuids = JSON.parse(await readFile(resolve(local, 'wall-terrain-validation.json'), 'utf8'));
const terrain = Object.entries(terrainGuids).map(([role, prefabGuid]) => ({ id: `terrain-${role}`, label: role, role, prefabGuid,
  prefabPath: `Assets/BaekhoWallValidation/Terrain${role[0].toUpperCase()}${role.slice(1)}.prefab`,
  scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));
terrain.push({ ...terrain.find(binding => binding.role === 'wall'), id: 'terrain-stair', label: 'stair', role: 'stair', stairNativeRise: 1 });
const allBindings = [...terrain, ...bindings], cases = [];
const writeScenario = async (name, map, checks, clearPoints = [], extra = {}) => {
  const assetPath = `Assets/BaekhoWallValidation/generated-${name}.baekhomap.json`;
  const manifest = buildManifest({ ...map, name: `Generated ${name}` }, allBindings);
  await writeFile(resolve(project, assetPath), JSON.stringify(manifest));
  cases.push({ manifest: assetPath, checks, clearPoints, ...extra }); return manifest;
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

const socketMate = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) < 1e-5 && a.direction.x * b.direction.x + a.direction.y * b.direction.y + a.direction.z * b.direction.z < -.99999;
const networksFor = map => [...new Set(map.fixtures.filter(f => f.wall?.runId).map(f => f.wall.runId))].map(runId => {
  const group = map.fixtures.filter(f => f.wall?.runId === runId), cap = group.find(f => f.wall.sockets.length === 1 && /start/.test(f.id)) ?? group.find(f => f.wall.sockets.length === 1), order = [cap], used = new Set([cap]);
  while (order.length < group.length) { const last = order.at(-1), next = group.find(f => !used.has(f) && last.wall.sockets.some(s => f.wall.sockets.some(t => socketMate(s, t)))); if (!next) break; used.add(next); order.push(next); }
  const horizontal = order.filter(f => bindings.find(b => b.id === f.bindingId)?.wallMount?.kind === 'straight' && f.wall.sockets.every(s => Math.abs(s.direction.y) < .001));
  const levels = new Set(horizontal.map(f => Number(f.wall.sockets[0].position.y.toFixed(4))));
  for (const f of group) for (const socket of f.wall.sockets) assert.equal(group.filter(g => g !== f && g.wall.sockets.some(t => socketMate(socket, t))).length, 1, 'native composed socket has exactly one mate');
  return { objectNames: group.map(f => `${f.role}_fixture-${f.id}`), startObject: `${cap.role}_fixture-${cap.id}`, corner: group.some(f => f.wall.site === 'corner'), multipleHeights: levels.size >= 2, rise: levels.size >= 2 ? Math.sign(horizontal.at(-1).wall.sockets[0].position.y - horizontal[0].wall.sockets[0].position.y) : 0 };
});
const largeRoom = () => {
  const map = room(); map.width = 14; map.height = 10; map.rows = ['######D#######', ...Array(8).fill('#............#'), '##############']; map.elevations = Array.from({ length: 10 }, () => Array(14).fill(0));
  map.connections = [{ id: 'entry', label: 'Entry', x: 6, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }]; return map;
};
const composedSettings = (seed, patch = {}) => ({ ...DEFAULT_SETTINGS, width: 14, height: 10, seed, designer: { wallMounts: { ...NEW_WALL_SETTINGS, enabled: true, singles: false, placeholderFallback: false, ...patch } } });
const directions = new Set();
for (let seed = 0; seed < 16; seed++) {
  const generated = placeWallMounts(largeRoom(), composedSettings(seed), bindings), networks = networksFor(generated.map);
  assert.ok(networks.some(n => n.corner && n.multipleHeights), 'actual native mixed-length kit continues stepped main route around a corner');
  networks.filter(n => n.multipleHeights).forEach(n => directions.add(n.rise)); assert.deepEqual(wallMountIssues(generated.map, bindings), []);
  assert.deepEqual(placeWallMounts(generated.map, composedSettings(seed), bindings).map, generated.map); assert.equal(reapplyWallRuns(generated.map, composedSettings(seed), bindings).unchanged, true);
  await writeScenario(`composed-${seed}`, generated.map, fixtureChecks(generated.map, 0, 4), [], { networks });
  if (directions.size === 2 && seed >= 2) break;
}
assert.deepEqual(directions, new Set([-1, 1]), 'actual native catalog supports both rising and descending composed transitions');
const parallel = placeWallMounts(largeRoom(), composedSettings(17, { runDensity: 100 }), bindings), parallelNetworks = networksFor(parallel.map);
assert.ok(parallelNetworks.length >= 2 && parallelNetworks.slice(0, 2).every(n => n.corner && n.multipleHeights), 'native high-density paired corridors share corners and height rhythm');
await writeScenario('composed-parallel', parallel.map, fixtureChecks(parallel.map, 0, 4), [], { networks: parallelNetworks, parallel: true });
for (const [label, policy, low, high] of [
  ['composed-fixed', { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 }, 1.25, 1.25],
  ['composed-range', { mode: 'random', reference: 'floor', min: .5, max: 3.5 }, .5, 3.5],
]) {
  const generated = placeWallMounts(largeRoom(), composedSettings(19, { runHeight: policy }), bindings); assert.ok(generated.addedModules > 0); assert.deepEqual(wallMountIssues(generated.map, bindings), []);
  await writeScenario(label, generated.map, fixtureChecks(generated.map, low, high), [], { networks: networksFor(generated.map) });
}
const missingElbowKit = bindings.filter(b => b.wallMount?.kind !== 'elbow'), fallback = placeWallMounts(largeRoom(), composedSettings(17), missingElbowKit);
assert.ok(fallback.addedModules > 0 && fallback.issues.some(i => i.code === 'wall-composition-height-fit')); assert.deepEqual(wallMountIssues(fallback.map, missingElbowKit), []);
await writeScenario('composed-missing-elbow', fallback.map, fixtureChecks(fallback.map, 0, 4), [], { networks: networksFor(fallback.map) });
assert.equal(placeWallMounts(largeRoom(), composedSettings(17), bindings.filter(b => b.wallMount?.kind !== 'endCap')).addedModules, 0, 'no open native runs are exported when caps are missing');
const { insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
bindings.find(b => b.id === 'Legacy').prop = { category: 'equipment', size: { x: 1, y: 2, z: 3 }, tags: [], placement: 'floor', blocksMovement: true, weight: 1, roomTypes: ['battle'] };
const obstructed = insertPropInstance(largeRoom(), { x: 8, row: 1 }, 'Legacy', composedSettings(17), bindings); obstructed.propInstances[0].id = 'equipment';
const dodged = placeWallMounts(obstructed, composedSettings(17), bindings); assert.ok(dodged.addedModules > 0); assert.deepEqual(wallMountIssues(dodged.map, bindings), []);
await writeScenario('composed-equipment', dodged.map, fixtureChecks(dodged.map, 0, 4), [], { networks: networksFor(dodged.map), obstacles: ['decoration_prop-instance-equipment'] });
console.log(`PASS composed actual native kit: mixed 1m/2m routes, corners, ${[...directions].join('/')} transitions, paired parallel rails, fixed/range constraints, missing-parts fallback and equipment clearance`);
await writeFile(resolve(local, 'wall-generated-expectations.json'), JSON.stringify({ cases }));
await runEditor(false, 'RunGeneratedManifest');
console.log(await readFile(resolve(local, 'wall-generated-validation-result.txt'), 'utf8'));

if (visualProjects.every(p => p.value)) {
  const visualCatalog = JSON.parse(await readFile(resolve(local, 'wall-visual-catalog.json'), 'utf8').catch(async () => { await runEditor(false, 'PrepareVisualComparison'); return readFile(resolve(local, 'wall-visual-catalog.json'), 'utf8'); }));
  const captures = [];
  for (const { phase, value } of visualProjects) {
    let map = structuredClone(value.map);
    const props = value.bindings.filter(b => b.prop).map(b => { const native = visualCatalog.assets.find(asset => asset.id === b.id); assert.ok(native); return { ...b, prefabGuid: native.guid, prefabPath: native.path }; });
    const visualBindings = [...terrain, ...bindings, ...props];
    for (const [kind, bindingId] of [['pipeStraight', 'Pipe1'], ['pipeInnerCorner', 'Inner'], ['pipeOuterCorner', 'Outer'], ['pipeEndCap', 'Cap'], ['pipeElbow', 'Elbow'], ['pipeTee', 'Tee']]) if (map.fixtures?.some(f => f.wall?.placeholder === kind)) map = replaceWallPlaceholders(map, kind, bindingId, visualBindings).map;
    assert.deepEqual(wallMountIssues(map, visualBindings), []);
    const assetPath = `Assets/BaekhoWallValidation/visual-${phase}.baekhomap.json`, manifest = buildManifest(map, visualBindings);
    await writeFile(resolve(project, assetPath), JSON.stringify(manifest));
    const door = map.connections[0], across = door.direction === 0 || door.direction === 180;
    const eye = { x: (door.x - (map.width - 1) / 2) * map.cellSize + (across ? (door.width - map.cellSize) / 2 : 0), y: 1.7, z: ((map.height - 1) / 2 - door.row) * map.cellSize - (!across ? (door.width - map.cellSize) / 2 : 0) };
    const inward = { 0: [0, -1], 90: [-1, 0], 180: [0, 1], 270: [1, 0] }[door.direction]; eye.x += inward[0] * map.cellSize * .65; eye.z += inward[1] * map.cellSize * .65;
    captures.push({ phase, manifest: assetPath, eye, target: { x: 0, y: 1.6, z: 0 }, topSize: Math.max(map.height * map.cellSize / 2 + 1, map.width * map.cellSize / 2 / (1600 / 1100) + 1) });
  }
  assert.deepEqual(captures[0].eye, captures[1].eye); assert.equal(captures[0].topSize, captures[1].topSize);
  await writeFile(resolve(local, 'wall-visual-expectations.json'), JSON.stringify({ cases: captures }));
  await runEditor(false, 'RunVisualComparison', true);
  console.log(await readFile(resolve(local, 'composition-visual/unity-result.txt'), 'utf8'));
}
