import assert from 'node:assert/strict';
import test from 'node:test';
import { NEW_WALL_SETTINGS, DEFAULT_WALL_SETTINGS, placeWallMounts, reapplyWallRuns, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import { handleWallHeightSetting, renderWallMountSettings } from '../src/wall-mount-ui';
import type { AssetBinding, GenerationSettings, GridMap, MapFixture, WallMountSettings } from '../src/shared/types';
import { DEFAULT_SETTINGS, buildManifest, parseProjectFile } from '../src/shared/map';
import { DEFAULT_DESIGNER } from '../src/shared/features';

function room(): GridMap { return { version: 5, name: 'Composed services', width: 14, height: 10, cellSize: 2, maxStepHeight: .4, rows: ['##############', ...Array(8).fill('#............#'), '##############'], elevations: Array.from({ length: 10 }, () => Array(14).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
const config = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...NEW_WALL_SETTINGS, enabled: true, singles: false, ...patch });
function generated(seed: number, patch: Partial<WallMountSettings> = {}): GenerationSettings { return { ...DEFAULT_SETTINGS, width: 14, height: 10, cellSize: 2, maxStepHeight: .4, connectionCount: 1, seed, designer: { ...DEFAULT_DESIGNER, wallMounts: config(patch) } }; }
function kit(): AssetBinding[] { return WALL_PLACEHOLDER_KINDS.filter(k => k.startsWith('pipe')).map((kind, i) => { const b = placeholderWallBinding(kind); b.id = `native-${kind}`; b.prefabGuid = i.toString(16).repeat(32); b.prefabPath = `Assets/${b.id}.prefab`; b.wallMount!.family = 'Native'; return b; }); }
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-5;
function graph(map: GridMap, bindings: AssetBinding[] = []) {
  assert.deepEqual(wallMountIssues(map, bindings), []);
  for (const fixture of map.fixtures ?? []) for (const socket of fixture.wall!.sockets) {
    const peers = map.fixtures!.flatMap(other => other === fixture ? [] : other.wall!.sockets.filter(s => near(socket.position, s.position) && near(socket.direction, { x: -s.direction.x, y: -s.direction.y, z: -s.direction.z })).map(() => other));
    assert.equal(peers.length, 1); assert.equal(peers[0].wall!.runId, fixture.wall!.runId);
  }
}
function horizontalLevels(group: MapFixture[]) { return new Set(group.filter(f => f.wall!.sockets.length === 2 && f.wall!.sockets.every(s => Math.abs(s.direction.y) < 1e-5)).map(f => Number(f.wall!.sockets[0].position.y.toFixed(5)))); }

test('composed services join two horizontal levels through two native elbows and capped risers', () => {
  for (const bindings of [[], kit()]) {
    const before = structuredClone(bindings), placed = placeWallMounts(room(), generated(17), bindings);
    assert.ok(placed.addedModules > 0); graph(placed.map, bindings);
    const runs = [...new Set(placed.map.fixtures!.map(f => f.wall!.runId))];
    assert.ok(runs.some(run => horizontalLevels(placed.map.fixtures!.filter(f => f.wall!.runId === run)).size >= 2));
    assert.ok(runs.some(run => { const group = placed.map.fixtures!.filter(f => f.wall!.runId === run); return group.some(f => f.wall!.site === 'corner') && horizontalLevels(group).size >= 2; }), 'a stepped main route continues around a native wall corner');
    assert.deepEqual(bindings, before);
    assert.deepEqual(placeWallMounts(room(), generated(17), [...bindings].reverse()).map, placed.map);
    assert.deepEqual(placeWallMounts(placed.map, generated(17), bindings).map, placed.map);
    assert.equal(reapplyWallRuns(placed.map, generated(17), bindings).unchanged, true);
  }
});

test('parallel services share a boundary corridor and coordinated native height transitions', () => {
  for (const bindings of [[], kit()]) {
    const placed = placeWallMounts(room(), generated(17, { runDensity: 100 }), bindings); graph(placed.map, bindings);
    const runIds = [...new Set(placed.map.fixtures!.map(f => f.wall!.runId!))], pair = runIds.find(id => id.endsWith('-0') && runIds.includes(`${id.slice(0, -1)}1`));
    assert.ok(pair, 'high density produces coordinated parallel spines when the walls have room');
    const first = placed.map.fixtures!.filter(f => f.wall!.runId === pair), second = placed.map.fixtures!.filter(f => f.wall!.runId === `${pair.slice(0, -1)}1`);
    assert.ok(first.some(f => f.wall!.site === 'corner')); assert.ok(second.some(f => f.wall!.site === 'corner'));
    assert.equal(horizontalLevels(first).size, 2); assert.equal(horizontalLevels(second).size, 2);
    const firstHeights = [...horizontalLevels(first)].sort((a, b) => a - b), secondHeights = [...horizontalLevels(second)].sort((a, b) => a - b);
    assert.ok(Math.abs((firstHeights[1] - firstHeights[0]) - (secondHeights[1] - secondHeights[0])) < 1e-5);
    const cornersA = first.filter(f => f.wall!.site === 'corner'), cornersB = second.filter(f => f.wall!.site === 'corner');
    for (const corner of cornersA) assert.ok(cornersB.some(other => Math.hypot(corner.wall!.position.x - other.wall!.position.x, corner.wall!.position.z - other.wall!.position.z) < 1e-5));
    const riser = (group: MapFixture[]) => group.find(f => f.wall!.sockets.length === 2 && f.wall!.sockets.every(s => Math.abs(s.direction.y) > .99))!;
    const riserA = riser(first), riserB = riser(second), spacing = Math.hypot(riserA.wall!.position.x - riserB.wall!.position.x, riserA.wall!.position.z - riserB.wall!.position.z);
    assert.ok(spacing >= .1 && spacing <= 3, 'parallel risers share one transition area with deliberate physical separation');
    assert.deepEqual(placeWallMounts(placed.map, generated(17, { runDensity: 100 }), bindings).map, placed.map);
    assert.equal(reapplyWallRuns(placed.map, generated(17, { runDensity: 100 }), bindings).unchanged, true);
  }
});

test('composed native corner and height paths persist and export their exact root poses', () => {
  const bindings = kit(), settings = generated(19, { runDensity: 80 }), source = room();
  source.rows[0] = '######D#######'; source.connections = [{ id: 'entry', label: 'Entry', x: 6, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }];
  for (const [index, role] of (['floor', 'wall', 'door'] as const).entries()) bindings.push({ id: role, label: role, role, prefabGuid: String(index + 7).repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 } });
  const placed = placeWallMounts(source, settings, bindings);
  const project = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map: placed.map, settings, bindings })));
  graph(project.map, project.bindings); assert.deepEqual(project.map.fixtures, placed.map.fixtures);
  const manifest = buildManifest(project.map, project.bindings);
  for (const fixture of project.map.fixtures!) {
    const placement = manifest.placements.find(p => p.id === `fixture-${fixture.id}`)!;
    assert.deepEqual(placement.position, fixture.wall!.position); assert.equal(placement.rotation.y, fixture.wall!.rotationY); assert.equal(placement.rotation.z, fixture.wall!.rotationZ ?? 0);
  }
});

test('native off-pivot routes support both rising and descending transitions without scaling', () => {
  const bindings = kit();
  for (const b of bindings) for (const p of [b.bounds!.center, ...b.wallMount!.mounts.map(s => s.position), ...b.wallMount!.sockets.map(s => s.position), ...b.wallMount!.collisionBoxes.map(box => box.center)]) { p.x += 2.25; p.y += .35; p.z -= 1.2; }
  const before = structuredClone(bindings), directions = new Set<number>();
  for (const seed of [2, 3, 17]) {
    const placed = placeWallMounts(room(), generated(seed), bindings); graph(placed.map, bindings);
    for (const runId of new Set(placed.map.fixtures!.map(f => f.wall!.runId))) {
      const group = placed.map.fixtures!.filter(f => f.wall!.runId === runId), horizontal = group.filter(f => f.wall!.sockets.length === 2 && f.wall!.sockets.every(s => Math.abs(s.direction.y) < 1e-5));
      if (horizontalLevels(group).size < 2) continue;
      directions.add(Math.sign(horizontal.at(-1)!.wall!.sockets[0].position.y - horizontal[0].wall!.sockets[0].position.y));
    }
  }
  assert.deepEqual(directions, new Set([-1, 1])); assert.deepEqual(bindings, before);
});

test('mixed native lengths fill the removed straight span exactly after a height transition', () => {
  const bindings = kit(), long = structuredClone(bindings.find(b => b.wallMount!.kind === 'straight')!);
  long.id = 'native-long-straight'; long.prefabGuid = 'b'.repeat(32); long.prefabPath = 'Assets/long.prefab'; long.bounds!.size.x = 2;
  long.wallMount!.sockets[0].position.x = -1; long.wallMount!.sockets[1].position.x = 1; bindings.push(long);
  const placed = placeWallMounts(room(), generated(17), bindings); graph(placed.map, bindings);
  assert.ok(placed.map.fixtures!.some(f => f.bindingId === long.id));
  const runs = [...new Set(placed.map.fixtures!.map(f => f.wall!.runId))];
  assert.ok(runs.some(run => { const group = placed.map.fixtures!.filter(f => f.wall!.runId === run); return group.some(f => f.wall!.site === 'corner') && horizontalLevels(group).size >= 2; }));
});

test('composed route length follows density while preserving undecorated walls and sparse risers', () => {
  const low = placeWallMounts(room(), config({ runDensity: 20 }), []), high = placeWallMounts(room(), config({ runDensity: 100 }), []);
  graph(low.map); graph(high.map);
  assert.ok(low.addedModules < high.addedModules);
  assert.ok(new Set(low.map.fixtures!.flatMap(f => f.wall!.support.map(s => `${s.x},${s.row},${s.direction}`))).size < 40);
  const vertical = placeWallMounts(room(), config({ runOrientation: 'vertical', runDensity: 100 }), []); graph(vertical.map);
  assert.ok(vertical.runCount <= 4); assert.ok(vertical.addedModules > 0);
  const separate = placeWallMounts(room(), config({ connectRuns: false }), []); graph(separate.map);
  assert.ok(separate.map.fixtures!.some(f => f.wall!.sockets.every(s => Math.abs(s.direction.y) > .99)));
  assert.ok(!separate.map.fixtures!.some(f => ['pipeElbow', 'pipeTee'].includes(f.wall!.placeholder ?? '')));
  assert.ok(separate.map.fixtures!.some(f => f.wall!.site === 'corner'), 'disabling horizontal/vertical joins still permits same-height native wall corners');
});

test('fixed height, orientation, bounds and missing native parts remain hard constraints', () => {
  const fixed = placeWallMounts(room(), config({ runHeight: { mode: 'fixed', reference: 'top', min: 1.2, max: 1.2 } }), []); graph(fixed.map);
  assert.ok(fixed.addedModules > 0);
  for (const f of fixed.map.fixtures!) for (const socket of f.wall!.sockets) assert.ok(Math.abs(socket.position.y - 2.8) < 1e-5);
  const horizontal = placeWallMounts(room(), config({ runOrientation: 'horizontal' }), []); graph(horizontal.map);
  assert.ok(horizontal.map.fixtures!.every(f => f.wall!.sockets.every(s => Math.abs(s.direction.y) < 1e-5)));
  const noElbows = kit().filter(b => b.wallMount!.kind !== 'elbow'), simple = placeWallMounts(room(), config({ placeholderFallback: false }), noElbows); graph(simple.map, noElbows);
  assert.ok(simple.addedModules > 0); assert.ok(simple.issues.some(i => i.code === 'wall-composition-height-fit'));
  const noCaps = kit().filter(b => b.wallMount!.kind !== 'endCap'), empty = placeWallMounts(room(), config({ placeholderFallback: false }), noCaps);
  assert.equal(empty.addedModules, 0); assert.ok(empty.issues.some(i => i.code === 'wall-composition-fit'));
});

test('composed range heights, regions, obstacles and protected reapply stay valid', () => {
  const source = room(); source.lockedCells = [{ x: 4, row: 0 }];
  source.propInstances = [{ id: 'equipment', bindingId: 'cabinet', x: 8, row: 1, direction: 0, offset: { x: 0, y: 0, z: .7 }, cells: [{ x: 8, row: 1 }], size: { x: 1.5, y: 2.5, z: 1.5 }, blocksMovement: true, category: 'cabinet' }];
  const policy = config({ runHeight: { mode: 'random', reference: 'floor', min: .5, max: 3.5 }, verticalRange: { reference: 'floor', start: .2, end: 3.8 } });
  const placed = placeWallMounts(source, policy, []); graph(placed.map); assert.deepEqual(placed.map.propInstances, source.propInstances);
  for (const f of placed.map.fixtures!) assert.ok(f.wall!.support.every(s => s.x !== 4 || s.row !== 0));
  const partial = placeWallMounts(room(), config(), [], { x: 2, row: 0, width: 10, height: 2 }); graph(partial.map);
  for (const f of partial.map.fixtures!) assert.ok(f.wall!.support.every(s => s.x >= 2 && s.x < 12 && s.row < 2));
  const protectedMap = structuredClone(placed.map), runId = protectedMap.fixtures![0].wall!.runId;
  protectedMap.fixtures![0].wall!.authored = true;
  const preserved = protectedMap.fixtures!.filter(f => f.wall!.runId === runId), replanned = reapplyWallRuns(protectedMap, config({ runDensity: 70 }), []);
  assert.deepEqual(replanned.map.fixtures!.filter(f => f.wall!.runId === runId), preserved); graph(replanned.map);
});

test('new settings and controls opt into composition while legacy remains unchanged', () => {
  assert.equal(DEFAULT_WALL_SETTINGS.runLayout, undefined); assert.equal(DEFAULT_WALL_SETTINGS.runHeight, undefined);
  assert.equal(NEW_WALL_SETTINGS.enabled, false); assert.equal(NEW_WALL_SETTINGS.runLayout, 'composed');
  const updated = handleWallHeightSetting(handleWallHeightSetting(DEFAULT_WALL_SETTINGS, 'runLayout', 'composed'), 'runHeightMode', 'auto');
  assert.equal(updated.runHeight!.mode, 'auto'); assert.equal(DEFAULT_WALL_SETTINGS.runLayout, undefined);
  assert.match(renderWallMountSettings(updated), /wall-setting:runLayout/); assert.match(renderWallMountSettings(updated), /value="auto" selected/);
  assert.doesNotMatch(renderWallMountSettings(updated), /wall-setting:runHeightMin/);
  graph(placeWallMounts(room(), { ...updated, enabled: true, singles: false, runLayout: 'legacy' }, []).map);
});

test('single-wall composed fallback searches complete native families across horizontal and vertical modes', () => {
  const complete = kit().filter(b => ['straight', 'endCap', 'elbow'].includes(b.wallMount!.kind));
  complete.forEach(b => { b.wallMount!.family = 'ZComplete'; });
  const broken = structuredClone(complete.find(b => b.wallMount!.kind === 'straight')!); broken.id = 'broken-family-straight'; broken.wallMount!.family = 'ABroken';
  const bindings = [broken, ...complete], region = { x: 1, row: 0, width: 12, height: 2 };
  for (const orientation of ['horizontal', 'vertical', 'both'] as const) for (const seed of [0, 1, 2, 3, 4]) {
    const settings = generated(seed, { runDensity: 70, runOrientation: orientation, connectRuns: false, placeholderFallback: false });
    const placed = placeWallMounts(room(), settings, bindings, region);
    assert.ok(placed.addedModules > 0, `${orientation} seed ${seed} uses the available complete family`); graph(placed.map, bindings);
    assert.ok(placed.map.fixtures!.every(f => f.bindingId !== broken.id));
    assert.deepEqual(placeWallMounts(room(), settings, [...bindings].reverse(), region).map, placed.map);
    assert.deepEqual(placeWallMounts(placed.map, settings, bindings, region).map, placed.map);
    if (orientation === 'both') assert.ok(placed.map.fixtures!.some(f => f.wall!.sockets.every(s => Math.abs(s.direction.y) > .99)), 'independent risers also try the complete family');
  }
  const plain = complete.filter(b => b.wallMount!.kind !== 'elbow').map(binding => { const copy = structuredClone(binding); copy.id = `plain-${copy.id}`; copy.wallMount!.family = 'APlain'; return copy; });
  for (const seed of [0, 1, 2, 3]) {
    const placed = placeWallMounts(room(), generated(seed, { runDensity: 70, placeholderFallback: false }), [...plain, ...complete], region);
    graph(placed.map, [...plain, ...complete]);
    assert.ok(horizontalLevels(placed.map.fixtures!).size >= 2, 'a family with exact elbows is tried before settling for a capped plain fallback');
  }
  const disabled = structuredClone(complete); disabled.find(b => b.wallMount!.kind === 'endCap')!.wallMount!.probability = 0;
  assert.equal(placeWallMounts(room(), generated(0, { placeholderFallback: false }), [broken, ...disabled], region).addedModules, 0, 'family fallback never bypasses disabled end-cap probability');
});
