import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, placeWallMounts, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import type { AssetBinding, GridMap, MapFixture, WallMountSettings } from '../src/shared/types';

function room(): GridMap { return { version: 5, name: 'Pipe heights', width: 12, height: 10, cellSize: 2, maxStepHeight: .4, rows: ['############', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 100, ...patch });
function realKit(): AssetBinding[] { return WALL_PLACEHOLDER_KINDS.filter(kind => kind.startsWith('pipe')).map((kind, i) => { const b = placeholderWallBinding(kind); b.id = `actual-${kind}`; b.prefabGuid = i.toString(16).repeat(32); b.prefabPath = `Assets/${b.id}.prefab`; b.wallMount!.family = 'NativePipe'; return b; }); }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} differs from ${expected}`);
function inRange(fixtures: MapFixture[], low: number, high: number) { for (const fixture of fixtures) for (const bounds of fixture.wall!.bounds) assert.ok(bounds.center.y - bounds.size.y / 2 >= low - 1e-5 && bounds.center.y + bounds.size.y / 2 <= high + 1e-5, `${fixture.id} exceeds ${low}..${high}`); }

test('fixed horizontal height supports floor and wall top for placeholders and off-pivot actual kits', () => {
  for (const actual of [false, true]) for (const reference of ['floor', 'top'] as const) {
    const map = room(); map.elevations = map.elevations.map(row => row.map(() => 2));
    const bindings = actual ? realKit() : [], before = structuredClone(bindings);
    for (const binding of bindings) for (const p of [binding.bounds!.center, ...binding.wallMount!.mounts.map(m => m.position), ...binding.wallMount!.sockets.map(s => s.position), ...binding.wallMount!.collisionBoxes.map(b => b.center)]) { p.x += 2; p.y += .7; p.z -= 1.5; }
    const originalBindings = structuredClone(bindings), source = structuredClone(map);
    const placed = placeWallMounts(map, settings({ runHeight: { mode: 'fixed', reference, min: 1.25, max: 1.25 } }), bindings);
    assert.ok(placed.addedModules > 0); assert.deepEqual(wallMountIssues(placed.map, bindings), []);
    for (const fixture of placed.map.fixtures!) for (const socket of fixture.wall!.sockets) close(socket.position.y, reference === 'floor' ? 3.25 : 4.75);
    assert.deepEqual(map, source); assert.deepEqual(bindings, originalBindings); assert.equal(before.length, bindings.length);
  }
});

test('random horizontal heights are deterministic per boundary and keep corners and sockets joined', () => {
  const map = room(); map.rows[4] = '#....##....#'; map.rows[5] = '#....##....#';
  const policy = settings({ runHeight: { mode: 'random', reference: 'floor', min: 1, max: 3 } });
  const generated = (seed: number) => placeWallMounts(map, { width: 12, height: 10, cellSize: 2, maxStepHeight: .4, connectionCount: 0, style: 'industrial', seed, designer: { wallMounts: policy } } as any, []);
  const first = generated(17); assert.ok(first.runCount >= 2); assert.deepEqual(first.map, generated(17).map); assert.notDeepEqual(first.map.fixtures, generated(18).map.fixtures);
  const levels = new Set<number>();
  for (const runId of new Set(first.map.fixtures!.map(f => f.wall!.runId))) {
    const heights = first.map.fixtures!.filter(f => f.wall!.runId === runId).flatMap(f => f.wall!.sockets.map(s => s.position.y));
    assert.ok(heights.every(y => y >= 1 && y <= 3)); heights.forEach(y => close(y, heights[0])); levels.add(heights[0]);
  }
  assert.ok(levels.size >= 2); assert.deepEqual(wallMountIssues(first.map, []), []);
});

test('vertical custom ranges bound complete native chains and leave a capped remainder', () => {
  for (const reference of ['floor', 'top'] as const) {
    const placed = placeWallMounts(room(), settings({ runOrientation: 'vertical', verticalRange: { reference, start: .5, end: 2.75 } }), []);
    assert.ok(placed.addedModules > 0); inRange(placed.map.fixtures!, reference === 'floor' ? .5 : 1.25, reference === 'floor' ? 2.75 : 3.5);
    for (const fixture of placed.map.fixtures!.filter(f => f.wall!.placeholder === 'pipeStraight')) close(Math.abs(fixture.wall!.sockets[0].position.y - fixture.wall!.sockets[1].position.y), 1);
    assert.deepEqual(wallMountIssues(placed.map, []), []);
  }
  const tooShort = placeWallMounts(room(), settings({ runOrientation: 'vertical', verticalRange: { reference: 'floor', start: 1, end: 1.6 } }), []);
  assert.equal(tooShort.addedModules, 0); assert.ok(tooShort.issues.some(i => i.code === 'wall-vertical-fit'));
});

test('custom vertical range constrains elbow and tee branches without breaking horizontal runs', () => {
  const config = settings({ runOrientation: 'both', runDensity: 40, runHeight: { mode: 'fixed', reference: 'floor', min: 2.8, max: 2.8 }, verticalRange: { reference: 'floor', start: .4, end: 3.5 } });
  const joined = placeWallMounts(room(), config, []);
  assert.ok(joined.map.fixtures!.some(f => ['pipeElbow', 'pipeTee'].includes(f.wall!.placeholder!))); inRange(joined.map.fixtures!, .4, 3.5); assert.deepEqual(wallMountIssues(joined.map, []), []);
  const separate = placeWallMounts(room(), { ...config, verticalRange: { reference: 'floor', start: .4, end: 2 } }, []);
  assert.ok(separate.map.fixtures!.some(f => f.wall!.placeholder === 'pipeStraight' && !f.wall!.rotationZ)); assert.ok(!separate.map.fixtures!.some(f => ['pipeElbow', 'pipeTee'].includes(f.wall!.placeholder!))); assert.deepEqual(wallMountIssues(separate.map, []), []);
});

test('explicit horizontal heights outside available walls report an empty fit', () => {
  const result = placeWallMounts(room(), settings({ runHeight: { mode: 'fixed', reference: 'floor', min: 8, max: 8 } }), []);
  assert.equal(result.addedModules, 0); assert.ok(result.issues.some(issue => issue.code === 'wall-run-height-fit'));
});
