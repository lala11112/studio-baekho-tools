import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, editWallMount, parseWallMountDefinition, parseWallMountInstance, placeWallMounts, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import type { AssetBinding, GridMap, MapFixture, Vec3, WallMountSettings } from '../src/shared/types';

function room(): GridMap { return { version: 5, name: 'Pipe networks', width: 12, height: 10, cellSize: 2, maxStepHeight: .4, rows: ['############', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 40, runOrientation: 'both', ...patch });
const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-5;
function graph(map: GridMap, bindings: AssetBinding[] = []) {
  assert.deepEqual(wallMountIssues(map, bindings), []);
  for (const f of map.fixtures ?? []) for (const s of f.wall?.sockets ?? []) {
    const peers = map.fixtures!.flatMap(g => g === f ? [] : (g.wall?.sockets ?? []).filter(t => near(s.position, t.position) && near(s.direction, { x: -t.direction.x, y: -t.direction.y, z: -t.direction.z })).map(() => g));
    assert.equal(peers.length, 1, `${f.id} socket has ${peers.length} peers`); assert.equal(peers[0].wall!.runId, f.wall!.runId);
  }
}
function realKit(): AssetBinding[] { return WALL_PLACEHOLDER_KINDS.filter(k => k.startsWith('pipe')).map((kind, i) => { const b = placeholderWallBinding(kind); b.id = `real-${kind}`; b.prefabGuid = i.toString(16).repeat(32); b.prefabPath = `Assets/${b.id}.prefab`; b.wallMount!.family = 'NativePipe'; return b; }); }
const kind = (f: MapFixture, bindings: AssetBinding[]) => f.wall!.placeholder ?? bindings.find(b => b.id === f.bindingId)!.id.replace('real-', '');

test('junction metadata requires outward cardinal arms around a common planar hub and measured compound bounds', () => {
  for (const name of ['pipeElbow', 'pipeTee'] as const) { const b = placeholderWallBinding(name); assert.deepEqual(parseWallMountDefinition(b.wallMount), b.wallMount); }
  const valid = placeholderWallBinding('pipeTee').wallMount!;
  for (const change of [(b: typeof valid) => { b.sockets[2].position.z += .1; }, (b: typeof valid) => { b.sockets[2].direction = { ...b.sockets[0].direction }; }, (b: typeof valid) => { b.sockets[0].direction.x *= -1; }, (b: typeof valid) => { b.sockets[1].position.y += .1; }, (b: typeof valid) => { b.collisionBoxes.pop(); }]) { const b = structuredClone(valid); change(b); assert.throws(() => parseWallMountDefinition(b)); }
});

test('fresh both-mode fallback creates real elbow and tee joins with exactly one peer per socket', () => {
  const placed = placeWallMounts(room(), settings(), []); graph(placed.map);
  assert.ok(placed.map.fixtures!.some(f => f.wall!.placeholder === 'pipeElbow')); assert.ok(placed.map.fixtures!.some(f => f.wall!.placeholder === 'pipeTee'));
  assert.ok(placed.map.fixtures!.every(f => !f.bindingId && !f.wall!.bindingReference));
  for (const f of placed.map.fixtures!.filter(f => ['pipeElbow', 'pipeTee'].includes(f.wall!.placeholder!))) { assert.deepEqual(parseWallMountInstance(f.wall, 12, 10), f.wall); assert.ok(placed.map.fixtures!.some(g => g.wall!.runId === f.wall!.runId && g.wall!.sockets.every(s => Math.abs(s.direction.y) > .99))); }
  const repeat = placeWallMounts(placed.map, settings(), []); assert.equal(repeat.unchanged, true); assert.deepEqual(repeat.map, placed.map);
});

test('existing independent generated runs can become connected while authored assemblies stay intact', () => {
  const independent = placeWallMounts(room(), settings({ connectRuns: false }), []).map, before = structuredClone(independent), connected = placeWallMounts(independent, settings(), []);
  assert.deepEqual(independent, before); assert.ok(connected.map.fixtures!.some(f => f.wall!.placeholder === 'pipeTee' || f.wall!.placeholder === 'pipeElbow')); graph(connected.map);
  const authored = structuredClone(independent); authored.fixtures!.forEach(f => { f.wall!.authored = true; }); const retained = placeWallMounts(authored, settings(), []); assert.deepEqual(retained.map, authored);
});

test('automatic connection preserves externally linked generated fixtures and existing IDs atomically', () => {
  const independent = placeWallMounts(room(), settings({ connectRuns: false }), []).map, baseline = placeWallMounts(independent, settings(), []).map;
  const removed = independent.fixtures!.find(f => !baseline.fixtures!.some(g => g.id === f.id))!; assert.ok(removed);
  const linked = structuredClone(independent); linked.fixtures!.push({ id: 'external-switch', role: 'switch', x: 6, row: 5, direction: 0, offset: { x: 0, y: 0, z: 0 }, linkedId: removed.id });
  const kept = placeWallMounts(linked, settings(), []).map; assert.ok(kept.fixtures!.some(f => f.id === removed.id)); assert.equal(kept.fixtures!.find(f => f.id === 'external-switch')!.linkedId, removed.id); graph(kept);
  const branchId = baseline.fixtures!.find(f => f.id.includes('-branch-'))!.id, collision = structuredClone(independent); collision.fixtures!.push({ id: branchId, role: 'switch', x: 6, row: 5, direction: 0, offset: { x: 0, y: 0, z: 0 } });
  const unique = placeWallMounts(collision, settings(), []).map; assert.equal(new Set(unique.fixtures!.map(f => f.id)).size, unique.fixtures!.length); assert.equal(unique.fixtures!.find(f => f.id === branchId)!.role, 'switch'); graph(unique);
});

test('connecting a valid 80-character existing fixture ID keeps generated branch IDs saveable', () => {
  const source = placeWallMounts(room(), settings({ runOrientation: 'horizontal' }), []).map, cap = source.fixtures!.find(f => f.wall!.placeholder === 'pipeEndCap')!; cap.id = 'long_existing_cap_'.padEnd(80, 'x');
  const connected = placeWallMounts(source, settings(), []).map; assert.equal(connected.fixtures!.find(f => f.id === cap.id)!.wall!.placeholder, 'pipeElbow'); assert.ok(connected.fixtures!.every(f => f.id.length <= 80)); graph(connected);
  const saved = JSON.parse(JSON.stringify({ formatVersion: 1, map: connected, settings: { ...DEFAULT_SETTINGS, width: 12, height: 10 }, bindings: [] })); assert.deepEqual(parseProjectFile(saved).map.fixtures, connected.fixtures);
});

test('elbow-only kits turn capped horizontal ends down and tee-only kits branch closed horizontal loops', () => {
  for (const omit of ['pipeTee', 'pipeElbow']) {
    const bindings = realKit().filter(b => b.id !== `real-${omit}`), placed = placeWallMounts(room(), settings({ placeholderFallback: false }), bindings);
    assert.ok(placed.map.fixtures!.some(f => kind(f, bindings) === (omit === 'pipeTee' ? 'pipeElbow' : 'pipeTee'))); assert.ok(!placed.map.fixtures!.some(f => kind(f, bindings) === omit)); graph(placed.map, bindings);
  }
  const bindings = realKit().filter(b => b.id !== 'real-pipeElbow'), closed = placeWallMounts(room(), settings({ placeholderFallback: false, runDensity: 100 }), bindings); assert.ok(closed.map.fixtures!.some(f => f.bindingId === 'real-pipeTee')); graph(closed.map, bindings);
});

test('missing or dimensionally incompatible real junctions retain separate valid runs and report the limitation', () => {
  const bindings = realKit().filter(b => !['elbow', 'tee'].includes(b.wallMount!.kind)), plain = placeWallMounts(room(), settings({ connectRuns: false, placeholderFallback: false }), bindings);
  const connected = placeWallMounts(room(), settings({ placeholderFallback: false }), bindings); assert.deepEqual(connected.map, plain.map); assert.ok(connected.issues.some(i => i.code === 'wall-junction-fit')); graph(connected.map, bindings);
  const wrong = realKit().filter(b => b.wallMount!.kind !== 'elbow'), tee = wrong.find(b => b.wallMount!.kind === 'tee')!; tee.wallMount!.sockets.filter(s => Math.abs(s.direction.x) > .9).forEach(s => { s.position.x *= 1.2; });
  const gap = placeWallMounts(room(), settings({ placeholderFallback: false }), wrong); assert.ok(!gap.map.fixtures!.some(f => f.bindingId === tee.id)); assert.ok(gap.issues.some(i => i.code === 'wall-junction-fit')); graph(gap.map, wrong);
});

test('joined networks respect selected regions, locked supports, low walls and tall furniture', () => {
  const source = room(); source.lockedCells = [{ x: 3, row: 0 }];
  const region = { x: 1, row: 0, width: 7, height: 2 }, placed = placeWallMounts(source, settings({ runDensity: 100 }), [], region); graph(placed.map); assert.ok(placed.map.fixtures!.every(f => wallMountDependencies(f).every(c => c.x >= 1 && c.x < 8 && c.row < 2 && !(c.x === 3 && c.row === 0))));
  const low = room(); low.wallHeights = Array.from({ length: 12 }, (_, x) => ({ x, row: 0, height: 1 })); const checked = placeWallMounts(low, settings(), []); graph(checked.map); assert.ok(checked.map.fixtures!.every(f => f.wall!.bounds.every(b => b.center.y - b.size.y / 2 >= 0)));
  const furniture = room(); furniture.propInstances = [{ id: 'cabinet', bindingId: 'cabinet', x: 2, row: 1, direction: 0, offset: { x: 0, y: 0, z: .7 }, cells: [{ x: 2, row: 1 }], size: { x: 1.8, y: 3.8, z: 1.8 }, blocksMovement: true, category: 'cabinet' }]; graph(placeWallMounts(furniture, settings(), []).map);
});

test('deleting a tee recaps all three arms and moving its network preserves every physical join', () => {
  const placed = placeWallMounts(room(), settings(), []).map, tee = placed.fixtures!.find(f => f.wall!.placeholder === 'pipeTee')!, group = placed.fixtures!.filter(f => f.wall!.runId === tee.wall!.runId);
  const moved = editWallMount(placed, tee.id, { height: .05 }, []); graph(moved);
  for (const f of group) assert.ok(Math.abs(moved.fixtures!.find(g => g.id === f.id)!.wall!.position.y - f.wall!.position.y - .05) < 1e-5);
  const removed = editWallMount(placed, tee.id, { remove: true }, []); assert.ok(!removed.fixtures!.some(f => f.id === tee.id)); graph(removed);
  const locked = structuredClone(placed); locked.lockedCells = [tee.wall!.support[0]]; assert.throws(() => editWallMount(locked, tee.id, { remove: true }, []), /잠긴/);
});

test('off-center actual junction replacement preserves pose and all connected socket directions atomically', () => {
  const placed = placeWallMounts(room(), settings(), []).map, tee = placed.fixtures!.find(f => f.wall!.placeholder === 'pipeTee')!, b = realKit().find(b => b.wallMount!.kind === 'tee')!;
  const shift = { x: 2.5, y: .3, z: -.7 }; for (const c of [b.bounds!.center, ...b.wallMount!.mounts.map(m => m.position), ...b.wallMount!.sockets.map(s => s.position), ...b.wallMount!.collisionBoxes.map(box => box.center)]) { c.x += shift.x; c.y += shift.y; c.z += shift.z; }
  const replaced = editWallMount(placed, tee.id, { bindingId: b.id }, [b]), actual = replaced.fixtures!.find(f => f.id === tee.id)!; assert.equal(actual.wall!.rotationY, tee.wall!.rotationY); assert.equal(actual.wall!.rotationZ ?? 0, tee.wall!.rotationZ ?? 0); graph(replaced, [b]);
  assert.ok(tee.wall!.sockets.every(s => actual.wall!.sockets.some(t => near(s.position, t.position) && near(s.direction, t.direction))));
  const bad = structuredClone(b); bad.id = 'bad-tee'; bad.wallMount!.sockets[0].position.x -= .2; assert.throws(() => editWallMount(placed, tee.id, { bindingId: bad.id }, [bad]), /연결점/); graph(placed);
});

test('socket aliases are rejected even when a duplicate peer is assigned a different run ID', () => {
  const placed = placeWallMounts(room(), settings(), []).map, cap = placed.fixtures!.find(f => f.wall!.placeholder === 'pipeEndCap')!, duplicate = structuredClone(cap); duplicate.id = 'forged-duplicate'; duplicate.wall!.runId = 'other-run'; placed.fixtures!.push(duplicate);
  assert.ok(wallMountIssues(placed, []).some(i => i.code === 'wall-run-alias'));
});
