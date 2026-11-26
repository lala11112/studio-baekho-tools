import assert from 'node:assert/strict';
import test from 'node:test';
import { NEW_WALL_SETTINGS, placeWallMounts, reapplyWallRuns, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import type { AssetBinding, GridMap, MapFixture, WallMountSettings } from '../src/shared/types';

function room(): GridMap {
  const width = 20, height = 20;
  return { version: 5, name: 'Wall composition review', width, height, cellSize: 2, maxStepHeight: .4,
    rows: ['#'.repeat(width), ...Array(height - 2).fill(`#${'.'.repeat(width - 2)}#`), '#'.repeat(width)],
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 };
}
const config = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...NEW_WALL_SETTINGS, enabled: true, singles: false, ...patch });
function kit(family = 'Review'): AssetBinding[] {
  return WALL_PLACEHOLDER_KINDS.filter(k => k.startsWith('pipe')).map((kind, i) => {
    const binding = placeholderWallBinding(kind); binding.id = `${family}-${kind}`; binding.prefabGuid = i.toString(16).repeat(32); binding.prefabPath = `Assets/${binding.id}.prefab`;
    binding.wallMount!.family = family; return binding;
  });
}
function exactGraph(map: GridMap, bindings: AssetBinding[]): void {
  assert.deepEqual(wallMountIssues(map, bindings), []);
  const mounted = (map.fixtures ?? []).filter(f => f.wall);
  for (const f of mounted) for (const socket of f.wall!.sockets) {
    const peers = mounted.flatMap(other => other === f ? [] : other.wall!.sockets.filter(s => Math.hypot(s.position.x - socket.position.x, s.position.y - socket.position.y, s.position.z - socket.position.z) < 1e-5
      && Math.hypot(s.direction.x + socket.direction.x, s.direction.y + socket.direction.y, s.direction.z + socket.direction.z) < 1e-5).map(() => other));
    assert.equal(peers.length, 1); assert.equal(peers[0].wall!.runId, f.wall!.runId);
    if (f.bindingId) assert.equal(bindings.find(b => b.id === peers[0].bindingId)!.wallMount!.family, bindings.find(b => b.id === f.bindingId)!.wallMount!.family);
  }
}

test('fixed heights remain exact at native horizontal mounts despite off-pivot geometry and authored Y offsets', () => {
  for (const reference of ['floor', 'top'] as const) {
    const bindings = kit();
    for (const b of bindings) {
      b.offset.y = .3;
      for (const p of [b.bounds!.center, ...b.wallMount!.mounts.map(m => m.position), ...b.wallMount!.sockets.map(s => s.position), ...b.wallMount!.collisionBoxes.map(box => box.center)]) {
        p.x += 2.25; p.y += .35; p.z -= 1.2;
      }
    }
    const placed = placeWallMounts(room(), config({ runHeight: { mode: 'fixed', reference, min: 1.25, max: 1.25 } }), bindings);
    assert.ok(placed.addedModules > 0); exactGraph(placed.map, bindings);
    const expected = reference === 'floor' ? 1.25 : 2.75;
    for (const f of placed.map.fixtures!) {
      const b = bindings.find(b => b.id === f.bindingId)!;
      for (const mount of b.wallMount!.mounts) assert.ok(Math.abs(f.wall!.position.y + mount.position.y * b.scale.y - expected) < 1e-5, `${f.id}: fixed mount height`);
    }
  }
});

test('a cap whose native mount cannot satisfy the horizontal height policy is never forced into a route', () => {
  for (const mode of ['fixed', 'random'] as const) {
    const bindings = kit(), cap = bindings.find(b => b.wallMount!.kind === 'endCap')!;
    cap.wallMount!.mounts = [{ position: { x: 0, y: .5, z: 0 }, direction: { x: 0, y: 0, z: 1 } }];
    const placed = placeWallMounts(room(), config({ runHeight: { mode, reference: 'floor', min: 1.4, max: mode === 'fixed' ? 1.4 : 1.6 } }), bindings);
    assert.equal(placed.addedModules, 0); assert.ok(placed.issues.length); exactGraph(placed.map, bindings);
  }
});

test('authored, locked, copied, unknown and linked members protect their complete composed networks through stable reapply', () => {
  const initial = config({ runDensity: 100 }), next = config({ runDensity: 100, runHeight: { mode: 'fixed', reference: 'floor', min: 1.5, max: 1.5 } });
  for (const protection of ['authored', 'locked', 'copied', 'unknown', 'referenced', 'linked']) {
    const source = placeWallMounts(room(), initial, []).map, first = source.fixtures![0], run = source.fixtures!.filter(f => f.wall!.runId === first.wall!.runId);
    if (protection === 'authored') first.wall!.authored = true;
    if (protection === 'locked') source.lockedCells = [wallMountDependencies(first)[0]];
    if (protection === 'copied' || protection === 'unknown') for (const f of run) f.wall!.runId = protection === 'copied' ? 'wm-run-copy_1_run' : 'imported-network';
    if (protection === 'referenced' || protection === 'linked') {
      const control: MapFixture = { id: 'control', role: 'switch', x: 10, row: 10, direction: 0, anchor: 'floor', offset: { x: 0, y: 0, z: 0 } };
      if (protection === 'referenced') control.linkedId = first.id; else first.linkedId = control.id;
      source.fixtures!.push(control);
    }
    const saved = structuredClone(source), preserved = structuredClone(run), result = reapplyWallRuns(source, next, []);
    assert.deepEqual(source, saved); assert.ok(result.preservedRuns >= 1, protection);
    for (const f of preserved) assert.deepEqual(result.map.fixtures!.find(other => other.id === f.id), f, protection);
    exactGraph(result.map, []);
    const repeated = reapplyWallRuns(result.map, next, []); assert.equal(repeated.unchanged, true, protection); assert.deepEqual(repeated.map, result.map);
  }
});

test('multiple native families keep one peer per socket and catalog-order independence', () => {
  const bindings = [...kit('A'), ...kit('B')], source = room(), policy = config({ runDensity: 100 });
  const placed = placeWallMounts(source, policy, bindings);
  assert.ok(placed.addedModules); exactGraph(placed.map, bindings);
  assert.deepEqual(placeWallMounts(source, policy, [...bindings].reverse()).map, placed.map);
  assert.deepEqual(placeWallMounts(placed.map, policy, bindings).map, placed.map);
});
