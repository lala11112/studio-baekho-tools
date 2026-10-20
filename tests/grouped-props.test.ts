import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { clearGroupedPropHints, placeGroupedProps } from '../src/shared/grouped-props';
import { analyzeLevelDesign, createObstacleEvaluator, DEFAULT_LEVEL_DESIGN, placeLevelDesignContent } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { insertPropInstance, propPosition, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap, PropComposition, PropInstance } from '../src/shared/types';

function room(width = 18, height = 16): GridMap {
  const doorX = Math.floor(width / 2), rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(doorX) + 'D' + '#'.repeat(width - doorX - 1);
  return { version: 5, name: 'Grouped', width, height, cellSize: 2, maxStepHeight: .4, rows, elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: doorX, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 18, height: 16, connectionCount: 1, seed: 237,
    designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: true, propLayout: 'grouped', propCoverage: 1, decorations: false, vegetation: false, decorationDensity: 1, vegetationDensity: 1 },
    levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
}
function asset(id = 'Crate', role: 'prop' | 'decoration' | 'vegetation' = 'prop', composition?: PropComposition): AssetBinding {
  return { id, label: id, role, prefabGuid: (id.length + 1).toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: id, tags: [], blocksMovement: role === 'prop', size: { x: 1.2, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['shop', 'battle'], weight: 1, ...(composition ? { composition } : {}) } };
}
const groups = (map: GridMap) => [...new Set((map.propInstances ?? []).map(p => p.groupId))].filter(Boolean).map(id => map.propInstances!.filter(p => p.groupId === id));
const cellDistance = (a: PropInstance, b: PropInstance) => Math.min(...a.cells.flatMap(c => b.cells.map(n => Math.max(Math.abs(c.x - n.x), Math.abs(c.row - n.row)))));

test('grouped placement is deterministic, native-sized, compact within a group and separated between groups', () => {
  const map = room(), before = structuredClone(map), s = settings(), assets = [asset('Crate_A'), asset('Crate_B')];
  assets[1].scale.x = 1.1;
  const result = placeGroupedProps(map, s, assets);
  assert.ok(result.map.propInstances!.length >= 2, JSON.stringify(result.issues));
  assert.deepEqual(map, before);
  assert.deepEqual(result, placeGroupedProps(map, s, [...assets].reverse()));
  assert.notDeepEqual(result.map.propInstances, placeGroupedProps(map, { ...s, seed: 238 }, assets).map.propInstances);
  const placedGroups = groups(result.map);
  for (const group of placedGroups) {
    assert.ok(group.length >= 2 && group.length <= 4);
    assert.ok(group.every(p => p.provenance === 'generated'));
    assert.ok(group.slice(1).every(p => group.some(other => other !== p && cellDistance(p, other) === 1)));
    for (const p of group) assert.deepEqual(p.size, propWorldSize(assets.find(b => b.id === p.bindingId)!, p.direction));
  }
  for (let i = 0; i < placedGroups.length; i++) for (let j = i + 1; j < placedGroups.length; j++)
    for (const a of placedGroups[i]) for (const b of placedGroups[j]) assert.ok(cellDistance(a, b) > 1);
  assert.deepEqual(propValidationIssues(result.map, assets), []);
  assert.deepEqual(validateMap(result.map).filter(i => i.severity === 'error'), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  assert.deepEqual(placeGroupedProps(result.map, s, assets).map, result.map);
});

test('wall equipment faces into the room and uses neighboring footprints without a blank cell inside the group', () => {
  const assets = [asset('Console')], result = placeGroupedProps(room(), settings(), assets), map = result.map;
  assert.ok(groups(map).length, JSON.stringify(result.issues));
  for (const group of groups(map)) {
    assert.ok(group.every(p => p.direction === group[0].direction));
    for (const p of group) {
      const side = (p.direction + 180) % 360;
      assert.ok(p.cells.some(c => side === 0 ? map.rows[c.row - 1]?.[c.x] === '#' : side === 180 ? map.rows[c.row + 1]?.[c.x] === '#' : side === 90 ? map.rows[c.row]?.[c.x + 1] === '#' : map.rows[c.row]?.[c.x - 1] === '#'));
    }
    const a = group[0], b = group.find(p => p !== a && cellDistance(a, p) === 1)!;
    const ap = propPosition(map, a, assets[0]), bp = propPosition(map, b, assets[0]);
    const edgeGap = Math.max(Math.abs(ap.x - bp.x) - (a.size.x + b.size.x) / 2, Math.abs(ap.z - bp.z) - (a.size.z + b.size.z) / 2);
    assert.ok(edgeGap < map.cellSize / 2, `physical gap ${edgeGap}`);
  }
});

test('a cluster is accepted atomically only when its complete blocking union leaves safe combat circulation', () => {
  const s = settings(); s.designer!.preset = 'battle';
  const source = room(), assets = [asset()], result = placeGroupedProps(source, s, assets);
  assert.ok(groups(result.map).length, JSON.stringify(result.issues));
  for (const group of groups(result.map)) assert.ok(createObstacleEvaluator(source, s)(group.filter(p => p.blocksMovement).flatMap(p => p.cells)));
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  assert.deepEqual(propValidationIssues(result.map, assets), []);
});

test('incompatible families and an unfit companion never degrade into solitary scattered anchors', () => {
  const s = settings(), anchor = asset('Console', 'prop', { usage: 'equipment', family: 'workshop', member: 'anchor', arrangement: 'wall' });
  const other = asset('Chair', 'prop', { usage: 'equipment', family: 'different', member: 'companion', arrangement: 'wall' });
  assert.equal(placeGroupedProps(room(), s, [anchor, other]).map.propInstances?.length ?? 0, 0);
  other.prop!.composition!.family = 'workshop'; other.prop!.size = { x: 100, y: 1, z: 100 };
  const result = placeGroupedProps(room(), s, [anchor, other]);
  assert.equal(result.map.propInstances?.length ?? 0, 0);
  assert.ok(result.issues.some(i => i.code === 'grouped-props-unmet'));
});

test('unknown, floor detail, edge and explicitly excluded assets are diagnosed instead of scattered', () => {
  const source = room(); source.rows[4] = source.rows[4].slice(0, 4) + 'P' + source.rows[4].slice(5);
  const assets = [asset('SM_A001'), asset('Floor_Panel'), asset('Railing'), asset('Crate', 'prop', { usage: 'excluded', family: 'excluded', member: 'either', arrangement: 'either' })];
  const result = placeGroupedProps(source, settings(), assets);
  assert.equal(result.map.propInstances?.length ?? 0, 0); assert.equal(result.map.rows[4][4], '.');
  assert.ok(result.issues.some(i => i.code === 'grouped-props-unknown'));
  assert.ok(result.issues.some(i => i.code === 'grouped-props-floor-detail'));
  assert.ok(result.issues.some(i => i.code === 'grouped-props-edge'));
});

test('role switches, themes, room restrictions and explicit member choices govern the entire group', () => {
  const anchor = asset('Console', 'prop', { usage: 'equipment', family: 'station', member: 'anchor', arrangement: 'wall' });
  const companion = asset('Chair', 'decoration', { usage: 'equipment', family: 'station', member: 'companion', arrangement: 'wall' });
  const s = settings();
  assert.equal(placeGroupedProps(room(), s, [anchor, companion]).map.propInstances?.length ?? 0, 0);
  s.designer!.decorations = true;
  const result = placeGroupedProps(room(), s, [anchor, companion]);
  assert.ok(groups(result.map).length, JSON.stringify(result.issues));
  assert.ok(groups(result.map).every(g => g[0].bindingId === anchor.id && g.slice(1).every(p => p.bindingId === companion.id)));
  s.designer!.decorationDensity = 0;
  assert.equal(placeGroupedProps(room(), s, [anchor, companion]).map.propInstances?.length ?? 0, 0);
  s.designer!.decorationDensity = 1;
  companion.prop!.tags = ['forest']; s.levelDesign!.theme = 'factory';
  assert.equal(placeGroupedProps(room(), s, [anchor, companion]).map.propInstances?.length ?? 0, 0);
  companion.prop!.tags = []; companion.prop!.roomTypes = ['battle'];
  assert.equal(placeGroupedProps(room(), s, [anchor, companion]).map.propInstances?.length ?? 0, 0);
});

test('vegetation joins natural groups only when its generation switch is enabled', () => {
  const s = settings(); s.designer!.props = false;
  const assets = [asset('Bush', 'vegetation')];
  assert.equal(placeGroupedProps(room(), s, assets).map.propInstances?.length ?? 0, 0);
  s.designer!.vegetation = true;
  const result = placeGroupedProps(room(), s, assets);
  assert.ok(groups(result.map).length); assert.ok(result.map.propInstances!.every(p => p.role === 'vegetation' && !p.blocksMovement));
});

test('measured manual content, locks, explicit proxies and region boundaries survive additive grouping', () => {
  const s = settings(), assets = [asset()], source = insertPropInstance(room(), { x: 2, row: 3 }, assets[0].id, s, assets);
  source.propInstances![0].provenance = 'manual';
  source.lockedCells = [{ x: 4, row: 4 }];
  source.rows[4] = source.rows[4].slice(0, 4) + 'P' + source.rows[4].slice(5);
  source.rows[5] = source.rows[5].slice(0, 4) + 'P' + source.rows[5].slice(5);
  source.assetOverrides.push({ x: 4, row: 5, role: 'prop', bindingId: assets[0].id });
  source.rows[6] = source.rows[6].slice(0, 4) + 'P' + source.rows[6].slice(5);
  const before = structuredClone(source), region = { x: 5, row: 1, width: 11, height: 13 }, result = placeGroupedProps(source, s, assets, region);
  assert.deepEqual(source, before); assert.deepEqual(result.map.propInstances!.find(p => p.id === before.propInstances![0].id), before.propInstances![0]);
  assert.equal(result.map.rows[4][4], 'P'); assert.equal(result.map.rows[5][4], 'P'); assert.equal(result.map.rows[6][4], 'P');
  assert.deepEqual(result.map.lockedCells, before.lockedCells); assert.deepEqual(result.map.assetOverrides, before.assetOverrides);
  for (const p of result.map.propInstances!.filter(p => p.provenance === 'generated')) assert.ok(p.cells.every(c => c.x >= region.x && c.row >= region.row && c.x < region.x + region.width && c.row < region.row + region.height));
});

test('no-space, ceiling and external acceptance failures roll back all proposed members', () => {
  const s = settings(), assets = [asset()], source = room(), region = { x: 2, row: 2, width: 2, height: 2 };
  const rejected = placeGroupedProps(source, s, assets, region, [], () => false);
  assert.deepEqual(rejected.map, source); assert.ok(rejected.issues.some(i => i.code === 'grouped-props-unmet'));
  source.ceilings = Array.from({ length: 14 }, (_, row) => Array.from({ length: 16 }, (_, x) => ({ x: x + 1, row: row + 1, undersideY: .5 }))).flat();
  const tooLow = placeGroupedProps(source, s, assets);
  assert.equal(tooLow.map.propInstances?.length ?? 0, 0);
  assert.deepEqual(tooLow.map, source);
});

test('automatically resolved floor fixtures reserve their complete rotated and offset bounds', () => {
  const s = settings(); s.designer!.propCoverage = 12;
  const prop = asset(), fixture = asset('Floor_Panel', 'decoration');
  fixture.prop!.size = { x: 8, y: 1, z: 4 }; fixture.rotationY = 90;
  fixture.bounds = { center: { x: 1, y: .5, z: 0 }, size: { ...fixture.prop!.size } };
  fixture.offset.x = 1;
  const source = room(); source.fixtures = [{ id: 'automatic-panel', role: 'decoration', x: 6, row: 6, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  const result = placeGroupedProps(source, s, [prop, fixture]);
  assert.ok(groups(result.map).length);
  // The 90° rotation puts the panel center one meter south of its pivot, then its authored X correction applies.
  const fixtureX = (6 - (source.width - 1) / 2) * 2 + 1, fixtureZ = ((source.height - 1) / 2 - 6) * 2 - 1;
  for (const p of result.map.propInstances ?? []) {
    const position = propPosition(result.map, p, prop);
    assert.ok(Math.abs(position.x - fixtureX) >= (p.size.x + 4) / 2 - 1e-6 || Math.abs(position.z - fixtureZ) >= (p.size.z + 8) / 2 - 1e-6);
  }
  assert.deepEqual(result.map.fixtures, source.fixtures);
});

test('overhead fixture bounds allow a group below them only when their vertical ranges do not intersect', () => {
  const s = settings(), prop = asset(), light = { ...asset('Lamp', 'decoration'), role: 'light' as const, prop: undefined,
    bounds: { center: { x: 0, y: -.25, z: 0 }, size: { x: 30, y: .5, z: 30 } } };
  const source = room(); source.ceilings = [{ x: 6, row: 6, undersideY: 4 }];
  source.fixtures = [{ id: 'overhead', role: 'light', anchor: 'ceiling', x: 6, row: 6, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  const region = { x: 2, row: 2, width: 10, height: 10 };
  assert.ok(groups(placeGroupedProps(source, s, [prop, light], region).map).length);
  source.ceilings[0].undersideY = 1.25;
  assert.equal(placeGroupedProps(source, s, [prop, light], region).map.propInstances?.length ?? 0, 0);
});

test('nonblocking objects in the prop role do not consume the obstacle target or become standalone props', () => {
  const binding = asset(); binding.prop!.blocksMovement = false;
  const result = placeGroupedProps(room(), settings(), [binding]);
  assert.equal(result.map.propInstances?.length ?? 0, 0);
  assert.ok(result.issues.some(i => i.code === 'grouped-props-nonblocking-prop'));
});

test('high coverage with small-only assets stops at the adaptive group limit and repeated furnishing adds nothing', () => {
  const s = settings(); s.width = 24; s.height = 20; s.designer!.propCoverage = 30;
  const binding = asset(), source = room(24, 20), result = placeGroupedProps(source, s, [binding]);
  const floorArea = 22 * 18 * 4, limit = Math.max(1, Math.min(8, Math.round(Math.sqrt(floorArea) / 8)));
  assert.equal(limit, 5); assert.equal(groups(result.map).length, limit);
  assert.ok(result.map.propInstances!.length <= limit * 4);
  assert.ok(result.issues.some(i => i.code === 'grouped-props-unmet' && i.message.includes('상한 5묶음')));
  assert.deepEqual(placeGroupedProps(result.map, s, [binding]).map, result.map);
  const authored = structuredClone(result.map);
  for (const p of authored.propInstances!) { p.authored = true; p.provenance = 'manual'; }
  assert.deepEqual(placeGroupedProps(authored, s, [binding]).map, authored);
});

test('only existing whole groups intersecting the requested region count toward its adaptive limit', () => {
  const s = settings(); s.width = 24; s.height = 20; s.designer!.propCoverage = 30;
  const binding = asset(), region = { x: 12, row: 1, width: 10, height: 18 };
  const createExisting = (x: number) => {
    let source = insertPropInstance(room(24, 20), { x, row: 5 }, binding.id, s, [binding]);
    source = insertPropInstance(source, { x: x + 1, row: 5 }, binding.id, s, [binding]);
    for (const p of source.propInstances!) { p.groupId = 'existing'; p.provenance = 'manual'; }
    return source;
  };
  const outside = createExisting(2), overlapping = createExisting(11);
  const outsideResult = placeGroupedProps(outside, s, [binding], region), overlappingResult = placeGroupedProps(overlapping, s, [binding], region);
  assert.equal(groups(outsideResult.map).length, 4, 'one outside group plus three new groups in the region');
  assert.equal(groups(overlappingResult.map).length, 3, 'one crossing group consumes one of the three regional slots');
  assert.deepEqual(outsideResult.map.propInstances!.filter(p => p.groupId === 'existing'), outside.propInstances);
  assert.deepEqual(overlappingResult.map.propInstances!.filter(p => p.groupId === 'existing'), overlapping.propInstances);
});

test('optional entrance hints are cleared before content placement without changing fixed occupancy or the source', () => {
  const s = settings(), binding = asset();
  const source = insertPropInstance(room(), { x: 2, row: 4 }, binding.id, s, [binding]);
  const hint = (x: number, row: number) => { source.rows[row] = source.rows[row].slice(0, x) + 'P' + source.rows[row].slice(x + 1); };
  hint(9, 1); hint(3, 3); hint(4, 4); hint(14, 6);
  source.lockedCells = [{ x: 3, row: 3 }]; source.assetOverrides.push({ x: 4, row: 4, role: 'prop', bindingId: binding.id });
  const before = structuredClone(source), region = { x: 1, row: 1, width: 10, height: 10 };
  assert.throws(() => placeLevelDesignContent(source, s));
  const cleared = clearGroupedPropHints(source, region);
  assert.equal(cleared.rows[1][9], '.'); assert.equal(cleared.rows[3][3], 'P'); assert.equal(cleared.rows[4][4], 'P'); assert.equal(cleared.rows[6][14], 'P');
  assert.deepEqual(cleared.propInstances, before.propInstances); assert.deepEqual(cleared.lockedCells, before.lockedCells); assert.deepEqual(cleared.assetOverrides, before.assetOverrides);
  assert.doesNotThrow(() => placeLevelDesignContent(cleared, s));
  assert.deepEqual(source, before);
  s.designer!.props = false; s.designer!.decorations = false; s.designer!.vegetation = false;
  assert.deepEqual(placeGroupedProps(source, s, [binding]).map, source);
});
