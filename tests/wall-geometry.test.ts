import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProject, serializeProject } from '../electron/services/projects';
import { captureRegion, compareModules, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { addMapConnection, buildManifest, connectionCells, connectionPose, DEFAULT_SETTINGS, updateConnectionGeometry, validateMap } from '../src/shared/map';
import { terrainSurfaceY, wallBaseClosure, wallBaseY, wallTopY } from '../src/shared/wall-geometry';
import { DEFAULT_WALL_SETTINGS, defaultWallMount, insertWallMount, placeWallMounts, wallMountIssues } from '../src/shared/wall-mounts';
import type { AssetBinding, Cell, Direction, GridMap } from '../src/shared/types';

function room(direction: Direction = 0, width = 2, version: 4 | 5 = 4): GridMap {
  const x = direction === 270 ? 0 : direction === 90 ? 7 : 2;
  const row = direction === 0 ? 0 : direction === 180 ? 7 : 2;
  const map: GridMap = { version, name: 'Door wall support', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
    rows: ['########', ...Array(6).fill('#......#'), '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)),
    ramps: [], connections: [{ id: 'door', label: 'Door', x, row, direction, width, height: 3, kind: 'door' }], assetOverrides: [] };
  for (const c of connectionCells(map, map.connections[0])) map.rows[c.row] = map.rows[c.row].slice(0, c.x) + 'D' + map.rows[c.row].slice(c.x + 1);
  return map;
}
function adjacentWall(map: GridMap): Cell {
  const cells = connectionCells(map, map.connections[0]), last = cells.at(-1)!;
  return map.connections[0].direction % 180 === 0 ? { x: last.x + 1, row: last.row } : { x: last.x, row: last.row + 1 };
}
function binding(role: AssetBinding['role'], id: string = role): AssetBinding {
  return { id, label: id, role, prefabGuid: 'a'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 2, y: 1.5, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 };
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('old and current maps close elevated doorway walls in all directions without changing saved walls or openings', () => {
  for (const version of [4, 5] as const) for (const direction of [0, 90, 180, 270] as const) for (const width of [1.5, 2, 5.5]) {
    const source = room(direction, width, version), c = adjacentWall(source);
    source.elevations[c.row][c.x] = 2;
    source.wallHeights = [{ ...c, height: 7, heightMode: version === 5 ? 'manual' : undefined }];
    source.lockedCells = [c];
    const before = structuredClone(source), bindings = [binding('floor'), binding('wall'), binding('door')];
    const manifest = buildManifest(source, bindings), id = `wall-${c.x}-${c.row}`;
    assert.equal(manifest.schemaVersion, version);
    const wall = manifest.placements.find(p => p.id === id)!, closure = manifest.placements.find(p => p.id === `${id}-base`)!;
    assert.equal(wall.position.y, 2); assert.equal(wall.fitHeight, 7);
    assert.equal(closure.position.y, 0); assert.equal(closure.fitHeight, 2); assert.equal(closure.surface, 'bottom');
    assert.equal(closure.position.y + closure.fitHeight!, wall.position.y);
    assert.deepEqual(closure.scale, wall.scale); assert.deepEqual(closure.rotation, wall.rotation); assert.equal(closure.prefabGuid, wall.prefabGuid);
    assert.equal(manifest.placements.filter(p => p.role === 'door').length, 1);
    assert.deepEqual(manifest.connections[0].position, connectionPose(source, source.connections[0]).position);
    assert.equal(manifest.connections[0].width, width); assert.equal(manifest.connections[0].height, 3);
    assert.deepEqual(source, before);
  }
});

test('open and immediate export repair legacy native walls without adopting structures or changing native scale and height', () => {
  const map = room(), c = adjacentWall(map); map.elevations[c.row][c.x] = 3;
  const wallBinding = binding('wall'); wallBinding.rotationY = 90;
  wallBinding.bounds = { center: { x: 12, y: 9, z: -4 }, size: { x: 1, y: 5, z: 1 } };
  const project = { formatVersion: 1 as const, map, settings: { ...DEFAULT_SETTINGS, width: 8, height: 8, connectionCount: 1 }, bindings: [binding('floor'), wallBinding, binding('door')] };
  const loaded = normalizeProject(JSON.parse(serializeProject(project))), before = structuredClone(loaded);
  assert.equal(loaded.map.structureSettings, undefined); assert.deepEqual(loaded.map.wallHeights, []);
  const manifest = buildManifest(loaded.map, loaded.bindings), id = `wall-${c.x}-${c.row}`;
  const wall = manifest.placements.find(p => p.id === id)!;
  assert.equal(wall.fitHeight, undefined); assert.deepEqual(wall.scale, wallBinding.scale); assert.equal(wall.position.y, 3); assert.equal(wall.rotation.y, 90);
  assert.equal(manifest.placements.find(p => p.id === `${id}-base`)!.fitHeight, 3);
  assert.equal(wallTopY(loaded.map, c, loaded.bindings), 10.5);
  assert.deepEqual(loaded, before);
});

test('calibrated floor and wall overrides close exact physical endpoints without applying offsets twice', () => {
  const map = room(), c = adjacentWall(map); map.elevations[c.row][c.x] = 2;
  const wall = binding('wall'), overriddenWall = binding('wall', 'wall-override'), floor = binding('floor'), overriddenFloor = binding('floor', 'floor-override');
  overriddenWall.offset = { x: .2, y: .4, z: -.3 }; overriddenWall.rotationY = 90;
  floor.offset.y = .1; overriddenFloor.offset.y = -.6;
  map.assetOverrides.push({ ...c, role: 'wall', bindingId: overriddenWall.id }, { x: map.connections[0].x, row: map.connections[0].row, role: 'floor', bindingId: overriddenFloor.id });
  const bindings = [floor, overriddenFloor, wall, overriddenWall, binding('door')], span = wallBaseClosure(map, c, bindings)!;
  near(span.bottom, -.6); near(span.top, 2.4); near(span.height, 3);
  const manifest = buildManifest(map, bindings), original = manifest.placements.find(p => p.id === `wall-${c.x}-${c.row}`)!, closure = manifest.placements.find(p => p.id === `${original.id}-base`)!;
  near(closure.position.y, -.6); near(closure.position.y + closure.fitHeight!, original.position.y);
  assert.equal(closure.position.x, original.position.x); assert.equal(closure.position.z, original.position.z);
  assert.deepEqual(closure.rotation, original.rotation); assert.deepEqual(closure.scale, original.scale);
  assert.equal(closure.prefabGuid, overriddenWall.prefabGuid);
});

test('wall closures use actual neighboring terrain, never a void baseline, and leave elevated platforms unchanged', () => {
  const map = room(), c = { x: 3, row: 3 };
  map.rows = Array(8).fill('________'); map.rows[3] = '___#____'; map.elevations[3][3] = 4;
  assert.equal(wallBaseClosure(map, c), undefined); assert.equal(wallBaseY(map, c), 4);
  map.rows[2] = '___R____'; map.elevations[2][3] = 2; map.ramps = [{ x: 3, row: 2, direction: 0, rise: 3 }];
  map.rows[3] = '__B#.P__'; map.elevations[3][2] = -2; map.elevations[3][4] = 4; map.elevations[3][5] = -20;
  map.bridges = [{ x: 2, row: 3, direction: 90 }];
  const bridge = binding('bridge'); bridge.offset.y = -.25;
  const before = structuredClone(map);
  assert.equal(terrainSurfaceY(map, { x: 3, row: 2 }), 2);
  assert.equal(terrainSurfaceY(map, { x: 2, row: 3 }, [bridge]), -2.25);
  assert.equal(terrainSurfaceY(map, { x: 3, row: 4 }), undefined);
  assert.deepEqual(wallBaseClosure(map, c, [bridge]), { bottom: -2.25, top: 4, height: 6.25 });
  assert.deepEqual(map, before);
  map.elevations[3][3] = -3; assert.equal(wallBaseClosure(map, c, [bridge]), undefined);
});

test('changing wall and neighboring floor heights recomputes closures without accumulating geometry records', () => {
  const map = room(), c = adjacentWall(map), bindings = [binding('floor'), binding('wall'), binding('door')];
  map.elevations[c.row][c.x] = 2;
  const id = `wall-${c.x}-${c.row}-base`;
  assert.deepEqual(buildManifest(map, bindings), buildManifest(map, bindings));
  map.elevations[c.row][c.x] = 0;
  assert.ok(!buildManifest(map, bindings).placements.some(p => p.id === id));
  assert.equal(map.structureFills, undefined);
});

test('bound validation and immediate export allow a low wall fixture on a closure calibrated below raw floor elevation', () => {
  const map = room(0, 2, 5), c = adjacentWall(map);
  map.elevations[c.row][c.x] = 2;
  map.wallHeights = [{ ...c, height: 4, heightMode: 'manual' }];
  const floor = binding('floor'), wall = binding('wall'), panel = binding('decoration', 'low-panel');
  floor.offset.y = -.6; wall.offset.y = .4;
  panel.bounds = { center: { x: 0, y: 0, z: .05 }, size: { x: .4, y: .1, z: .1 } };
  panel.wallMount = { ...defaultWallMount(panel), heightMode: 'floor', height: .2 };
  const bindings = [floor, wall, binding('door'), panel];
  const placed = insertWallMount(map, { x: c.x, row: c.row + 1 }, panel.id, bindings), fixture = placed.fixtures![0];
  assert.ok(fixture.wall!.bounds[0].center.y < 0, 'fixture occupies the real lower wall above the offset floor');
  assert.deepEqual(wallMountIssues(placed, bindings), []);
  assert.deepEqual(validateMap(placed, bindings).filter(issue => issue.severity === 'error'), []);
  const before = structuredClone(placed), manifest = buildManifest(placed, bindings);
  const closure = manifest.placements.find(p => p.id === `wall-${c.x}-${c.row}-base`)!;
  near(closure.position.y, -.6); near(closure.position.y + closure.fitHeight!, 2.4);
  assert.deepEqual(manifest.placements.find(p => p.id === `fixture-${fixture.id}`)!.position, fixture.wall!.position);
  const regenerated = mergeGeneratedRegion(placed, structuredClone(placed), { x: 5, row: 5, width: 1, height: 1 }, undefined, bindings);
  assert.deepEqual(regenerated.fixtures, placed.fixtures);
  assert.doesNotThrow(() => updateConnectionGeometry(placed, 'door', { height: 3.5 }, bindings));
  assert.doesNotThrow(() => addMapConnection(placed, { id: 'south', label: 'South', x: 5, row: 7, direction: 180, width: 2, height: 3, kind: 'door' }, bindings));
  assert.deepEqual(placed, before);
});

test('ramp low-entrance closure covers the complete side and either landing without protruding into ramp cells', () => {
  for (const direction of [0, 90, 180, 270] as const) {
    const map = room(), c = { x: 3, row: 3 };
    map.rows = Array(8).fill('________'); map.rows[3] = '___#____'; map.rows[2] = '___R____';
    map.elevations[c.row][c.x] = 7; map.elevations[2][3] = 2;
    map.ramps = [{ x: 3, row: 2, direction, rise: 3 }];
    const floor = binding('floor'); floor.offset.y = .1;
    const closure = wallBaseClosure(map, c, [floor])!;
    near(closure.bottom, 2.1); near(closure.top, 7);
    assert.ok(closure.bottom <= map.elevations[2][3] + map.ramps[0].rise + floor.offset.y);
    assert.equal(map.rows[c.row][c.x], '#'); assert.equal(map.rows[2][3], 'R');
  }
});

test('module overlap detection includes newly closed lower wall volume', () => {
  const a = room(90), b = room(270);
  a.rows = Array(8).fill('________'); b.rows = Array(8).fill('________');
  a.connections[0] = { ...a.connections[0], x: 3, row: 3 };
  b.connections[0] = { ...b.connections[0], x: 4, row: 3 };
  a.rows[3] = '___D____'; a.rows[4] = '____#.__'; a.elevations[4][4] = 4;
  b.rows[3] = '____D___'; b.rows[4] = '____P___';
  const comparison = compareModules(a, 'door', b, 'door');
  assert.ok(comparison.issues.some(issue => issue.message.includes('겹칩니다')));
});

test('pasted pipe runs become authored while their source remains generated', () => {
  const map = placeWallMounts(room(), { ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 1, connectRuns: false }, []).map;
  assert.ok(map.fixtures!.length > 0);
  const original = structuredClone(map), snapshot = captureRegion(map, { x: 0, row: 0, width: 8, height: 8 });
  const pasted = pasteRegion(map, snapshot, { x: 0, row: 0 }, { rotate90: 1 });
  assert.ok(pasted.fixtures!.every(fixture => fixture.wall!.authored));
  assert.ok(map.fixtures!.every(fixture => !fixture.wall!.authored));
  assert.deepEqual(map, original);
});
