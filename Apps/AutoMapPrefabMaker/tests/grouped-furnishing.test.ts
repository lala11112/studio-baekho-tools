import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { furnishExistingMap, rearrangeMapProps } from '../src/shared/furnishing';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap, PropComposition, PropInstance } from '../src/shared/types';

function room(): GridMap {
  const width = 20, height = 20, rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(10) + 'D' + '#'.repeat(9);
  return { version: 5, name: 'Existing grouped room', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: 10, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 20, height: 20, connectionCount: 1, seed: 237,
    designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: false, decorations: false, vegetation: false,
      propLayout: 'grouped', propCoverage: 1, decorationDensity: 1 }, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
}
function asset(id = 'Crate', role: 'prop' | 'decoration' = 'prop', composition?: PropComposition): AssetBinding {
  return { id, label: id, role, prefabGuid: id.length.toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: id, tags: [], blocksMovement: role === 'prop', size: { x: 1.2, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['shop', 'battle'], weight: 1,
      ...(composition ? { composition } : {}) } };
}
function instance(id: string, x: number, row: number, binding = asset()): PropInstance {
  return { id, bindingId: binding.id, role: binding.role as 'prop' | 'decoration', x, row, direction: 0, offset: { x: 0, y: 0, z: 0 },
    cells: [{ x, row }], size: propWorldSize(binding)!, blocksMovement: binding.prop!.blocksMovement,
    category: binding.prop!.category, anchor: 'floor', provenance: 'generated' };
}
function withInstances(props: PropInstance[], base = room()): GridMap {
  const map = structuredClone(base), rows = map.rows.map(row => [...row]);
  map.propInstances = structuredClone(props);
  for (const prop of props) for (const cell of prop.cells) if (prop.blocksMovement) rows[cell.row][cell.x] = 'P';
  map.rows = rows.map(row => row.join('')); return map;
}
function assertGeographyPreserved(before: GridMap, after: GridMap): void {
  const { rows: oldRows, propInstances: oldProps, version: oldVersion, ...oldMetadata } = before;
  const { rows: newRows, propInstances: newProps, version: newVersion, ...newMetadata } = after;
  assert.deepEqual(newMetadata, oldMetadata);
  assert.deepEqual(newRows.map(row => row.replace(/P/g, '.')), oldRows.map(row => row.replace(/P/g, '.')));
}
const propsOnly = { props: true, decorations: false };

test('rearrangement reports moves without inventing additions, preserves IDs and geometry, and repeats stably', () => {
  const config = settings(), assets = [asset()], planned = furnishExistingMap(room(), config, assets, propsOnly);
  assert.ok(planned.addedProps >= 2, JSON.stringify(planned.issues));
  const scattered = planned.map.propInstances!.map((prop, i) => ({ ...structuredClone(prop), x: 2 + i % 5 * 3, row: 4 + Math.floor(i / 5) * 3,
    cells: [{ x: 2 + i % 5 * 3, row: 4 + Math.floor(i / 5) * 3 }], offset: { x: 0, y: 0, z: 0 } }));
  const source = withInstances(scattered), before = structuredClone(source), savedSettings = structuredClone(config), savedAssets = structuredClone(assets);
  const result = rearrangeMapProps(source, config, assets, propsOnly);
  assert.equal(result.addedProps, 0); assert.equal(result.addedDecorations, 0); assert.equal(result.removedProps, 0);
  assert.ok(result.movedProps > 0, JSON.stringify(result.issues)); assert.equal(result.unchanged, false);
  assert.deepEqual(new Set(result.map.propInstances!.map(prop => prop.id)), new Set(scattered.map(prop => prop.id)));
  assert.equal(result.map.propInstances!.length, scattered.length); assert.ok(result.groupCount > 0);
  assertGeographyPreserved(source, result.map); assert.deepEqual(source, before); assert.deepEqual(config, savedSettings); assert.deepEqual(assets, savedAssets);
  const repeated = rearrangeMapProps(result.map, config, assets, propsOnly);
  assert.equal(repeated.unchanged, true); assert.equal(repeated.movedProps, 0); assert.equal(repeated.addedProps, 0); assert.equal(repeated.removedProps, 0);
  assert.deepEqual(repeated.map, result.map);
});

test('manual placements, locks, direct assignments and unknown provenance remain fixed by default', () => {
  const config = settings(), assets = [asset()], props = [instance('manual', 2, 4), instance('authored', 5, 4), instance('prop_manual_8_4', 8, 4),
    instance('locked', 11, 4), instance('assigned', 14, 4), instance('unknown', 2, 8), instance('movable', 5, 8)];
  props[0].provenance = 'manual'; props[1].authored = true; delete props[5].provenance;
  const source = withInstances(props); source.lockedCells = [{ x: 11, row: 4 }];
  source.assetOverrides = [{ x: 14, row: 4, role: 'prop', bindingId: assets[0].id }];
  source.rows[14] = source.rows[14].slice(0, 16) + 'P' + source.rows[14].slice(17);
  const before = structuredClone(source), result = rearrangeMapProps(source, config, assets, propsOnly);
  for (const prop of props.slice(0, 6)) assert.deepEqual(result.map.propInstances!.find(item => item.id === prop.id), prop, prop.id);
  assert.equal(result.map.rows[14][16], 'P'); assert.ok(result.preservedProps >= 6);
  assert.ok(result.issues.some(issue => issue.code === 'furnishing-unknown-preserved'));
  assert.deepEqual(source, before); assertGeographyPreserved(source, result.map);
  const included = rearrangeMapProps(source, config, assets, { ...propsOnly, includeUnknown: true });
  for (const prop of props.slice(0, 5)) assert.deepEqual(included.map.propInstances!.find(item => item.id === prop.id), prop, prop.id);
  const oldUnknown = included.map.propInstances!.find(prop => prop.id === 'unknown');
  assert.ok(!oldUnknown || oldUnknown.x !== 2 || oldUnknown.row !== 8);
  assert.equal(included.map.rows[14][16], '.'); assert.ok(included.convertedPropPlaceholders > 0);
  assert.deepEqual(source, before); assertGeographyPreserved(source, included.map);
});

test('a manual or unselected member protects its entire mixed-role group during rearrangement', () => {
  const config = settings(), assets = [asset(), asset('SmallCrate', 'decoration')];
  const first = instance('anchor', 2, 5, assets[0]), second = instance('companion', 3, 5, assets[1]);
  first.groupId = second.groupId = 'existing-set';
  for (const manual of [false, true]) {
    const source = withInstances([first, second]);
    if (manual) source.propInstances![1].provenance = 'manual';
    const result = rearrangeMapProps(source, config, assets, { props: true, decorations: manual });
    for (const old of source.propInstances!) assert.deepEqual(result.map.propInstances!.find(prop => prop.id === old.id), old);
    assert.ok(result.preservedProps >= 2);
  }
});

test('late compatible companion registration adds complete groups while preserving every existing measured placement', () => {
  const config = settings(), manual = instance('fixed-storage', 3, 10); manual.provenance = 'manual';
  const fixedAsset = asset(); fixedAsset.prop!.weight = 0;
  const anchor = asset('Console', 'prop', { usage: 'equipment', family: 'workstation', member: 'anchor', arrangement: 'wall' });
  const companion = asset('Chair', 'decoration', { usage: 'equipment', family: 'workstation', member: 'companion', arrangement: 'wall' });
  const source = withInstances([manual]), before = structuredClone(source);
  const noPair = furnishExistingMap(source, config, [fixedAsset, anchor], { props: true, decorations: true });
  assert.equal(noPair.unchanged, true); assert.deepEqual(noPair.map, source);
  const catalog = [fixedAsset, anchor, companion], result = furnishExistingMap(source, config, catalog, { props: true, decorations: true });
  assert.ok(result.addedProps > 0 && result.addedDecorations > 0, JSON.stringify(result.issues));
  assert.deepEqual(result.map.propInstances!.find(prop => prop.id === manual.id), manual); assert.deepEqual(source, before);
  const added = result.map.propInstances!.filter(prop => prop.id !== manual.id);
  assert.ok(added.every(prop => prop.provenance === 'generated' && !!prop.groupId));
  assert.ok(added.some(prop => prop.bindingId === anchor.id)); assert.ok(added.some(prop => prop.bindingId === companion.id));
  assert.deepEqual(result, furnishExistingMap(source, config, [...catalog].reverse(), { props: true, decorations: true }));
  const repeated = furnishExistingMap(result.map, config, catalog, { props: true, decorations: true });
  assert.equal(repeated.unchanged, true); assert.deepEqual(repeated.map, result.map);
  assertGeographyPreserved(source, result.map);
});

test('grouped add and rearrange preserve raised terrain, roofs, gameplay data and existing fixtures exactly', () => {
  const config = settings(), assets = [asset(), asset('Console', 'decoration')], source = room();
  for (let row = 1; row <= 5; row++) for (let x = 1; x < 19; x++) source.elevations[row][x] = 2;
  source.elevations[0][10] = 2;
  for (const x of [3, 15]) { source.rows[6] = source.rows[6].slice(0, x) + 'R' + source.rows[6].slice(x + 1); source.ramps.push({ x, row: 6, direction: 0, rise: 2 }); }
  source.ceilings = Array.from({ length: 18 }, (_, row) => Array.from({ length: 18 }, (_, x) => ({ x: x + 1, row: row + 1, undersideY: 6, heightMode: 'manual' as const }))).flat();
  source.wallHeights = [{ x: 0, row: 5, height: 6, heightMode: 'manual' }];
  source.headroom = 2; source.zones = [{ x: 9, row: 10, kind: 'combat' }, { x: 2, row: 12, kind: 'reward' }];
  source.markers = [{ id: 'reward', label: 'Reward', kind: 'reward', x: 2, row: 12, direction: 90, contentKey: 'item', offset: { x: .1, y: 0, z: 0 } }];
  source.fixtures = [{ id: 'lamp', role: 'light', x: 4, row: 4, direction: 0, anchor: 'ceiling', offset: { x: .2, y: 0, z: 0 } },
    { id: 'merchant', role: 'merchant', x: 3, row: 12, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'fixed-decoration', role: 'decoration', bindingId: assets[1].id, x: 15, row: 14, direction: 270, offset: { x: .1, y: 0, z: .1 } },
    { id: 'implicit-decoration', role: 'decoration', x: 15, row: 16, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  source.lockedCells = [{ x: 5, row: 13 }];
  const initial = withInstances([instance('old-generated', 12, 12)], source), before = structuredClone(initial);
  for (const operation of [furnishExistingMap, rearrangeMapProps]) {
    const result = operation(initial, config, assets, { props: true, decorations: true });
    assert.equal(result.unchanged, false, JSON.stringify(result.issues));
    assert.deepEqual(result.map.fixtures, initial.fixtures); assertGeographyPreserved(initial, result.map); assert.deepEqual(initial, before);
    assert.deepEqual(validateMap(result.map).filter(issue => issue.severity === 'error'), []);
    assert.deepEqual(propValidationIssues(result.map, assets), []);
    assert.deepEqual(analyzeLevelDesign(result.map, config).issues.filter(issue => issue.severity === 'error'), []);
    for (const prop of result.map.propInstances!) assert.deepEqual(prop.size, propWorldSize(assets.find(binding => binding.id === prop.bindingId)!, prop.direction));
  }
});

test('saved grouped furnishing retains cluster IDs, source provenance and classification without reshaping the map', () => {
  const config = settings(), assets = [asset('Crate', 'prop', { usage: 'storage', family: 'supply', member: 'either', arrangement: 'island' })];
  const result = furnishExistingMap(room(), config, assets, propsOnly);
  assert.ok(result.addedProps > 0);
  const restored = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map: result.map, settings: config, bindings: assets })));
  assert.deepEqual(restored.map.propInstances, result.map.propInstances); assert.deepEqual(restored.map.rows, result.map.rows);
  assert.deepEqual(restored.bindings[0].prop!.composition, assets[0].prop!.composition);
  assert.equal(rearrangeMapProps(restored.map, restored.settings, restored.bindings, propsOnly).unchanged, true);
});

test('invalid catalogs, settings and source data fail atomically, and selecting no roles is a no-op', () => {
  const config = settings(), assets = [asset()], source = withInstances([instance('old', 3, 8)]), before = structuredClone(source);
  const invalidCatalog = structuredClone(assets); invalidCatalog[0].prop!.size!.x = -1;
  const invalidSettings = { ...config, seed: -1 };
  const invalidMap = structuredClone(source); invalidMap.propInstances![0].cells.push({ x: 4, row: 8 });
  for (const operation of [furnishExistingMap, rearrangeMapProps]) {
    for (const [map, options, bindings] of [[source, config, invalidCatalog], [source, invalidSettings, assets], [invalidMap, config, assets]] as const) {
      const result = operation(map, options, bindings, propsOnly);
      assert.equal(result.unchanged, true); assert.deepEqual(result.map, map);
      assert.equal(result.addedProps, 0); assert.equal(result.addedDecorations, 0); assert.ok(result.issues.length > 0);
    }
    const none = operation(source, config, assets, { props: false, decorations: false });
    assert.equal(none.unchanged, true); assert.deepEqual(none.map, source); assert.deepEqual(none.issues, []);
  }
  assert.deepEqual(source, before);
});
