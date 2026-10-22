import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, editWallMount, parseWallMountDefinition, parseWallMountInstance, placeWallMounts, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding } from '../src/shared/wall-placeholders';
import { replaceWallPlaceholders } from '../src/shared/wall-replacement';
import type { AssetBinding, GridMap, WallMountSettings } from '../src/shared/types';

function room(): GridMap { return { version: 5, name: 'Vertical pipe room', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows: ['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 100, runOrientation: 'vertical', connectRuns: false, ...patch });
function kit(length = 1): AssetBinding[] {
  const pipe = placeholderWallBinding('pipeStraight'), cap = placeholderWallBinding('pipeEndCap');
  for (const [i, b] of [pipe, cap].entries()) { b.id = `real-${i}`; b.prefabGuid = 'a'.repeat(32); b.prefabPath = `Assets/${b.id}.prefab`; b.wallMount!.family = 'RealPipe'; }
  pipe.bounds!.size.x = length; pipe.wallMount!.sockets[0].position.x = -length / 2; pipe.wallMount!.sockets[1].position.x = length / 2;
  // The native source pivot is deliberately unrelated to the mesh or mount center.
  for (const b of [pipe, cap]) { b.bounds!.center.x += 2.5; b.bounds!.center.y += .25; b.bounds!.center.z -= 1.3; for (const c of [...b.wallMount!.mounts, ...b.wallMount!.sockets]) { c.position.x += 2.5; c.position.y += .25; c.position.z -= 1.3; } }
  return [pipe, cap];
}

test('vertical placeholder chains use native length, vertical sockets and closed caps on all four wall directions', () => {
  const source = room(), placed = placeWallMounts(source, settings(), []); assert.equal(source.fixtures, undefined); assert.equal(placed.runCount, 24); assert.equal(placed.addedModules, 120); assert.deepEqual(wallMountIssues(placed.map, []), []);
  assert.deepEqual(new Set(placed.map.fixtures!.map(f => f.wall!.support[0].direction)), new Set([0, 90, 180, 270]));
  for (const f of placed.map.fixtures!) { assert.ok([90, 270].includes(f.wall!.rotationZ!)); assert.ok(f.wall!.sockets.every(s => Math.abs(s.direction.y) > .99999)); assert.ok(f.wall!.bounds.every(b => b.center.y - b.size.y / 2 >= 0 && b.center.y + b.size.y / 2 <= 4)); assert.deepEqual(parseWallMountInstance(f.wall, 8, 8), f.wall); }
  for (const runId of new Set(placed.map.fixtures!.map(f => f.wall!.runId))) assert.equal(placed.map.fixtures!.filter(f => f.wall!.runId === runId && f.wall!.placeholder === 'pipeEndCap').length, 2);
  const repeat = placeWallMounts(placed.map, settings(), []); assert.equal(repeat.unchanged, true); assert.deepEqual(repeat.map, placed.map);
});

test('missing orientation preserves horizontal generation exactly and both orientations coexist without crossing', () => {
  const legacy = settings(); delete legacy.runOrientation;
  assert.deepEqual(placeWallMounts(room(), legacy, []).map, placeWallMounts(room(), settings({ runOrientation: 'horizontal' }), []).map);
  const both = placeWallMounts(room(), settings({ runOrientation: 'both' }), []); assert.ok(both.map.fixtures!.some(f => !f.wall!.rotationZ)); assert.ok(both.map.fixtures!.some(f => f.wall!.rotationZ)); assert.deepEqual(wallMountIssues(both.map, []), []);
  const verticalFirst = placeWallMounts(room(), settings(), []).map, extended = placeWallMounts(verticalFirst, settings({ runOrientation: 'both' }), []); assert.ok(extended.map.fixtures!.some(f => !f.wall!.rotationZ)); assert.deepEqual(wallMountIssues(extended.map, []), []);
  const sparse = placeWallMounts(room(), settings({ runDensity: 10 }), []); assert.ok(sparse.runCount < both.runCount); assert.equal(sparse.runCount, 3);
});

test('actual off-center prefab pivots and nonuniform native scale work in every upright direction', () => {
  const bindings = kit(); bindings[0].scale = { x: 1.2, y: 1.5, z: 1 };
  const placed = placeWallMounts(room(), settings({ placeholderFallback: false }), bindings); assert.equal(placed.runCount, 24); assert.deepEqual(wallMountIssues(placed.map, bindings), []);
  for (const f of placed.map.fixtures!.filter(f => f.bindingId === bindings[0].id)) { assert.ok(Math.abs(f.wall!.bounds[0].size.y - 1.2) < 1e-5); assert.ok(Math.abs(Math.abs(f.wall!.sockets[0].position.y - f.wall!.sockets[1].position.y) - 1.2) < 1e-5); }
});

test('native lengths leave capped remainder and missing caps or insufficient height skip the chain', () => {
  const bindings = kit(2), placed = placeWallMounts(room(), settings({ placeholderFallback: false }), bindings); assert.equal(placed.addedModules, 72); assert.deepEqual(wallMountIssues(placed.map, bindings), []);
  const noCaps = placeWallMounts(room(), settings({ placeholderFallback: false }), [bindings[0]]); assert.equal(noCaps.addedModules, 0); assert.ok(noCaps.issues.some(i => i.code === 'wall-vertical-fit'));
  const low = room(); low.structureSettings = { ceilingClearance: 0, fillDoorTops: false, fillHeightGaps: false, gapRole: 'wall', pitBottomKind: 'floor', pitDepth: 1, deadzoneThickness: .2, defaultWallHeight: .8 }; assert.equal(placeWallMounts(low, settings(), []).addedModules, 0);
});

test('vertical chains honor support locks, selected regions, elevated walls, ceilings and tall furniture', () => {
  const source = room(); source.lockedCells = [{ x: 2, row: 0 }];
  const region = { x: 1, row: 0, width: 4, height: 2 }, partial = placeWallMounts(source, settings(), [], region); assert.equal(partial.runCount, 3); assert.ok(partial.map.fixtures!.every(f => wallMountDependencies(f).every(c => c.x >= 1 && c.x < 5 && c.row < 2 && !(c.x === 2 && c.row === 0))));
  const blocked = room(); blocked.propInstances = [{ id: 'tall-cabinet', bindingId: 'cabinet', x: 3, row: 1, direction: 0, offset: { x: 0, y: 0, z: .5 }, cells: [{ x: 3, row: 1 }], size: { x: 1.8, y: 3.5, z: 1.8 }, blocksMovement: true, category: 'cabinet' }];
  const checked = placeWallMounts(blocked, settings(), []); assert.ok(!checked.map.fixtures!.some(f => f.wall!.support.some(s => s.x === 3 && s.row === 0))); assert.deepEqual(wallMountIssues(checked.map, []), []);
  const raised = room(); raised.elevations = raised.elevations.map(row => row.map(() => 2)); raised.ceilings = [{ x: 3, row: 1, undersideY: 4.5 }]; const elevated = placeWallMounts(raised, settings(), []); assert.ok(elevated.map.fixtures!.every(f => f.wall!.bounds.every(b => b.center.y - b.size.y / 2 >= 2))); assert.deepEqual(wallMountIssues(elevated.map, []), []);
});

test('strict parsing accepts resolved vertical sockets while native module authoring remains horizontal', () => {
  const f = placeWallMounts(room(), settings(), []).map.fixtures!.find(f => f.wall!.placeholder === 'pipeStraight')!;
  for (const rotationZ of [45, 180, NaN]) assert.throws(() => parseWallMountInstance({ ...f.wall, rotationZ }, 8, 8));
  assert.throws(() => parseWallMountInstance({ ...f.wall, rotationY: 45 }, 8, 8));
  assert.throws(() => parseWallMountInstance({ ...f.wall, rotationZ: 0 }, 8, 8)); assert.throws(() => parseWallMountInstance({ ...f.wall, placeholder: 'pipeInnerCorner' }, 8, 8));
  const b = placeholderWallBinding('pipeStraight'); b.wallMount!.sockets[0].direction = { x: 0, y: 1, z: 0 }; assert.throws(() => parseWallMountDefinition(b.wallMount));
});

test('vertical group edits and deletion preserve orientation, supports and correctly rolled end caps', () => {
  const placed = placeWallMounts(room(), settings({ runDensity: 1 }), []).map, pipes = placed.fixtures!.filter(f => f.wall!.placeholder === 'pipeStraight').sort((a, b) => a.wall!.position.y - b.wall!.position.y), target = pipes[1];
  const moved = editWallMount(placed, target.id, { height: .1, along: .2 }, []); assert.deepEqual(wallMountIssues(moved, []), []); assert.ok(moved.fixtures!.every(f => f.wall!.rotationZ));
  const edited = editWallMount(placed, target.id, { remove: true }, []); assert.equal(edited.fixtures!.filter(f => f.wall!.placeholder === 'pipeEndCap').length, 4); assert.equal(new Set(edited.fixtures!.map(f => f.wall!.runId)).size, 2); assert.deepEqual(wallMountIssues(edited, []), []); assert.ok(edited.fixtures!.every(f => f.wall!.rotationZ));
  const locked = structuredClone(placed); locked.lockedCells = [target.wall!.support[0]]; assert.throws(() => editWallMount(locked, target.id, { height: .1 }, []), /잠긴/);
});

test('vertical placeholder replacement preserves every socket and native pivot through a complete real family', () => {
  let map = placeWallMounts(room(), settings({ runDensity: 1 }), []).map; const original = structuredClone(map), bindings = kit();
  for (const f of original.fixtures!) { const binding = bindings[f.wall!.placeholder === 'pipeStraight' ? 0 : 1]; map = editWallMount(map, f.id, { bindingId: binding.id }, bindings); }
  assert.ok(map.fixtures!.every(f => !f.wall!.placeholder && f.wall!.rotationZ)); assert.deepEqual(wallMountIssues(map, bindings), []);
  for (const f of map.fixtures!) for (const s of f.wall!.sockets) assert.ok(original.fixtures!.find(g => g.id === f.id)!.wall!.sockets.some(o => Math.hypot(o.position.x - s.position.x, o.position.y - s.position.y, o.position.z - s.position.z) < 1e-5 && Math.hypot(o.direction.x - s.direction.x, o.direction.y - s.direction.y, o.direction.z - s.direction.z) < 1e-5));
  const incompatible = kit(2), target = original.fixtures!.find(f => f.wall!.placeholder === 'pipeStraight')!; assert.throws(() => editWallMount(original, target.id, { bindingId: incompatible[0].id }, incompatible), /연결점/); assert.deepEqual(original, placeWallMounts(room(), settings({ runDensity: 1 }), []).map);
});

test('individual and bulk replacements preserve the existing yaw and roll whenever native socket geometry permits it', () => {
  const source = placeWallMounts(room(), settings({ runDensity: 20 }), []).map, bindings = kit();
  const target = source.fixtures!.find(f => f.wall!.placeholder === 'pipeStraight')!, single = editWallMount(source, target.id, { bindingId: bindings[0].id }, bindings).fixtures!.find(f => f.id === target.id)!;
  assert.equal(single.wall!.rotationY, target.wall!.rotationY); assert.equal(single.wall!.rotationZ, target.wall!.rotationZ);
  let map = replaceWallPlaceholders(source, 'pipeStraight', bindings[0].id, bindings).map;
  map = replaceWallPlaceholders(map, 'pipeEndCap', bindings[1].id, bindings).map;
  for (const f of map.fixtures!) { const previous = source.fixtures!.find(g => g.id === f.id)!; assert.equal(f.wall!.rotationY, previous.wall!.rotationY); assert.equal(f.wall!.rotationZ, previous.wall!.rotationZ); }
  assert.deepEqual(wallMountIssues(map, bindings), []);
});

test('a natively reversed end cap may change roll when that is required to preserve its existing socket and body', () => {
  const source = placeWallMounts(room(), settings({ runDensity: 1 }), []).map, bindings = kit(), cap = bindings[1];
  cap.bounds!.center.x = 5 - cap.bounds!.center.x; cap.wallMount!.sockets[0].direction.x *= -1;
  const target = source.fixtures!.find(f => f.wall!.placeholder === 'pipeEndCap')!, map = editWallMount(source, target.id, { bindingId: cap.id }, bindings), replaced = map.fixtures!.find(f => f.id === target.id)!;
  assert.equal(replaced.wall!.rotationY, target.wall!.rotationY); assert.notEqual(replaced.wall!.rotationZ, target.wall!.rotationZ);
  const previous = target.wall!.bounds[0], next = replaced.wall!.bounds[0]; assert.ok(Math.hypot(previous.center.x - next.center.x, previous.center.y - next.center.y, previous.center.z - next.center.z) < 1e-5); assert.deepEqual(wallMountIssues(map, bindings), []);
});
