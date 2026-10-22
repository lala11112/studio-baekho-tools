import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { furnishExistingMap } from '../src/shared/furnishing';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { insertPropInstance, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';

function room(): GridMap {
  const width = 20, height = 20;
  const rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(10) + 'D' + '#'.repeat(9);
  return { version: 4, name: 'Existing terrain', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], connections: [{ id: 'north', label: 'North', x: 10, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 20, height: 20, connectionCount: 1, seed: 19,
    designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, decorations: false, vegetation: false, propCoverage: 4, decorationDensity: 2 } };
}
function binding(index: number, role: 'prop' | 'decoration', size = { x: 1.2, y: 1, z: 1.2 }): AssetBinding {
  const id = `${role}_${index}`;
  return { id, label: id, role, prefabGuid: (index + 1).toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: id, tags: [], blocksMovement: role === 'prop', size, placement: 'floor', roomTypes: ['battle', 'shop'], weight: 1 } };
}
const catalog = () => Array.from({ length: 11 }, (_, index) => binding(index, index < 8 ? 'prop' : 'decoration',
  index < 3 ? { x: 4.1 + index * .1, y: 1.2, z: 2.4 } : index < 6 ? { x: 2.4, y: 1, z: 1.8 } : { x: 1.2, y: 1, z: 1.2 }));
function assertTerrainPreserved(before: GridMap, after: GridMap): void {
  const { rows: oldRows, propInstances: oldProps, version: oldVersion, ...oldMetadata } = before;
  const { rows: newRows, propInstances: newProps, version: newVersion, ...newMetadata } = after;
  assert.deepEqual(newMetadata, oldMetadata);
  for (let row = 0; row < before.height; row++) for (let x = 0; x < before.width; x++) {
    assert.ok(oldRows[row][x] === newRows[row][x] || oldRows[row][x] === '.' && newRows[row][x] === 'P', `terrain changed at ${x},${row}`);
  }
  for (const prop of oldProps ?? []) assert.deepEqual(newProps?.find(p => p.id === prop.id), prop);
}

test('eleven newly registered assets furnish an empty map despite disabled generation toggles, deterministically up to targets', () => {
  const source = room(), config = settings(), assets = catalog(), before = structuredClone(source), savedSettings = structuredClone(config);
  const result = furnishExistingMap(source, config, assets, { props: true, decorations: true });
  assert.ok(result.addedProps > 2); assert.ok(result.addedDecorations > 0);
  assert.ok(result.usedBindingIds.length >= 5); assert.equal(result.unchanged, false);
  assert.ok(result.coverage.actualPercent! >= result.coverage.targetPercent);
  assert.equal(result.decorationCount, result.decorationTarget, JSON.stringify(result.issues));
  assert.deepEqual(source, before); assert.deepEqual(config, savedSettings); assertTerrainPreserved(source, result.map);
  assert.deepEqual(validateMap(result.map).filter(i => i.severity === 'error'), []);
  assert.deepEqual(propValidationIssues(result.map, assets), []);
  for (const prop of result.map.propInstances!) assert.deepEqual(prop.size, propWorldSize(assets.find(b => b.id === prop.bindingId)!, prop.direction));
  assert.deepEqual(result, furnishExistingMap(source, config, [...assets].reverse(), { props: true, decorations: true }));
  const repeated = furnishExistingMap(result.map, config, assets, { props: true, decorations: true });
  assert.equal(repeated.addedProps, 0); assert.equal(repeated.addedDecorations, 0); assert.equal(repeated.unchanged, true); assert.deepEqual(repeated.map, result.map);
  const project = parseProjectFile({ formatVersion: 1, map: result.map, settings: config, bindings: assets });
  assert.deepEqual(project.map.propInstances, result.map.propInstances);
  const structural = ['floor', 'wall', 'door'].map((role, index) => ({ ...binding(20 + index, 'prop'), role: role as AssetBinding['role'], prop: undefined }));
  assert.ok(buildManifest(result.map, [...assets, ...structural]).placements.some(p => p.centerXZ === true));
});

test('furnishing preserves elevations, stairs, ceilings, structures, markers, fixtures, locks and authored proxy assignments', () => {
  const source = room(), config = settings(), assets = catalog();
  for (let row = 1; row <= 5; row++) for (let x = 1; x < 19; x++) source.elevations[row][x] = 2;
  source.elevations[0][10] = 2;
  for (const x of [3, 15]) { source.rows[6] = source.rows[6].slice(0, x) + 'R' + source.rows[6].slice(x + 1); source.ramps.push({ x, row: 6, direction: 0, rise: 2 }); }
  source.ceilings = Array.from({ length: 18 }, (_, row) => Array.from({ length: 18 }, (_, x) => ({ x: x + 1, row: row + 1, undersideY: 6, heightMode: 'manual' as const }))).flat();
  source.wallHeights = [{ x: 0, row: 5, height: 6, heightMode: 'manual' }];
  source.headroom = 2; source.zones = [{ x: 9, row: 10, kind: 'combat' }, { x: 2, row: 12, kind: 'reward' }];
  source.markers = [{ id: 'reward', label: 'Reward', kind: 'reward', x: 2, row: 12, direction: 90, contentKey: 'item', offset: { x: .1, y: 0, z: 0 } }];
  source.fixtures = [
    { id: 'lamp', role: 'light', x: 4, row: 4, direction: 0, anchor: 'ceiling', offset: { x: .2, y: 0, z: 0 } },
    { id: 'plant', role: 'vegetation', x: 17, row: 16, direction: 90, offset: { x: 0, y: 0, z: .1 } },
    { id: 'merchant', role: 'merchant', x: 3, row: 12, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'manual-decoration', role: 'decoration', bindingId: assets[8].id, x: 15, row: 14, direction: 270, offset: { x: .1, y: 0, z: .1 } },
  ];
  source.rows[4] = source.rows[4].slice(0, 13) + 'P' + source.rows[4].slice(14);
  source.assetOverrides.push({ x: 13, row: 4, role: 'prop', bindingId: assets[6].id });
  source.lockedCells = [{ x: 13, row: 4 }, { x: 5, row: 13 }];
  const fixed = insertPropInstance(source, { x: 15, row: 11 }, assets[6].id, config, assets), before = structuredClone(fixed);
  fixed.lockedCells!.push(...fixed.propInstances![0].cells);
  const saved = structuredClone(fixed), result = furnishExistingMap(fixed, config, assets, { props: true, decorations: true });
  assert.ok(result.addedProps + result.addedDecorations > 0, JSON.stringify(result.issues));
  assertTerrainPreserved(saved, result.map); assert.deepEqual(fixed, saved);
  assert.equal(result.map.rows[4][13], 'P'); assert.deepEqual(result.map.fixtures, before.fixtures);
  assert.deepEqual(propValidationIssues(result.map, assets), []);
  assert.deepEqual(analyzeLevelDesign(result.map, { ...config, designer: { ...config.designer!, props: true, propLayout: 'balanced' }, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } }).issues.filter(i => i.severity === 'error'), []);
});

test('new furnishing honors measured scale and rotation across large rectangles and three-cell footprints', () => {
  const source = room(), config = settings(), assets = [binding(0, 'prop', { x: 4.1, y: 1, z: 4.1 }), binding(1, 'prop', { x: 4.2, y: 1, z: 1.2 }), binding(2, 'decoration', { x: 2.4, y: .8, z: 1.2 })];
  assets[1].scale.x = 1.2; assets[2].rotationY = 15; assets[2].scale.y = 1.5;
  config.designer!.propCoverage = 5;
  const result = furnishExistingMap(source, config, assets, { props: true, decorations: true });
  assert.ok(result.map.propInstances!.some(p => p.cells.length >= 9));
  assert.ok(result.map.propInstances!.some(p => p.direction === 90 || p.direction === 270));
  for (const p of result.map.propInstances!) assert.deepEqual(p.size, propWorldSize(assets.find(a => a.id === p.bindingId)!, p.direction));
  assert.deepEqual(propValidationIssues(result.map, assets), []); assertTerrainPreserved(source, result.map);
});

test('unknown measurements and incompatible libraries retain the original without guesses', () => {
  const source = room(), config = settings(), unknown = catalog(); unknown.forEach(b => delete b.prop!.size);
  for (const assets of [unknown, catalog().map(b => ({ ...b, prop: { ...b.prop!, roomTypes: ['shop' as const] } }))]) {
    const result = furnishExistingMap(source, config, assets, { props: true, decorations: true });
    assert.deepEqual(result.map, source); assert.equal(result.unchanged, true); assert.ok(result.issues.length > 0);
  }
  assert.ok(furnishExistingMap(source, config, unknown, { props: true, decorations: true }).issues.some(i => i.code === 'prop-unmeasured'));
});

test('limited editable space returns a safe partial result without weakening paths or shrinking assets', () => {
  const source = room(), config = settings(), assets = [binding(0, 'prop', { x: 4.1, y: 1, z: 4.1 }), binding(1, 'decoration')];
  source.lockedCells = [];
  for (let row = 1; row < 19; row++) for (let x = 1; x < 19; x++) if (!(x >= 3 && x <= 5 && row >= 3 && row <= 5)) source.lockedCells.push({ x, row });
  config.designer!.propCoverage = 12;
  const result = furnishExistingMap(source, config, assets, { props: true, decorations: true });
  assert.equal(result.addedProps, 1); assert.equal(result.addedDecorations, 0);
  assert.ok(result.issues.some(i => i.code === 'prop-coverage-unmet')); assert.ok(result.issues.some(i => i.code === 'furnishing-decoration-unmet'));
  assert.deepEqual(propValidationIssues(result.map, assets), []); assertTerrainPreserved(source, result.map);
  const repeated = furnishExistingMap(result.map, config, assets, { props: true, decorations: true });
  assert.equal(repeated.unchanged, true); assert.deepEqual(repeated.map, result.map);
});

test('a map without existing safe combat circulation is left intact and no-selection is a no-op', () => {
  const source = room(); for (let row = 1; row < 19; row++) source.rows[row] = '#'.repeat(10) + '.' + '#'.repeat(9);
  const result = furnishExistingMap(source, settings(), catalog(), { props: true, decorations: true });
  assert.deepEqual(result.map, source); assert.equal(result.unchanged, true); assert.ok(result.issues.some(i => i.code === 'furnishing-existing-circulation'));
  const none = furnishExistingMap(room(), settings(), catalog(), { props: false, decorations: false });
  assert.deepEqual(none.map, room()); assert.equal(none.unchanged, true); assert.deepEqual(none.issues, []);
});

test('late registration converts automatic P and decoration proxies while retaining locked and explicitly assigned placeholders', () => {
  const source = room(), assets = catalog(), config = settings();
  for (const c of [{ x: 2, row: 4 }, { x: 15, row: 15 }, { x: 4, row: 4 }, { x: 12, row: 4 }]) source.rows[c.row] = source.rows[c.row].slice(0, c.x) + 'P' + source.rows[c.row].slice(c.x + 1);
  source.lockedCells = [{ x: 4, row: 4 }, { x: 17, row: 14 }];
  source.assetOverrides = [{ x: 12, row: 4, role: 'prop', bindingId: assets[6].id }];
  source.fixtures = [
    { id: 'automatic-decoration', role: 'decoration', x: 3, row: 14, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'locked-decoration', role: 'decoration', x: 17, row: 14, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'assigned-decoration', role: 'decoration', bindingId: assets[8].id, x: 15, row: 12, direction: 90, offset: { x: .1, y: 0, z: 0 } },
  ];
  const before = structuredClone(source), result = furnishExistingMap(source, config, assets, { props: true, decorations: true });
  assert.equal(result.convertedPropPlaceholders, 2); assert.equal(result.convertedDecorationPlaceholders, 1);
  assert.equal(result.map.rows[4][4], 'P'); assert.equal(result.map.rows[4][12], 'P');
  assert.deepEqual(result.map.assetOverrides, source.assetOverrides); assert.deepEqual(result.map.lockedCells, source.lockedCells);
  assert.deepEqual(result.map.fixtures, source.fixtures.slice(1));
  assert.ok(result.addedProps > 0 && result.addedDecorations > 0);
  assert.ok(result.issues.some(i => i.code === 'furnishing-proxy-preserved')); assert.ok(result.issues.some(i => i.code === 'furnishing-decoration-proxy-preserved'));
  assert.deepEqual(propValidationIssues(result.map, assets), []); assert.deepEqual(source, before);
  assert.deepEqual(furnishExistingMap(result.map, config, assets, { props: true, decorations: true }).map, result.map);
});

test('unfit automatic proxies remain present even when another selected role can be furnished', () => {
  const source = room(), config = settings(), huge = binding(0, 'prop', { x: 100, y: 1, z: 100 }), decoration = binding(1, 'decoration');
  source.rows[4] = source.rows[4].slice(0, 3) + 'P' + source.rows[4].slice(4);
  const result = furnishExistingMap(source, config, [huge, decoration], { props: true, decorations: true });
  assert.equal(result.addedProps, 0); assert.ok(result.addedDecorations > 0); assert.equal(result.map.rows[4][3], 'P'); assert.equal(result.convertedPropPlaceholders, 0);
  const rawDecoration = { id: 'unknown-decoration', role: 'decoration' as const, x: 3, row: 8, direction: 0 as const, offset: { x: 0, y: 0, z: 0 } };
  source.fixtures = [rawDecoration];
  const tooLarge = binding(2, 'decoration', { x: 100, y: 1, z: 100 });
  const failed = furnishExistingMap(source, config, [huge, tooLarge], { props: true, decorations: true });
  assert.equal(failed.unchanged, true); assert.deepEqual(failed.map, source);
  assert.ok(failed.issues.some(i => i.code === 'furnishing-proxy-preserved')); assert.ok(failed.issues.some(i => i.code === 'furnishing-decoration-proxy-preserved'));
});

test('an already-valid raised pattern keeps both stair approaches when blocking decorations are added', () => {
  const source = room(), config = settings(), decoration = binding(1, 'decoration'); decoration.prop!.blocksMovement = true;
  config.designer!.elevation = true; config.levelDesign = { ...DEFAULT_LEVEL_DESIGN, pattern: 'raisedArena' };
  for (let row = 1; row <= 5; row++) for (let x = 1; x < 19; x++) source.elevations[row][x] = 2;
  source.elevations[0][10] = 2;
  for (const x of [3, 15]) { source.rows[6] = source.rows[6].slice(0, x) + 'R' + source.rows[6].slice(x + 1); source.ramps.push({ x, row: 6, direction: 0, rise: 2 }); }
  source.lockedCells = [];
  for (let row = 0; row < 20; row++) for (let x = 0; x < 20; x++) if (x !== 3 || row !== 7) source.lockedCells.push({ x, row });
  assert.deepEqual(analyzeLevelDesign(source, config).issues, []);
  const result = furnishExistingMap(source, config, [decoration], { props: false, decorations: true });
  assert.deepEqual(result.map, source); assert.equal(result.unchanged, true);
  assert.deepEqual(analyzeLevelDesign(result.map, config).issues, []);
  assert.ok(result.issues.some(i => i.code === 'furnishing-decoration-unmet'));
});

test('explicit raw fixture reservations include the full measured footprint, rotation, scale and offsets', () => {
  for (const variant of ['horizontal', 'rotated', 'offset', 'wall'] as const) {
    const source = room(), config = settings(), large = binding(0, 'decoration', { x: 6, y: 1, z: 1.2 }), small = binding(1, 'decoration');
    large.prop!.weight = 0;
    if (variant === 'rotated') large.rotationY = 90;
    if (variant === 'offset') { large.scale.x = 1.2; large.offset.x = .5; }
    if (variant === 'wall') { large.rotationY = 90; large.offset.y = -1.5; large.prop!.placement = 'wall'; source.rows[5] = source.rows[5].slice(0, 5) + '#' + source.rows[5].slice(6); }
    const slot = variant === 'rotated' ? { x: 5, row: 6 } : variant === 'offset' || variant === 'wall' ? { x: 7, row: 5 } : { x: 6, row: 5 };
    source.fixtures = [{ id: 'fixed-large', role: 'decoration', bindingId: large.id, x: 5, row: 5, direction: variant === 'wall' ? 90 : 0, anchor: variant === 'wall' ? 'wall' : 'floor', offset: { x: variant === 'offset' ? 2 : 0, y: 0, z: 0 } }];
    source.lockedCells = [];
    for (let row = 0; row < 20; row++) for (let x = 0; x < 20; x++) if (x !== slot.x || row !== slot.row) source.lockedCells.push({ x, row });
    const result = furnishExistingMap(source, config, [large, small], { props: false, decorations: true });
    assert.equal(result.addedDecorations, 0, variant); assert.deepEqual(result.map, source);
  }
});
