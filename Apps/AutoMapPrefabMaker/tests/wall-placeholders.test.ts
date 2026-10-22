import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, editWallMount, parseWallMountInstance, placeWallMounts, synchronizeWallMounts, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import type { AssetBinding, GridMap, Vec3, WallMountSettings } from '../src/shared/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, density: 100, runDensity: 100, ...patch });
function room(): GridMap { return { version: 5, name: 'Placeholder room', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows: ['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
function real(kind: typeof WALL_PLACEHOLDER_KINDS[number], id = 'real-asset'): AssetBinding { const b = placeholderWallBinding(kind); b.id = id; b.label = 'Real prefab'; b.prefabGuid = 'a'.repeat(32); b.prefabPath = `Assets/${id}.prefab`; if (b.wallMount!.kind !== 'single') b.wallMount!.family = 'real-pipe-set'; return b; }
const near = (actual: Vec3, expected: Vec3) => assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z) < 1e-5, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);

test('empty catalog produces deterministic measured wall lights, decorations and closed pipe runs without fake registered assets', () => {
  const source = room(), before = structuredClone(source), placed = placeWallMounts(source, settings(), []);
  assert.deepEqual(source, before); assert.ok(placed.addedSingles > 0); assert.ok(placed.addedModules > 0); assert.equal(placed.runCount, 1);
  assert.ok(placed.map.fixtures!.some(f => f.role === 'light')); assert.ok(placed.map.fixtures!.some(f => f.wall!.placeholder === 'wallPanel' || f.wall!.placeholder === 'vent'));
  assert.ok(placed.map.fixtures!.every(f => f.wall!.placeholder && !f.bindingId && !f.wall!.bindingReference));
  assert.deepEqual(wallMountIssues(placed.map, []), []); assert.deepEqual(wallMountIssues(placed.map), []);
  assert.deepEqual(placeWallMounts(source, settings(), []).map, placed.map);
  const repeat = placeWallMounts(placed.map, settings(), []); assert.equal(repeat.unchanged, true); assert.equal(repeat.addedSingles + repeat.addedModules, 0); assert.deepEqual(repeat.map, placed.map);
});

test('placeholder fallback is opt out and disabled generation never adds placeholders', () => {
  assert.equal(placeWallMounts(room(), settings({ placeholderFallback: false }), []).map.fixtures?.length ?? 0, 0);
  assert.equal(placeWallMounts(room(), settings({ enabled: false }), []).map.fixtures?.length ?? 0, 0);
  const legacy = settings(); delete legacy.placeholderFallback; assert.ok(placeWallMounts(room(), legacy, []).addedSingles > 0);
});

test('registered real asset IDs that resemble built-ins retain their prefab identity', () => {
  const b = real('wallPanel', 'wm-placeholder-pipeStraight'), placed = placeWallMounts(room(), settings(), [b]);
  assert.ok(placed.map.fixtures!.some(f => f.bindingId === b.id)); assert.ok(placed.map.fixtures!.filter(f => f.bindingId === b.id).every(f => !f.wall!.placeholder && f.wall!.bindingReference?.prefabGuid === b.prefabGuid)); assert.deepEqual(wallMountIssues(placed.map, [b]), []);
});

test('fallback applies separately to absent categories and does not hide unmeasured configured assets', () => {
  const b = real('wallPanel'), placed = placeWallMounts(room(), settings(), [b]);
  assert.ok(placed.map.fixtures!.some(f => f.bindingId === b.id));
  assert.ok(placed.map.fixtures!.filter(f => !f.wall!.runId).every(f => !f.wall!.placeholder));
  assert.ok(placed.map.fixtures!.filter(f => f.wall!.runId).every(f => f.wall!.placeholder?.startsWith('pipe')));
  delete b.bounds;
  const unmeasured = placeWallMounts(room(), settings({ runs: false }), [b]); assert.equal(unmeasured.addedSingles, 0); assert.ok(unmeasured.issues.some(i => i.code === 'wall-unmeasured'));
  const pipe = real('pipeStraight'); const reverse = placeWallMounts(room(), settings(), [pipe]); assert.ok(reverse.addedSingles > 0); assert.equal(reverse.addedModules, 0); assert.ok(reverse.issues.some(i => i.code === 'wall-run-cap'));
});

test('placeholder pipe corners also wrap interior pillars and locks or regions preserve protected cells', () => {
  const source = room(); source.rows[3] = '#..#...#';
  const placed = placeWallMounts(source, settings({ singles: false }), []); assert.equal(placed.runCount, 2); assert.equal(placed.map.fixtures!.filter(f => f.wall!.placeholder === 'pipeOuterCorner').length, 4); assert.deepEqual(wallMountIssues(placed.map, []), []);
  const regionMap = room(); regionMap.lockedCells = [{ x: 2, row: 0 }];
  const region = { x: 1, row: 0, width: 4, height: 2 }, partial = placeWallMounts(regionMap, settings({ runs: false }), [], region);
  assert.ok(partial.addedSingles > 0); assert.ok(partial.map.fixtures!.every(f => wallMountDependencies(f).every(c => c.x >= 1 && c.x < 5 && c.row < 2 && !(c.x === 2 && c.row === 0))));
});

test('placeholder kinds survive strict instance parsing and invalid kind or fake binding reference is rejected', () => {
  const f = placeWallMounts(room(), settings({ runs: false }), []).map.fixtures![0]; assert.deepEqual(parseWallMountInstance(f.wall, 8, 8), f.wall);
  assert.throws(() => parseWallMountInstance({ ...f.wall, placeholder: 'random' }, 8, 8));
  assert.throws(() => parseWallMountInstance({ ...f.wall, bindingReference: { scale: v(1, 1, 1), rotationY: 0 } }, 8, 8));
  const invalid = placeWallMounts(room(), settings({ runs: false }), []).map; invalid.fixtures![0].bindingId = 'made-up'; assert.ok(wallMountIssues(invalid, []).some(i => i.code === 'wall-binding'));
});

test('replacement keeps the same wall mount contact with an off-center native prefab pivot and then uses its measured geometry', () => {
  const placed = placeWallMounts(room(), settings({ runs: false }), []).map, f = placed.fixtures!.find(f => f.wall!.placeholder === 'wallPanel')!; assert.ok(f);
  const b = real('wallPanel'); b.bounds!.center.x += 2; b.bounds!.center.y += .3; b.bounds!.center.z += .4; b.wallMount!.mounts[0].position = v(2, .3, .4);
  const replaced = editWallMount(placed, f.id, { bindingId: b.id }, [b]), result = replaced.fixtures!.find(g => g.id === f.id)!;
  assert.equal(result.bindingId, b.id); assert.equal(result.wall!.placeholder, undefined); near(result.wall!.bounds[0].center, f.wall!.bounds[0].center); assert.deepEqual(result.wall!.support, f.wall!.support); assert.deepEqual(wallMountIssues(replaced, [b]), []);
});

test('replacement rejects role, site, collision and unmeasured mismatches atomically', () => {
  const placed = placeWallMounts(room(), settings({ runs: false }), []).map, f = placed.fixtures!.find(f => f.wall!.placeholder === 'wallPanel')!, before = structuredClone(placed);
  const role = real('wallLight'); assert.throws(() => editWallMount(placed, f.id, { bindingId: role.id }, [role]), /역할/);
  const site = real('wallPanel'); site.wallMount!.sites = ['doorTop']; assert.throws(() => editWallMount(placed, f.id, { bindingId: site.id }, [site]), /설치 위치/);
  const giant = real('wallPanel'); giant.bounds!.size.y = 20; assert.throws(() => editWallMount(placed, f.id, { bindingId: giant.id }, [giant]), /벽 높이/);
  const unknown = real('wallPanel'); delete unknown.bounds; assert.throws(() => editWallMount(placed, f.id, { bindingId: unknown.id }, [unknown]), /측정/);
  assert.deepEqual(placed, before);
});

test('connected placeholders accept real modules with equivalent sockets and a different family but reject gaps and kind changes', () => {
  const placed = placeWallMounts(room(), settings({ singles: false }), []).map, f = placed.fixtures!.find(f => f.wall!.placeholder === 'pipeStraight')!, b = real('pipeStraight');
  b.bounds!.center.x += 5; b.wallMount!.mounts.forEach(m => m.position.x += 5); b.wallMount!.sockets.forEach(s => s.position.x += 5);
  const replaced = editWallMount(placed, f.id, { bindingId: b.id }, [b]); assert.deepEqual(wallMountIssues(replaced, [b]), []); assert.deepEqual(replaced.fixtures!.find(g => g.id === f.id)!.wall!.sockets, f.wall!.sockets);
  const wrongLength = real('pipeStraight'); wrongLength.wallMount!.sockets[1].position.x += .2; assert.throws(() => editWallMount(placed, f.id, { bindingId: wrongLength.id }, [wrongLength]), /연결점/);
  const corner = real('pipeInnerCorner'); assert.throws(() => editWallMount(placed, f.id, { bindingId: corner.id }, [corner]), /종류/);
  const next = replaced.fixtures!.find(g => g.wall!.placeholder === 'pipeStraight')!, otherFamily = real('pipeStraight', 'other-family'); otherFamily.wallMount!.family = 'other-set'; assert.throws(() => editWallMount(replaced, next.id, { bindingId: otherFamily.id }, [b, otherFamily]), /Family/);
});

test('every placeholder can be replaced with a complete real family without retaining placeholder or fake binding state', () => {
  const bindings = WALL_PLACEHOLDER_KINDS.map(kind => real(kind, `real-${kind}`)); let map = placeWallMounts(room(), settings(), []).map;
  const fixtures = structuredClone(map.fixtures!);
  for (const f of fixtures) map = editWallMount(map, f.id, { bindingId: `real-${f.wall!.placeholder}` }, bindings);
  assert.equal(map.fixtures!.length, fixtures.length); assert.ok(map.fixtures!.every(f => !f.wall!.placeholder && f.bindingId?.startsWith('real-') && f.wall!.bindingReference?.prefabGuid === 'a'.repeat(32))); assert.deepEqual(wallMountIssues(map, bindings), []);
});

test('deleting a placeholder segment closes both remaining ends using placeholder caps', () => {
  const placed = placeWallMounts(room(), settings({ singles: false }), []).map, f = placed.fixtures!.find(f => f.wall!.placeholder === 'pipeStraight')!;
  const edited = editWallMount(placed, f.id, { remove: true }, []); assert.ok(!edited.fixtures!.some(g => g.id === f.id)); assert.equal(edited.fixtures!.filter(g => g.wall!.placeholder === 'pipeEndCap').length, 2); assert.ok(edited.fixtures!.every(g => !g.bindingId && !g.wall!.bindingReference)); assert.deepEqual(wallMountIssues(edited, []), []);
});

test('placeholder door lights use actual headers and preserve authored edits when doors resize', () => {
  const source = room(); source.rows[0] = '###D####'; source.connections = [{ id: 'north', label: 'North', x: 3, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }]; source.structureFills = [{ id: 'top', x: 3, row: 0, role: 'wall', purpose: 'doorTop', direction: 0, position: v(-1, 3.5, 7), size: v(2, 1, 2) }];
  const placed = placeWallMounts(source, settings({ runs: false }), []).map, f = placed.fixtures!.find(f => f.wall!.placeholder === 'doorLight')!; assert.ok(f); assert.equal(f.wall!.position.y, 3.25);
  const shifted = editWallMount(placed, f.id, { height: .1 }, []); shifted.connections[0].height += .2; const followed = synchronizeWallMounts(shifted).fixtures!.find(g => g.id === f.id)!; assert.ok(Math.abs(followed.wall!.position.y - 3.55) < 1e-5); assert.equal(followed.wall!.placeholder, 'doorLight');
});
