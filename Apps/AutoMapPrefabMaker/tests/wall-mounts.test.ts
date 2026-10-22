import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, defaultWallMount, editWallMount, insertWallMount, parseLocalBounds, parseWallMountDefinition, parseWallMountInstance, placeWallMounts, synchronizeWallMounts, wallMountIssues } from '../src/shared/wall-mounts';
import type { AssetBinding, GridMap, LocalBounds, Vec3, WallConnector, WallMountSettings } from '../src/shared/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const socket = (x: number, z: number, dx: number, dz: number): WallConnector => ({ position: v(x, 0, z), direction: v(dx, 0, dz) });
const box = (center: Vec3, size: Vec3): LocalBounds => ({ center, size });
const settings = (changes: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, density: 100, runDensity: 100, ...changes });
function room(): GridMap { return { version: 5, name: 'Mounted fixtures', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows: ['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
function binding(id = 'sconce'): AssetBinding {
  const b: AssetBinding = { id, label: id, role: 'light', prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: v(1, 1, 1), offset: v(0, 0, 0), rotationY: 0, bounds: box(v(0, 0, .1), v(.4, .3, .2)) };
  b.wallMount = { ...defaultWallMount(b), spacing: .05, heightMode: 'top', height: .5 }; return b;
}
function kit(length = 1): AssetBinding[] {
  const straight = binding('pipe'); straight.role = 'decoration'; straight.bounds = box(v(0, 0, .1), v(length, .1, .2));
  straight.wallMount = { ...defaultWallMount(straight), kind: 'straight', family: 'steel', heightMode: 'top', height: .5, mounts: [socket(0, 0, 0, 1)], sockets: [socket(-length / 2, .1, -1, 0), socket(length / 2, .1, 1, 0)] };
  const corner = binding('inner'); corner.role = 'decoration'; corner.bounds = box(v(-.25, 0, .25), v(.5, .1, .5));
  corner.wallMount = { ...straight.wallMount, kind: 'innerCorner', mounts: [socket(-.3, 0, 0, 1), socket(0, .3, -1, 0)], sockets: [socket(-.5, .1, -1, 0), socket(-.1, .5, 0, 1)], collisionBoxes: [box(v(-.3, 0, .1), v(.4, .1, .2)), box(v(-.1, 0, .3), v(.2, .1, .4))] };
  const cap = binding('cap'); cap.role = 'decoration'; cap.bounds = box(v(.05, 0, 0), v(.1, .1, .2));
  cap.wallMount = { ...straight.wallMount, kind: 'endCap', mounts: [], sockets: [socket(0, 0, -1, 0)] };
  return [straight, corner, cap];
}

test('bounds and wall metadata parsers reject invalid, duplicate and incomplete records', () => {
  const b = binding(); assert.deepEqual(parseWallMountDefinition(b.wallMount), b.wallMount);
  assert.throws(() => parseLocalBounds({ center: v(0, 0, 0), size: v(1, -1, 1) }));
  assert.throws(() => parseWallMountDefinition({ ...b.wallMount, sites: ['wall', 'wall'] }));
  assert.throws(() => parseWallMountDefinition({ ...b.wallMount, kind: 'straight', family: 'pipes' }));
  assert.throws(() => parseWallMountDefinition({ ...b.wallMount, mounts: [socket(0, 0, 0, 0)] }));
  const f = placeWallMounts(room(), settings({ runs: false }), [b]).map.fixtures![0];
  assert.deepEqual(parseWallMountInstance(f.wall, 8, 8), f.wall);
  assert.throws(() => parseWallMountInstance({ ...f.wall, support: [...f.wall!.support, f.wall!.support[0]] }, 8, 8));
});

test('four wall orientations preserve original off-center pivots, measurements and fixed scale', () => {
  const b = binding(); b.bounds = box(v(.8, .2, 1.1), v(.4, .3, .2)); b.scale = v(1.5, 2, 1.2); b.wallMount = { ...defaultWallMount(b), heightMode: 'top', height: .5, spacing: .05 };
  const source = room(), before = structuredClone(source), result = placeWallMounts(source, settings({ runs: false }), [b]);
  assert.deepEqual(source, before); assert.ok(result.addedSingles >= 20);
  assert.deepEqual(new Set(result.map.fixtures!.map(f => f.wall!.support[0].direction)), new Set([0, 90, 180, 270]));
  assert.deepEqual(wallMountIssues(result.map, [b]), []);
  for (const f of result.map.fixtures!) { assert.ok(Math.abs(f.wall!.bounds[0].center.y - 3.5) < 1e-6); assert.ok(Math.abs(f.wall!.bounds[0].size.y - .6) < 1e-6); }
  const repeat = placeWallMounts(result.map, settings({ runs: false }), [b]); assert.equal(repeat.unchanged, true); assert.equal(repeat.addedSingles, 0);
  assert.deepEqual(placeWallMounts(source, settings({ runs: false }), [b]).map, result.map);
});

test('unmeasured bindings never invent placement geometry', () => {
  const b = binding(); delete b.bounds;
  const result = placeWallMounts(room(), settings({ runs: false }), [b]); assert.equal(result.addedSingles, 0); assert.ok(result.issues.some(i => i.code === 'wall-unmeasured'));
  assert.throws(() => insertWallMount(room(), { x: 1, row: 0 }, b.id, [b]));
});

test('mounted fixtures coexist above floor furniture but actual height intersections are rejected', () => {
  const map = room(), b = binding(), point = { x: 1, row: 1 };
  map.propInstances = [{ ...point, id: 'cabinet', bindingId: 'cabinet', direction: 0, offset: v(0, 0, 0), cells: [point], size: v(1.8, 1, 1.8), blocksMovement: true, category: 'cabinet' }];
  const above = insertWallMount(map, { x: 1, row: 0 }, b.id, [b]); assert.equal(above.fixtures!.length, 1); assert.deepEqual(wallMountIssues(above, [b]), []);
  b.wallMount!.heightMode = 'floor'; b.wallMount!.height = .8;
  assert.throws(() => insertWallMount(map, { x: 1, row: 0 }, b.id, [b]), /부족/);
});

test('door top fixtures center over actual wide door fills and follow door position/height edits', () => {
  const map = room(), b = binding('exit-light'); b.wallMount!.sites = ['doorTop']; b.wallMount!.heightMode = 'floor'; b.wallMount!.height = .25;
  map.rows[0] = '##DD####'; map.connections = [{ id: 'north', label: 'North', x: 2, row: 0, direction: 0, width: 4, height: 3, kind: 'door' }];
  map.structureFills = [2, 3].map(x => ({ id: `top-${x}`, x, row: 0, role: 'wall', purpose: 'doorTop', direction: 0, position: v((x - 3.5) * 2, 3.5, 7), size: v(2, 1, 2) }));
  const first = placeWallMounts(map, settings({ runs: false }), [b]); assert.equal(first.addedSingles, 1);
  const f = first.map.fixtures![0]; assert.equal(f.wall!.position.x, -2); assert.equal(f.wall!.position.y, 3.25); assert.equal(f.wall!.support.length, 2); assert.deepEqual(wallMountIssues(first.map, [b]), []);
  const edited = structuredClone(first.map); edited.connections[0].x += 1; edited.connections[0].height += .5;
  const moved = synchronizeWallMounts(edited).fixtures![0]; assert.ok(Math.abs(moved.wall!.position.x - f.wall!.position.x - 2) < 1e-6); assert.ok(Math.abs(moved.wall!.position.y - f.wall!.position.y - .5) < 1e-6);
  const removed = structuredClone(first.map); removed.connections = []; assert.equal(synchronizeWallMounts(removed).fixtures!.length, 0);
  map.structureFills = []; assert.equal(placeWallMounts(map, settings({ runs: false }), [b]).addedSingles, 0);
});

test('door side supports left/right separately and refuses unsupported wall sides', () => {
  const map = room(), b = binding('card-reader'); b.wallMount!.sites = ['doorSide']; b.wallMount!.doorSide = 'both';
  map.rows[0] = '###D####'; map.connections = [{ id: 'north', label: 'North', x: 3, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }];
  const result = placeWallMounts(map, settings({ runs: false }), [b]); assert.equal(result.addedSingles, 2);
  assert.deepEqual(new Set(result.map.fixtures!.map(f => f.wall!.doorSide)), new Set(['left', 'right'])); assert.deepEqual(wallMountIssues(result.map, [b]), []);
});

test('locked support/floor cells and incomplete selected regions protect wall fixtures', () => {
  const map = room(), b = binding(); map.lockedCells = [{ x: 2, row: 0 }, { x: 3, row: 1 }];
  const result = placeWallMounts(map, settings({ runs: false }), [b], { x: 1, row: 0, width: 4, height: 2 });
  assert.equal(result.addedSingles, 2); assert.ok(result.map.fixtures!.every(f => f.wall!.support[0].row === 0 && [1, 4].includes(f.wall!.support[0].x)));
  const f = result.map.fixtures![0]; result.map.lockedCells!.push(f.wall!.support[0]); assert.throws(() => editWallMount(result.map, f.id, { height: .1 }, [b]), /잠긴/);
});

test('a measured modular kit genuinely connects around four corners without stretching or open sockets', () => {
  const bindings = kit(), result = placeWallMounts(room(), settings({ singles: false }), bindings);
  assert.ok(result.addedModules > 30, JSON.stringify(result.issues)); assert.equal(result.runCount, 1);
  assert.equal(result.map.fixtures!.filter(f => f.bindingId === 'inner').length, 4); assert.equal(result.map.fixtures!.filter(f => f.bindingId === 'cap').length, 0);
  assert.deepEqual(wallMountIssues(result.map, bindings), []);
  for (const f of result.map.fixtures!.filter(f => f.bindingId === 'pipe')) assert.ok(Math.abs(Math.hypot(f.wall!.sockets[1].position.x - f.wall!.sockets[0].position.x, f.wall!.sockets[1].position.z - f.wall!.sockets[0].position.z) - 1) < 1e-6);
  const repeat = placeWallMounts(result.map, settings({ singles: false }), bindings); assert.equal(repeat.unchanged, true); assert.equal(repeat.addedModules, 0);
});

test('unmatched native straight lengths create capped gaps and never disconnected pseudo-loops', () => {
  const bindings = kit(2), result = placeWallMounts(room(), settings({ singles: false }), bindings);
  assert.ok(result.addedModules > 0, JSON.stringify(result.issues)); assert.ok(result.issues.some(i => i.code === 'wall-run-length'));
  assert.ok(result.map.fixtures!.some(f => f.bindingId === 'cap')); assert.deepEqual(wallMountIssues(result.map, bindings), []);
});

test('missing corner/cap pieces split safely and never export unfinished runs', () => {
  const [straight, , cap] = kit();
  const split = placeWallMounts(room(), settings({ singles: false }), [straight, cap]); assert.ok(split.addedModules > 0); assert.ok(split.issues.some(i => i.code === 'wall-run-corner')); assert.equal(split.runCount, 4); assert.deepEqual(wallMountIssues(split.map, [straight, cap]), []);
  const skipped = placeWallMounts(room(), settings({ singles: false }), [straight]); assert.equal(skipped.addedModules, 0); assert.ok(skipped.issues.some(i => i.code === 'wall-run-cap'));
});

test('connected edits preserve sockets; deleting a module recaps each remaining arm atomically', () => {
  const bindings = kit(), placed = placeWallMounts(room(), settings({ singles: false }), bindings).map;
  const straight = placed.fixtures!.find(f => f.bindingId === 'pipe')!;
  const moved = editWallMount(placed, straight.id, { height: -.2 }, bindings); assert.ok(moved.fixtures!.every(f => Math.abs(f.wall!.position.y - 3.3) < 1e-6)); assert.deepEqual(wallMountIssues(moved, bindings), []);
  const removed = editWallMount(placed, straight.id, { remove: true }, bindings); assert.equal(removed.fixtures!.some(f => f.id === straight.id), false); assert.equal(removed.fixtures!.filter(f => f.bindingId === 'cap').length, 2); assert.deepEqual(wallMountIssues(removed, bindings), []);
  assert.throws(() => editWallMount(placed, straight.id, { remove: true }, bindings.filter(b => b.id !== 'cap')), /끝마감/); assert.equal(placed.fixtures!.some(f => f.id === straight.id), true);
});

test('changed prefab geometry is reported before export; incompatible connected swaps reject atomically', () => {
  const bindings = kit(), placed = placeWallMounts(room(), settings({ singles: false }), bindings).map, straight = placed.fixtures!.find(f => f.bindingId === 'pipe')!;
  const altered = structuredClone(bindings); altered[0].scale.x = 2;
  assert.ok(wallMountIssues(placed, altered).some(i => i.code === 'wall-measurement'));
  const alternate = structuredClone(bindings[0]); alternate.id = 'wide'; alternate.scale.x = 2;
  assert.throws(() => editWallMount(placed, straight.id, { bindingId: alternate.id }, [...bindings, alternate]), /연결점/);
});

test('outer corner modules wrap an interior pillar and connect every native socket', () => {
  const map = room(); map.rows[3] = '#..#...#';
  const bindings = kit(), outer = binding('outer'); outer.role = 'decoration'; outer.bounds = box(v(-.15, 0, -.15), v(.7, .1, .7));
  outer.wallMount = { ...bindings[1].wallMount!, kind: 'outerCorner', mounts: [socket(-.3, 0, 0, 1), socket(0, -.3, 1, 0)], sockets: [socket(-.5, .1, -1, 0), socket(.1, -.5, 0, -1)], collisionBoxes: [box(v(-.2, 0, .1), v(.6, .1, .2)), box(v(.1, 0, -.2), v(.2, .1, .6))] };
  bindings.push(outer);
  const result = placeWallMounts(map, settings({ singles: false }), bindings);
  assert.equal(result.map.fixtures!.filter(f => f.bindingId === 'outer').length, 4, JSON.stringify(result.issues)); assert.equal(result.runCount, 2); assert.deepEqual(wallMountIssues(result.map, bindings), []);
});

test('corner-mounted single fixtures use two measured perpendicular wall mounts', () => {
  const b = kit()[1]; b.id = 'corner-lamp'; b.role = 'light'; b.wallMount = { ...b.wallMount!, kind: 'single', family: '', sites: ['corner'], sockets: [] };
  const result = placeWallMounts(room(), settings({ runs: false }), [b]); assert.equal(result.addedSingles, 4); assert.ok(result.map.fixtures!.every(f => f.wall!.support.length === 2)); assert.deepEqual(wallMountIssues(result.map, [b]), []);
  const manual = insertWallMount(room(), { x: 1, row: 0 }, b.id, [b]); assert.equal(manual.fixtures!.length, 1); assert.deepEqual(wallMountIssues(manual, [b]), []);
});

test('door synchronization refuses locked moves and removal of referenced fixtures', () => {
  const map = room(), b = binding(); b.wallMount!.sites = ['doorSide']; b.wallMount!.doorSide = 'left'; map.rows[0] = '###D####'; map.connections = [{ id: 'north', label: 'North', x: 3, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }];
  const placed = placeWallMounts(map, settings({ runs: false }), [b]).map, f = placed.fixtures![0];
  const locked = structuredClone(placed); locked.lockedCells = [{ x: f.x, row: f.row }]; locked.connections[0].height += .1; assert.throws(() => synchronizeWallMounts(locked), /잠긴/);
  const removed = structuredClone(placed); removed.connections = []; removed.fixtures!.push({ id: 'switch', x: 1, row: 1, role: 'switch', direction: 0, offset: v(0, 0, 0), linkedId: f.id }); assert.throws(() => synchronizeWallMounts(removed), /참조/);
});

test('prefab replacement realigns differing native pivots and preserves compatible run sockets', () => {
  const b = binding(), single = insertWallMount(room(), { x: 1, row: 0 }, b.id, [b]), alternate = binding('other-pivot');
  alternate.bounds!.center = v(4, .5, -2); alternate.wallMount = { ...defaultWallMount(alternate), heightMode: 'top', height: .5 };
  const changed = editWallMount(single, single.fixtures![0].id, { bindingId: alternate.id }, [b, alternate]); assert.deepEqual(wallMountIssues(changed, [b, alternate]), []); assert.ok(Math.abs(changed.fixtures![0].wall!.bounds[0].center.y - single.fixtures![0].wall!.bounds[0].center.y) < 1e-6);
  const bindings = kit(), placed = placeWallMounts(room(), settings({ singles: false }), bindings).map, pipe = placed.fixtures!.find(f => f.bindingId === 'pipe')!, shifted = structuredClone(bindings[0]); shifted.id = 'pipe-shifted';
  shifted.bounds!.center.x += 5; shifted.wallMount!.mounts.forEach(m => m.position.x += 5); shifted.wallMount!.sockets.forEach(s => s.position.x += 5);
  const replaced = editWallMount(placed, pipe.id, { bindingId: shifted.id }, [...bindings, shifted]); assert.deepEqual(wallMountIssues(replaced, [...bindings, shifted]), []);
});

test('saved prefab identity, offset and rotation references reject silent source changes', () => {
  const b = binding(), placed = insertWallMount(room(), { x: 1, row: 0 }, b.id, [b]);
  for (const mutate of [(v: AssetBinding) => v.offset.x++, (v: AssetBinding) => v.rotationY = 90, (v: AssetBinding) => v.prefabGuid = '2'.repeat(32), (v: AssetBinding) => v.prefabPath = 'Assets/changed.prefab']) { const next = structuredClone(b); mutate(next); assert.ok(wallMountIssues(placed, [next]).some(i => i.code === 'wall-measurement')); }
});
