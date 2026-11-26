import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { clearGroupedPropHints, placeGroupedProps } from '../src/shared/grouped-props';
import { analyzeLevelDesign, createObstacleEvaluator, DEFAULT_LEVEL_DESIGN, placeLevelDesignContent } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { effectivePropCompositions } from '../src/shared/prop-composition';
import { propYaw } from '../src/shared/prop-orientation';
import { getPropCoverageReport, insertPropInstance, propPosition, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap, PropComposition, PropInstance, UnityPropSetMembership } from '../src/shared/types';

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
    for (const p of group) assert.deepEqual(p.size, propWorldSize(assets.find(b => b.id === p.bindingId)!, propYaw(p)));
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
  const s = settings(), anchor = asset('Desk', 'prop', { usage: 'equipment', family: 'workshop', member: 'anchor', arrangement: 'wall' });
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
  const anchor = asset('Desk', 'prop', { usage: 'equipment', family: 'station', member: 'anchor', arrangement: 'wall' });
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

test('small-only assets continue past the former group limit while preserving quiet space before coverage', () => {
  const s = settings(); s.width = 24; s.height = 20; s.designer!.propCoverage = 8;
  const binding = asset(), source = room(24, 20), result = placeGroupedProps(source, s, [binding]);
  const report = getPropCoverageReport(result.map, s, [binding]), arranged = groups(result.map);
  assert.ok(arranged.length > 5, 'the former five-group room limit must not stop measured furnishing');
  assert.ok(arranged.every(group => group.length >= 2 && group.length <= 4));
  assert.ok(report.actualPercent! > 0);
  assert.ok(report.occupiedArea < report.targetArea + 4 * 1.2 ** 2, 'only the final complete group may exceed the target');
  assert.equal(result.issues.some(i => i.code === 'grouped-props-unmet'), report.unmet);
  assert.ok(result.composition!.quietCells.length > 0);
  assert.ok(result.composition!.quietCells.every(c => !(result.map.propInstances ?? []).some(p => p.cells.some(n => n.x === c.x && n.row === c.row))));
  assert.deepEqual(propValidationIssues(result.map, [binding]), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  assert.deepEqual(placeGroupedProps(result.map, s, [binding]).map, result.map);
  const authored = structuredClone(result.map);
  for (const p of authored.propInstances!) { p.authored = true; p.provenance = 'manual'; }
  const alongsideAuthored = placeGroupedProps(authored, s, [binding]).map;
  for (const old of authored.propInstances!) assert.deepEqual(alongsideAuthored.propInstances!.find(p => p.id === old.id), old);
});

test('unreachable high coverage returns complete safe groups and a spatial constraint warning', () => {
  const s = settings(); s.width = 24; s.height = 20; s.designer!.propCoverage = 30;
  const binding = asset(), source = room(24, 20), before = structuredClone(source), result = placeGroupedProps(source, s, [binding]);
  assert.ok(groups(result.map).length > 5);
  assert.ok(groups(result.map).every(group => group.length >= 2 && group.length <= 4));
  assert.equal(getPropCoverageReport(result.map, s, [binding]).unmet, true);
  assert.ok(result.issues.some(i => i.code === 'grouped-props-unmet'));
  assert.ok(result.issues.every(i => !i.message.includes('상한')));
  assert.deepEqual(propValidationIssues(result.map, [binding]), []);
  assert.deepEqual(validateMap(result.map).filter(i => i.severity === 'error'), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  const arranged = groups(result.map);
  for (let i = 0; i < arranged.length; i++) for (let j = i + 1; j < arranged.length; j++)
    for (const a of arranged[i]) for (const b of arranged[j]) assert.ok(cellDistance(a, b) > 1);
  assert.deepEqual(source, before);
});

test('existing outside and crossing manual groups do not impose a regional group allowance', () => {
  const s = settings(); s.width = 40; s.height = 32; s.designer!.propCoverage = 8;
  const binding = asset(), region = { x: 20, row: 1, width: 18, height: 30 };
  const createExisting = (x: number) => {
    let source = insertPropInstance(room(40, 32), { x, row: 5 }, binding.id, s, [binding]);
    source = insertPropInstance(source, { x: x + 1, row: 5 }, binding.id, s, [binding]);
    for (const p of source.propInstances!) { p.groupId = 'existing'; p.provenance = 'manual'; }
    return source;
  };
  const outside = createExisting(2), overlapping = createExisting(19);
  for (const source of [outside, overlapping]) {
    const before = structuredClone(source), result = placeGroupedProps(source, s, [binding], region);
    const addedGroups = groups(result.map).filter(group => group[0].groupId !== 'existing');
    assert.ok(addedGroups.length > 3, 'regional furnishing must continue beyond the former three-group allowance');
    assert.deepEqual(result.map.propInstances!.filter(p => p.groupId === 'existing'), source.propInstances);
    for (const prop of addedGroups.flat()) assert.ok(prop.cells.every(c => c.x >= region.x && c.x < region.x + region.width && c.row >= region.row && c.row < region.row + region.height));
    for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++)
      if (x < region.x || x >= region.x + region.width || row < region.row || row >= region.row + region.height) assert.equal(result.map.rows[row][x], source.rows[row][x]);
    assert.deepEqual(propValidationIssues(result.map, [binding]), []);
    assert.deepEqual(source, before);
  }
});

test('every added group advances decoration demand when existing props already meet their coverage target', () => {
  const s = settings(); s.designer!.decorations = true; s.designer!.decorationDensity = 3;
  const composition = { usage: 'equipment', family: 'station', arrangement: 'island' } as const;
  const anchor = asset('Anchor', 'prop', { ...composition, member: 'anchor' });
  const prop = asset('Companion', 'prop', { ...composition, member: 'companion' }); prop.prop!.weight = 10000;
  const detail = asset('Detail', 'decoration', { ...composition, member: 'companion' }); detail.prop!.weight = .001;
  const assets = [anchor, prop, detail]; let source = room();
  for (let x = 2; x <= 8; x++) source = insertPropInstance(source, { x, row: 2 }, anchor.id, s, assets);
  assert.equal(getPropCoverageReport(source, s, assets).unmet, false);
  const before = structuredClone(source), result = placeGroupedProps(source, s, assets), arranged = groups(result.map);
  assert.ok(arranged.length > 0, JSON.stringify(result.issues));
  assert.ok(arranged.every(group => group.some(member => member.role === 'decoration')), 'a surplus prop-only group cannot satisfy outstanding decoration demand');
  assert.ok(result.map.propInstances!.filter(member => member.role === 'decoration').length >= Math.ceil(16 * 14 * .03));
  assert.ok(!result.issues.some(i => i.code === 'grouped-props-unmet'));
  for (const fixed of before.propInstances!) assert.deepEqual(result.map.propInstances!.find(member => member.id === fixed.id), fixed);
  assert.deepEqual(propValidationIssues(result.map, assets), []);
  assert.deepEqual(placeGroupedProps(result.map, s, assets).map, result.map);
  assert.deepEqual(source, before);
});

test('elongated rooms follow their focal scene and leave connected quiet space without uniform thirds', () => {
  for (const [width, height] of [[40, 10], [10, 40]]) {
    const s = settings(); s.width = width; s.height = height; s.designer!.propCoverage = 2;
    const binding = asset('Crate', 'prop', { usage: 'storage', family: 'storage', member: 'either', arrangement: 'island' });
    const source = room(width, height), result = placeGroupedProps(source, s, [binding]), arranged = groups(result.map);
    const focal = new Set(result.composition!.focal!.cells.map(c => `${c.x},${c.row}`));
    assert.ok(arranged.some(group => group.some(prop => prop.cells.some(c => focal.has(`${c.x},${c.row}`)))), `${width}×${height}: a visible focal scene`);
    assert.ok(result.composition!.quietCells.length >= 4);
    assert.ok(result.composition!.quietCells.every(c => result.map.rows[c.row][c.x] === '.'));
    assert.equal(getPropCoverageReport(result.map, s, [binding]).unmet, false);
    assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
    assert.deepEqual(result, placeGroupedProps(source, s, [binding]));
  }
});

test('either arrangements consider interior positions alongside walls with deterministic catalog ordering', () => {
  const composition = { usage: 'storage', family: 'storage', member: 'either', arrangement: 'either' } as const;
  const assets = [asset('Crate_A', 'prop', composition), asset('Crate_B', 'prop', composition)];
  const s = settings(); s.designer!.propCoverage = 3;
  const source = room(), result = placeGroupedProps(source, s, assets);
  assert.ok(groups(result.map).some(group => group.every(prop => prop.cells.every(c => c.x > 1 && c.x < source.width - 2 && c.row > 1 && c.row < source.height - 2))), 'safe interior candidates must compete before wall space is exhausted');
  assert.deepEqual(result, placeGroupedProps(source, s, [...assets].reverse()));
  assert.deepEqual(propValidationIssues(result.map, assets), []);
});

test('prefabs with equal floor footprints retain their independent height and authored offset constraints', () => {
  const cases: { name: string; reject: (binding: AssetBinding) => void }[] = [
    { name: 'height', reject: binding => { binding.prop!.size!.y = 3; } },
    { name: 'vertical offset', reject: binding => { binding.offset.y = 1.5; } },
    { name: 'horizontal offset', reject: binding => { binding.offset.x = .5; } },
  ];
  for (const scenario of cases) {
    const composition = { usage: 'equipment', family: 'station', arrangement: 'island' } as const;
    const rejected = asset('Rejected', 'prop', { ...composition, member: 'anchor' });
    rejected.prop!.weight = 10000; scenario.reject(rejected);
    const anchor = asset('Fitting', 'prop', { ...composition, member: 'anchor' });
    const companion = asset('Companion', 'prop', { ...composition, member: 'companion' });
    const assets = [rejected, anchor, companion], source = room(), s = settings();
    source.ceilings = source.rows.flatMap((row, r) => [...row].flatMap((tile, x) => tile === '.' ? [{ x, row: r, undersideY: 2.2 }] : []));
    const before = structuredClone(source), result = placeGroupedProps(source, s, assets);
    assert.ok(groups(result.map).length > 0, `${scenario.name}: an unfit prefab must not exclude a fitting prefab with the same floor footprint`);
    assert.ok(result.map.propInstances!.every(prop => prop.bindingId !== rejected.id), scenario.name);
    assert.ok(groups(result.map).every(group => group.some(prop => prop.bindingId === anchor.id)), scenario.name);
    assert.equal(getPropCoverageReport(result.map, s, assets).unmet, false, scenario.name);
    assert.deepEqual(propValidationIssues(result.map, assets), [], scenario.name);
    assert.deepEqual(result, placeGroupedProps(source, s, [...assets].reverse()), scenario.name);
    assert.deepEqual(source, before);
  }
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

const unitySet = (id: number, usage: UnityPropSetMembership['usage'] = 'equipment'): UnityPropSetMembership => ({
  guid: id.toString(16).padStart(32, '0'), label: `Unity set ${id}`, usage, arrangement: 'island',
});
function setAsset(id: string, sets: UnityPropSetMembership[]): AssetBinding {
  const binding = asset(id); binding.prop!.unitySets = structuredClone(sets); return binding;
}

test('Unity prefab lists make unknown names eligible and prefer different fitting members before repeats', () => {
  const set = unitySet(1), assets = ['SM_A001', 'SM_A002', 'SM_A003', 'SM_A004'].map(id => setAsset(id, [set]));
  const before = structuredClone(assets), s = settings(); s.designer!.propCoverage = 5;
  const result = placeGroupedProps(room(), s, assets);
  assert.ok(groups(result.map).length, JSON.stringify(result.issues));
  assert.ok(!result.issues.some(i => i.code === 'grouped-props-unknown'));
  for (const group of groups(result.map)) assert.equal(new Set(group.map(p => p.bindingId)).size, group.length, 'fit distinct list members before repeating a prefab');
  assert.deepEqual(assets, before);
  assert.deepEqual(result, placeGroupedProps(room(), s, [...assets].reverse()));
});

test('a prefab shared by Unity lists does not connect otherwise different sets into one group', () => {
  const a = unitySet(1), b = unitySet(2), assets = [setAsset('SM_A001', [a]), setAsset('SM_A002', [a, b]), setAsset('SM_A003', [b])];
  const s = settings(); s.designer!.propCoverage = 12;
  const result = placeGroupedProps(room(), s, assets);
  assert.ok(groups(result.map).length, JSON.stringify(result.issues));
  for (const group of groups(result.map)) {
    const sharedSets = assets.find(binding => binding.id === group[0].bindingId)!.prop!.unitySets!.filter(set => group.every(p =>
      assets.find(binding => binding.id === p.bindingId)!.prop!.unitySets!.some(other => other.guid === set.guid)));
    assert.ok(sharedSets.length, `one common set must cover the complete group: ${group.map(p => p.bindingId)}`);
  }
  const reversedMemberships = structuredClone(assets); reversedMemberships[1].prop!.unitySets!.reverse();
  assert.deepEqual(result, placeGroupedProps(room(), s, reversedMemberships));
});

test('manual composition and exclusion take precedence over imported Unity lists', () => {
  const set = unitySet(1), manual = setAsset('SM_A001', [set]), excluded = setAsset('SM_A002', [set]);
  manual.prop!.composition = { usage: 'storage', family: 'manual', member: 'either', arrangement: 'island' };
  excluded.prop!.composition = { usage: 'excluded', family: 'excluded', member: 'either', arrangement: 'either' };
  assert.deepEqual(effectivePropCompositions(manual), [manual.prop!.composition]);
  const copy = effectivePropCompositions(manual); copy[0].family = 'changed'; assert.equal(manual.prop!.composition.family, 'manual');
  const result = placeGroupedProps(room(), settings(), [manual, excluded]);
  assert.ok(groups(result.map).length);
  assert.ok(result.map.propInstances!.every(p => p.bindingId === manual.id));
  assert.ok(result.issues.some(i => i.code === 'grouped-props-excluded'));
});

test('matching family names cannot join equipment and natural members', () => {
  const anchor = asset('SM_A001', 'prop', { usage: 'equipment', family: 'same-name', member: 'anchor', arrangement: 'island' });
  const companion = asset('SM_A002', 'prop', { usage: 'natural', family: 'same-name', member: 'companion', arrangement: 'island' });
  assert.equal(placeGroupedProps(room(), settings(), [anchor, companion]).map.propInstances?.length ?? 0, 0);
});

test('a repeated prefab remains available when other Unity list members cannot fit', () => {
  const set = unitySet(1), small = setAsset('SM_A001', [set]), large = setAsset('SM_A002', [set]);
  large.prop!.size = { x: 100, y: 1, z: 100 };
  const result = placeGroupedProps(room(), settings(), [small, large]);
  assert.ok(groups(result.map).length);
  assert.ok(result.map.propInstances!.every(p => p.bindingId === small.id));
});

test('first group selection varies with the seed, respects weights and does not multiply shared memberships', () => {
  const set = unitySet(1), assets = [setAsset('SM_A001', [set]), setAsset('SM_A002', [set])], s = settings();
  s.width = 10; s.height = 10;
  const source = room(10, 10), first = (catalog: AssetBinding[], seed: number) => placeGroupedProps(source, { ...s, seed }, catalog).map.propInstances?.[0]?.bindingId;
  const equal = new Set<string | undefined>(), weighted = new Map<string | undefined, number>();
  const heavy = structuredClone(assets); heavy[0].prop!.weight = 4;
  const overlap = structuredClone(heavy); overlap[0].prop!.unitySets!.push(unitySet(2), unitySet(3));
  const disabled = setAsset('SM_A003', [set]); disabled.prop!.weight = 0;
  for (let seed = 0; seed < 64; seed++) {
    equal.add(first(assets, seed));
    const winner = first(heavy, seed); weighted.set(winner, (weighted.get(winner) ?? 0) + 1);
    assert.equal(first(overlap, seed), winner, 'extra list memberships must not increase a prefab selection weight');
    assert.equal(first([...heavy, disabled], seed), winner, 'weight zero must not alter the active candidate draw');
  }
  assert.deepEqual(equal, new Set(assets.map(binding => binding.id)));
  assert.ok(!weighted.has(undefined));
  assert.ok((weighted.get(assets[0].id) ?? 0) > (weighted.get(assets[1].id) ?? 0));
  assert.ok((weighted.get(assets[1].id) ?? 0) >= 4, 'lower weights must remain possible across seeds');
});
