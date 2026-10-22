import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { applyImportedPropBounds, applyPropBoundsCatalog, insertPropInstance, parsePropInstance, placeProps, preparePropBoundsImport, propCatalogPrompt, propValidationIssues, replacePropInstance, snapshotPropCatalog } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap, MapFixture } from '../src/shared/types';

const room = (): GridMap => ({ version: 5, name: 'Separate vegetation', width: 10, height: 10, cellSize: 2,
  rows: Array.from({ length: 10 }, (_, row) => row === 0 || row === 9 ? '#'.repeat(10) : '#........#'),
  elevations: Array.from({ length: 10 }, () => Array(10).fill(0)), ramps: [], connections: [], assetOverrides: [], maxStepHeight: .4 });
const settings = (decorations = true, vegetation = true): GenerationSettings => ({ prompt: '방', width: 10, height: 10, cellSize: 2,
  elevationStep: 2, maxStepHeight: .4, connectionCount: 1, codexModel: '', seed: 123,
  designer: { ...DEFAULT_DESIGNER, props: false, decorations, vegetation } });
const binding = (role: 'prop' | 'decoration' | 'vegetation', id: string = role): AssetBinding => ({ id, label: id, role,
  prefabGuid: (role === 'vegetation' ? '2' : '1').repeat(32), prefabPath: `Assets/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: role === 'vegetation' ? '식생' : '장식', tags: [], blocksMovement: role === 'prop', size: { x: 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle'], weight: 1 } });
const fixture = (role: 'decoration' | 'vegetation', x: number, row = 3): MapFixture => ({ id: `${role}_${x}_${row}`, role, x, row, direction: 0, offset: { x: 0, y: 0, z: 0 } });

test('vegetation measurements, catalog entries and parsed instances retain their distinct role', () => {
  const plant = binding('vegetation'), ornament = binding('decoration');
  delete plant.prop;
  const source = { version: 1, assets: [{ guid: '2'.repeat(32), size: { x: 3, y: 2, z: 2 } }] };
  const prepared = preparePropBoundsImport([plant, ornament], source, null);
  assert.equal(prepared.updated, 1); assert.equal(prepared.missing, 1);
  const measured = applyImportedPropBounds(plant, prepared.catalog);
  assert.equal(measured.role, 'vegetation'); assert.equal(measured.prop?.blocksMovement, false);
  assert.deepEqual(measured.prop?.size, { x: 3, y: 2, z: 2 });
  assert.equal(applyPropBoundsCatalog([plant], source).updated, 1);
  const catalog = snapshotPropCatalog([measured, ornament]);
  assert.deepEqual(catalog.map(b => b.role), ['vegetation', 'decoration']);
  assert.match(propCatalogPrompt(catalog), /"role":"vegetation"/);
  const map = room(); map.fixtures = [fixture('vegetation', 3)];
  const p = placeProps(map, settings(), [measured]).map.propInstances![0];
  assert.equal(p.role, 'vegetation'); assert.deepEqual(parsePropInstance(p, 10, 10), p);
  assert.throws(() => parsePropInstance({ ...p, role: 'forest' }, 10, 10));
});

test('decoration and vegetation toggles independently convert only the matching catalog role', () => {
  const map = room(); map.fixtures = [fixture('decoration', 2), fixture('vegetation', 6)];
  const catalog = [binding('decoration'), binding('vegetation')];
  for (const [decorations, vegetation] of [[true, false], [false, true], [true, true], [false, false]]) {
    const result = placeProps(map, settings(decorations, vegetation), catalog).map;
    assert.deepEqual((result.propInstances ?? []).map(p => p.role), [...(decorations ? ['decoration'] : []), ...(vegetation ? ['vegetation'] : [])]);
    assert.deepEqual(result.fixtures?.map(f => f.role), [...(!decorations ? ['decoration'] : []), ...(!vegetation ? ['vegetation'] : [])]);
    assert.deepEqual(propValidationIssues(result, catalog), []);
  }
  const defaults = settings(); delete defaults.designer!.vegetation;
  assert.deepEqual(placeProps(map, defaults, catalog).map.propInstances?.map(p => p.role), ['decoration']);
  const onlyVegetation = room(); onlyVegetation.fixtures = [fixture('vegetation', 3)];
  assert.throws(() => placeProps(onlyVegetation, settings(), [binding('decoration')]), /측정된 프리팹/);
  assert.equal(map.propInstances, undefined); assert.equal(map.fixtures.length, 2);
});

test('plant names in legacy decoration bindings and fixtures remain decorations', () => {
  const plant = binding('decoration', 'Grass_Plant'); plant.prop!.category = '식생';
  const map = room(); map.fixtures = [fixture('decoration', 3)];
  const result = placeProps(map, settings(true, false), [plant]).map;
  assert.equal(result.propInstances?.[0].role, 'decoration');
  assert.equal(snapshotPropCatalog([plant])[0].role, 'decoration');
});

test('tactical placement completes vegetation conversion when decorations are disabled', () => {
  const map = room(); map.width = 18; map.height = 16;
  map.rows = Array.from({ length: 16 }, (_, row) => row === 0 || row === 15 ? '#'.repeat(18) : '#................#');
  map.elevations = Array.from({ length: 16 }, () => Array(18).fill(0));
  map.rows[0] = '#########D########'; map.rows[5] = '#...P............#';
  map.connections = [{ id: 'north', label: 'North', x: 9, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }];
  map.fixtures = [fixture('vegetation', 2, 13)];
  const config = settings(false, true); config.designer!.props = true;
  config.levelDesign = { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 };
  const catalog = [binding('prop'), binding('vegetation')];
  const result = placeProps(map, config, catalog, undefined, [], { tactical: true }).map;
  assert.equal(result.propInstances?.filter(p => p.role === 'prop').length, 1);
  assert.equal(result.propInstances?.filter(p => p.role === 'vegetation').length, 1);
  assert.deepEqual(result.fixtures, []);
  assert.deepEqual(propValidationIssues(result, catalog), []);
});

test('explicit insert and replacement preserve vegetation while generation is disabled or absent', () => {
  const plant = binding('vegetation'), ornament = binding('decoration'), catalog = [plant, ornament];
  const source = room(); source.fixtures = [fixture('vegetation', 7), fixture('decoration', 6)];
  for (const config of [settings(false, false), { ...settings(false, false), designer: undefined }]) {
    const inserted = insertPropInstance(source, { x: 3, row: 3 }, plant.id, config, catalog);
    assert.equal(inserted.propInstances?.[0].role, 'vegetation');
    assert.equal(inserted.propInstances?.[0].bindingId, plant.id);
    assert.deepEqual(inserted.fixtures, source.fixtures);
    const originalId = inserted.propInstances![0].id;
    const replaced = replacePropInstance(inserted, originalId, ornament.id, config, catalog);
    assert.equal(replaced.propInstances?.[0].role, 'decoration');
    assert.equal(replaced.propInstances?.[0].id, originalId);
    const restored = replacePropInstance(replaced, originalId, plant.id, config, catalog);
    assert.equal(restored.propInstances?.[0].role, 'vegetation');
    assert.deepEqual(restored.fixtures, source.fixtures);
    assert.deepEqual(propValidationIssues(restored, catalog), []);
  }
  assert.equal(source.propInstances, undefined);
});

test('manual vegetation insertion preserves another fixture attachment at the same cell', () => {
  const map = room(); map.fixtures = [{ ...fixture('vegetation', 3), anchor: 'ceiling' }];
  map.ceilings = [{ x: 3, row: 3, undersideY: 4 }];
  const plant = binding('vegetation');
  const result = insertPropInstance(map, { x: 3, row: 3 }, plant.id, settings(false, false), [plant]);
  assert.deepEqual(result.fixtures, map.fixtures);
  assert.equal(result.propInstances?.length, 1); assert.equal(result.propInstances[0].role, 'vegetation');
});

test('an irregular decoration keeps its full measured enclosing rectangle reserved', () => {
  const map = room(); map.fixtures = [fixture('decoration', 3)];
  const corner = binding('decoration', 'L_shape'); corner.prop!.size = { x: 4, y: 1, z: 4 };
  const result = placeProps(map, settings(), [corner]).map;
  assert.deepEqual(result.propInstances?.[0].cells, [{ x: 3, row: 3 }, { x: 4, row: 3 }, { x: 3, row: 4 }, { x: 4, row: 4 }]);
  assert.throws(() => insertPropInstance(result, { x: 4, row: 4 }, corner.id, settings(), [corner]), /소품이 없는/);
});

test('generated measured dressing relocates failed edge anchors without losing instances or protected cells', () => {
  const map = room(); map.fixtures = [fixture('vegetation', 8, 8), fixture('vegetation', 8, 7), { ...fixture('decoration', 5, 5), role: 'column' }];
  map.lockedCells = [{ x: 6, row: 7 }];
  map.markers = [{ id: 'reward', kind: 'reward', label: 'Reward', x: 7, row: 7, contentKey: '', direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  map.elevations[6][6] = 1; map.ceilings = [{ x: 5, row: 6, undersideY: .5 }];
  const before = structuredClone(map), plant = binding('vegetation'); plant.prop!.size = { x: 3, y: 2, z: 4 };
  const reserved = [{ x: 7, row: 6 }], region = { x: 4, row: 4, width: 5, height: 5 };
  const result = placeProps(map, settings(false, true), [plant], region, reserved, { varyGeneratedDecorations: true }).map;
  assert.equal(result.propInstances?.length, 2); assert.equal(result.fixtures?.length, 1);
  assert.deepEqual(result.fixtures?.[0], map.fixtures[2]);
  for (const p of result.propInstances!) {
    assert.equal(p.cells.length, 4); assert.equal(p.role, 'vegetation');
    assert.ok(p.cells.every(c => c.x >= 4 && c.row >= 4 && c.x < 9 && c.row < 9));
    assert.ok(p.cells.every(c => ![...reserved, ...map.lockedCells!, ...map.markers!, map.fixtures![2], { x: 5, row: 6 }].some(protectedCell => protectedCell.x === c.x && protectedCell.row === c.row)));
  }
  assert.deepEqual(propValidationIssues(result, [plant]), []);
  assert.deepEqual(result, placeProps(map, settings(false, true), [plant], region, reserved, { varyGeneratedDecorations: true }).map);
  assert.deepEqual(map, before);
});

test('measured relocation keeps authored and locked anchors fixed and never silently reduces a failed count', () => {
  const map = room(); map.fixtures = [fixture('vegetation', 8, 8)];
  const plant = binding('vegetation'); plant.prop!.size = { x: 3, y: 2, z: 4 };
  assert.throws(() => placeProps(map, settings(), [plant]), /측정된 프리팹/);
  const authored = structuredClone(map); authored.fixtures![0].bindingId = plant.id;
  assert.throws(() => placeProps(authored, settings(), [plant], undefined, [], { varyGeneratedDecorations: true }), /측정된 프리팹/);
  const locked = structuredClone(map); locked.lockedCells = [{ x: 8, row: 8 }];
  assert.deepEqual(placeProps(locked, settings(), [plant], undefined, [], { varyGeneratedDecorations: true }).map, locked);
  assert.throws(() => insertPropInstance(room(), { x: 8, row: 8 }, plant.id, settings(), [plant]), /측정된 프리팹/);
  const wall = structuredClone(map); wall.fixtures![0].anchor = 'wall'; const mounted = structuredClone(plant); mounted.prop!.placement = 'wall';
  assert.throws(() => placeProps(wall, settings(), [mounted], undefined, [], { varyGeneratedDecorations: true }), /측정된 프리팹/);
  const impossible = structuredClone(plant); impossible.prop!.size = { x: 30, y: 2, z: 30 };
  const before = structuredClone(map);
  assert.throws(() => placeProps(map, settings(), [impossible], undefined, [], { varyGeneratedDecorations: true }), /측정된 프리팹/);
  assert.deepEqual(map, before);
});
