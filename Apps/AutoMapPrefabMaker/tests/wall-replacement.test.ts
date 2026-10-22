import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetBinding, GridMap, Vec3, WallMountSettings, WallPlaceholderKind } from '../src/shared/types';
import { DEFAULT_WALL_SETTINGS, editWallMount, placeWallMounts, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding } from '../src/shared/wall-placeholders';
import { countWallPlaceholders, replaceWallPlaceholders } from '../src/shared/wall-replacement';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, density: 100, runDensity: 100, ...patch });
function room(): GridMap { return { version: 5, name: 'Bulk replacement', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows: ['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
function real(kind: WallPlaceholderKind, id = `real-${kind}`): AssetBinding { const binding = placeholderWallBinding(kind); binding.id = id; binding.label = `실제 ${kind}`; binding.prefabGuid = 'a'.repeat(32); binding.prefabPath = `Assets/${id}.prefab`; if (binding.wallMount!.kind !== 'single') binding.wallMount!.family = 'actual-pipe-set'; return binding; }
const near = (actual: Vec3, expected: Vec3) => assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z) < 1e-5);

test('bulk replacement counts exact temporary kinds and preserves other kinds plus already real fixtures', () => {
  const binding = real('wallPanel'), original = placeWallMounts(room(), settings({ runs: false }), []).map;
  const first = original.fixtures!.find(fixture => fixture.wall?.placeholder === 'wallPanel')!;
  const source = editWallMount(original, first.id, { bindingId: binding.id }, [binding]), before = structuredClone(source);
  const count = countWallPlaceholders(source, 'wallPanel'); assert.ok(count > 1);
  const result = replaceWallPlaceholders(source, 'wallPanel', binding.id, [binding]);
  assert.equal(result.replaced, count); assert.equal(countWallPlaceholders(result.map, 'wallPanel'), 0);
  assert.equal(result.map.fixtures!.filter(fixture => fixture.bindingId === binding.id).length, count + 1);
  assert.deepEqual(result.map.fixtures!.find(fixture => fixture.id === first.id), source.fixtures!.find(fixture => fixture.id === first.id));
  for (const fixture of source.fixtures!.filter(fixture => fixture.wall?.placeholder !== 'wallPanel')) assert.deepEqual(result.map.fixtures!.find(item => item.id === fixture.id), fixture);
  assert.deepEqual(wallMountIssues(result.map, [binding]), []); assert.deepEqual(source, before);
});

test('bulk replacement preserves contacts for native off-center pivots on different wall orientations', () => {
  const source = placeWallMounts(room(), settings({ runs: false }), []).map, binding = real('wallPanel');
  binding.bounds!.center.x += 2; binding.bounds!.center.y += .3; binding.bounds!.center.z += .4;
  binding.wallMount!.mounts[0].position = v(2, .3, .4);
  const targets = source.fixtures!.filter(fixture => fixture.wall?.placeholder === 'wallPanel');
  assert.ok(new Set(targets.map(fixture => fixture.wall!.rotationY)).size > 1);
  const result = replaceWallPlaceholders(source, 'wallPanel', binding.id, [binding]);
  assert.equal(result.replaced, targets.length);
  for (const fixture of targets) {
    const changed = result.map.fixtures!.find(item => item.id === fixture.id)!;
    near(changed.wall!.bounds[0].center, fixture.wall!.bounds[0].center);
    assert.deepEqual(changed.wall!.support, fixture.wall!.support);
    assert.equal(changed.wall!.authored, true); assert.equal(changed.wall!.placeholder, undefined);
  }
  assert.deepEqual(wallMountIssues(result.map, [binding]), []);
});

test('one later locked target cancels the whole transaction and never mutates the source or bindings', () => {
  const source = placeWallMounts(room(), settings({ runs: false }), []).map, binding = real('wallPanel');
  const targets = source.fixtures!.filter(fixture => fixture.wall?.placeholder === 'wallPanel'); assert.ok(targets.length > 1);
  source.lockedCells = [wallMountDependencies(targets.at(-1)!)[0]];
  const before = structuredClone({ source, binding });
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', binding.id, [binding]), /일괄 교체.*잠긴.*전체 변경을 취소/);
  assert.deepEqual({ source, binding }, before); assert.equal(countWallPlaceholders(source, 'wallPanel'), targets.length);
});

test('role, site, native size and missing binding mismatches fail atomically with the original reason', () => {
  const source = placeWallMounts(room(), settings({ runs: false }), []).map, before = structuredClone(source);
  const wrongRole = real('wallLight');
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', wrongRole.id, [wrongRole]), /역할.*전체 변경을 취소/);
  const wrongSite = real('wallPanel'); wrongSite.wallMount!.sites = ['doorTop'];
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', wrongSite.id, [wrongSite]), /설치 위치.*전체 변경을 취소/);
  const tooTall = real('wallPanel'); tooTall.bounds!.size.y = 20;
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', tooTall.id, [tooTall]), /벽 높이.*전체 변경을 취소/);
  const unmeasured = real('wallPanel'); delete unmeasured.bounds;
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', unmeasured.id, [unmeasured]), /측정.*전체 변경을 취소/);
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', 'missing', []), /프리팹이 없습니다.*전체 변경을 취소/);
  assert.throws(() => replaceWallPlaceholders(source, 'wallPanel', '', []), /실제 벽 프리팹.*전체 변경을 취소/);
  assert.deepEqual(source, before);
});

test('all same-kind pipe parts can be replaced across separate runs while other part kinds retain their state', () => {
  const layout = room(); layout.rows[3] = '#..#...#';
  const source = placeWallMounts(layout, settings({ singles: false }), []).map, binding = real('pipeStraight');
  const targets = source.fixtures!.filter(fixture => fixture.wall?.placeholder === 'pipeStraight');
  assert.equal(new Set(targets.map(fixture => fixture.wall!.runId)).size, 2);
  const result = replaceWallPlaceholders(source, 'pipeStraight', binding.id, [binding]);
  assert.equal(result.replaced, targets.length); assert.equal(countWallPlaceholders(result.map, 'pipeStraight'), 0);
  for (const fixture of source.fixtures!.filter(fixture => fixture.wall?.placeholder !== 'pipeStraight')) {
    const changed = result.map.fixtures!.find(item => item.id === fixture.id)!;
    assert.equal(changed.wall!.placeholder, fixture.wall!.placeholder);
    assert.deepEqual(changed.wall!.sockets, fixture.wall!.sockets);
    assert.equal(changed.wall!.runId, fixture.wall!.runId);
  }
  assert.deepEqual(wallMountIssues(result.map, [binding]), []);
});

test('pipe socket incompatibility or a conflicting real family cancels all replacements', () => {
  const source = placeWallMounts(room(), settings({ singles: false }), []).map, before = structuredClone(source), binding = real('pipeStraight');
  binding.wallMount!.sockets[1].position.x += .2;
  assert.throws(() => replaceWallPlaceholders(source, 'pipeStraight', binding.id, [binding]), /연결점.*전체 변경을 취소/);
  assert.deepEqual(source, before);
  const existing = real('pipeStraight', 'existing'), first = source.fixtures!.find(fixture => fixture.wall?.placeholder === 'pipeStraight')!;
  const withReal = editWallMount(source, first.id, { bindingId: existing.id }, [existing]), original = structuredClone(withReal);
  const other = real('pipeStraight', 'other'); other.wallMount!.family = 'other-family';
  assert.throws(() => replaceWallPlaceholders(withReal, 'pipeStraight', other.id, [existing, other]), /Family.*전체 변경을 취소/);
  assert.deepEqual(withReal, original);
});

test('absent placeholder kinds are a detached no-op and invalid kinds are rejected', () => {
  const source = room(), result = replaceWallPlaceholders(source, 'wallPanel', 'missing', []);
  assert.equal(result.replaced, 0); assert.deepEqual(result.map, source); assert.notEqual(result.map, source);
  assert.equal(countWallPlaceholders(source, 'wallPanel'), 0);
  assert.throws(() => replaceWallPlaceholders(source, 'unknown' as WallPlaceholderKind, 'missing', []), /종류/);
});
