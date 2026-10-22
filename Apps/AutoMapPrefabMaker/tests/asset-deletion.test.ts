import assert from 'node:assert/strict';
import test from 'node:test';
import { removeAssetBindings } from '../src/shared/asset-deletion';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import type { AssetBinding, AssetRole, Cell, ProjectFile, PropInstance } from '../src/shared/types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function binding(id: string, role: AssetRole): AssetBinding {
  return { id, label: id, role, prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    ...(['prop', 'decoration', 'vegetation'].includes(role) ? { prop: { category: id, tags: [], blocksMovement: role === 'prop', size: { x: 1, y: 1, z: 1 }, placement: 'floor' as const, roomTypes: ['battle' as const], weight: 1 } } : {}) };
}
function prop(id: string, bindingId: string, cells: Cell[], blocksMovement = true): PropInstance {
  return { id, bindingId, ...cells[0], role: blocksMovement ? 'prop' : 'decoration', direction: 0, offset: { x: 0, y: 0, z: 0 }, cells,
    size: { x: 1, y: 1, z: 1 }, blocksMovement, category: id, anchor: 'floor' };
}
function project(): ProjectFile {
  return parseProjectFile({ formatVersion: 1, settings: { ...DEFAULT_SETTINGS, width: 8, height: 8 },
    map: { version: 5, name: 'Bulk deletion', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
      rows: ['########', '#......#', '#.PP...#', '#......#', '#......#', '#......#', '#......#', '########'],
      elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [],
      propInstances: [prop('crate-instance', 'crate', [{ x: 2, row: 2 }, { x: 3, row: 2 }])],
      fixtures: [{ id: 'vase-fixture', role: 'decoration', bindingId: 'vase', x: 5, row: 4, direction: 90, offset: { x: .1, y: .2, z: .3 }, anchor: 'floor' },
        { id: 'lamp-fixture', role: 'light', bindingId: 'lamp', x: 4, row: 4, direction: 180, offset: { x: 0, y: 1, z: 0 } }] },
    bindings: [binding('floor', 'floor'), binding('wall', 'wall'), binding('crate', 'prop'), binding('vase', 'decoration'), binding('bush', 'vegetation'), binding('lamp', 'light')],
    blueprintDataUrl: PNG, concept: { source: 'manual', text: '우회와 접근을 선택하는 전투방' } });
}

test('deleting prop registrations releases measured cells and clears references while retaining terrain and metadata', () => {
  const input = project();
  input.map.assetOverrides = [{ x: 2, row: 2, role: 'prop', bindingId: 'crate' }, { x: 1, row: 1, role: 'floor', bindingId: 'floor' }];
  input.map.propInstances!.push(prop('vase-instance', 'vase', [{ x: 5, row: 5 }], false), { ...prop('bush-instance', 'bush', [{ x: 6, row: 5 }], false), role: 'vegetation' });
  input.generationDraft = { imageDataUrl: PNG, settings: structuredClone(input.settings), preferences: structuredClone(input.settings), concept: structuredClone(input.concept!),
    region: { x: 1, row: 1, width: 4, height: 4 }, catalog: structuredClone(input.bindings) };
  const before = structuredClone(input), result = removeAssetBindings(input, input.bindings.filter(item => ['prop', 'decoration', 'vegetation'].includes(item.role)).map(item => item.id));
  assert.deepEqual({ ...result, project: undefined }, { project: undefined, removedBindings: 3, removedPropInstances: 3, clearedOverrides: 1, clearedFixtureBindings: 1 });
  assert.deepEqual(result.project.bindings.map(item => item.id), ['floor', 'wall', 'lamp']);
  assert.deepEqual(result.project.map.rows, before.map.rows.map(row => row.replaceAll('P', '.')));
  assert.deepEqual(result.project.map.propInstances, []);
  assert.deepEqual(result.project.map.assetOverrides, [before.map.assetOverrides[1]]);
  const vase = structuredClone(before.map.fixtures![0]); delete vase.bindingId;
  assert.deepEqual(result.project.map.fixtures, [vase, before.map.fixtures![1]]);
  assert.deepEqual(result.project.map.elevations, before.map.elevations); assert.deepEqual(result.project.map.ramps, before.map.ramps);
  assert.deepEqual(result.project.map.connections, before.map.connections); assert.deepEqual(result.project.settings, before.settings);
  assert.deepEqual(result.project.concept, before.concept); assert.equal(result.project.blueprintDataUrl, before.blueprintDataUrl);
  assert.deepEqual(result.project.generationDraft, { ...before.generationDraft!, catalog: before.generationDraft!.catalog!.filter(item => ['floor', 'wall', 'lamp'].includes(item.id)) });
  assert.doesNotThrow(() => parseProjectFile(result.project)); assert.deepEqual(input, before);
  result.project.settings.prompt = 'changed'; result.project.map.elevations[1][1] = 8; result.project.bindings[0].scale.x = 9;
  assert.deepEqual(input, before, 'result arrays, settings and bindings are detached from the input');
});

test('all registrations can be deleted together without removing terrain or fixture intentions', () => {
  const input = project(); input.map.assetOverrides = [{ x: 1, row: 1, role: 'floor', bindingId: 'floor' }, { x: 0, row: 1, role: 'wall', bindingId: 'wall' }];
  const before = structuredClone(input), result = removeAssetBindings(input, input.bindings.map(item => item.id));
  assert.equal(result.removedBindings, 6); assert.equal(result.removedPropInstances, 1); assert.equal(result.clearedOverrides, 2); assert.equal(result.clearedFixtureBindings, 2);
  assert.deepEqual(result.project.bindings, []); assert.deepEqual(result.project.map.assetOverrides, []);
  assert.equal(result.project.map.fixtures!.length, 2); assert.ok(result.project.map.fixtures!.every(item => !item.bindingId));
  assert.deepEqual(result.project.map.rows, before.map.rows.map(row => row.replaceAll('P', '.')));
  assert.deepEqual(result.project.map.elevations, before.map.elevations); assert.doesNotThrow(() => parseProjectFile(result.project)); assert.deepEqual(input, before);
});

test('duplicate and unknown requested IDs do not remove extra registrations or create false history changes', () => {
  const input = project(), before = structuredClone(input);
  for (const ids of [[], ['unknown'], ['unknown', 'unknown']]) {
    const result = removeAssetBindings(input, ids);
    assert.equal(result.project, input); assert.equal(result.removedBindings, 0); assert.equal(result.removedPropInstances, 0); assert.equal(result.clearedOverrides, 0); assert.equal(result.clearedFixtureBindings, 0);
  }
  const result = removeAssetBindings(input, ['bush', 'unknown', 'bush']);
  assert.equal(result.removedBindings, 1); assert.deepEqual(result.project.map, input.map); assert.deepEqual(input, before);
});

test('any locked footprint cell rejects the entire mixed deletion before changing the source', () => {
  const input = project(); input.map.lockedCells = [{ x: 3, row: 2 }]; const before = structuredClone(input);
  assert.throws(() => removeAssetBindings(input, ['bush', 'crate', 'vase']), /잠긴/); assert.deepEqual(input, before);
});

test('a locked explicit terrain override or fixture binding rejects a mixed deletion atomically', () => {
  for (const kind of ['override', 'fixture']) {
    const input = project();
    if (kind === 'override') { input.map.assetOverrides = [{ x: 1, row: 1, role: 'floor', bindingId: 'floor' }]; input.map.lockedCells = [{ x: 1, row: 1 }]; }
    else input.map.lockedCells = [{ x: 5, row: 4 }];
    const before = structuredClone(input);
    assert.throws(() => removeAssetBindings(input, ['crate', 'floor', 'vase']), /잠긴/); assert.deepEqual(input, before);
  }
});

test('deletion rejects automatic binding changes on locked terrain even when the deleted asset was not selected there', () => {
  const input = project(); input.bindings = [binding('a', 'floor'), binding('b', 'floor'), binding('c', 'floor'), ...input.bindings.filter(item => item.role !== 'floor')];
  // Cell index 20 chooses c from three candidates, then b if a is removed.
  input.map.lockedCells = [{ x: 4, row: 2 }]; const before = structuredClone(input);
  assert.throws(() => removeAssetBindings(input, ['a']), /잠긴/); assert.deepEqual(input, before);
});

test('deletion also protects automatically selected fixture prefabs on locked cells', () => {
  const input = project(); input.bindings = [...input.bindings.filter(item => item.role !== 'light'), binding('a', 'light'), binding('b', 'light'), binding('c', 'light')];
  input.map.fixtures = [{ id: 'automatic-lamp', role: 'light', x: 4, row: 2, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  input.map.lockedCells = [{ x: 4, row: 2 }]; const before = structuredClone(input);
  assert.throws(() => removeAssetBindings(input, ['a']), /잠긴/); assert.deepEqual(input, before);
});

test('unused prop registrations can be deleted when a locked measured instance keeps its fixed binding', () => {
  const input = project(); input.bindings.push(binding('unused-prop', 'prop'));
  // The tile resolver would choose unused-prop at index 19, but export uses the measured crate binding.
  input.map.lockedCells = [{ x: 3, row: 2 }]; const before = structuredClone(input);
  const result = removeAssetBindings(input, ['unused-prop']);
  assert.equal(result.removedBindings, 1); assert.equal(result.removedPropInstances, 0);
  assert.deepEqual(result.project.map, input.map); assert.equal(result.project.map.propInstances![0].bindingId, 'crate');
  assert.deepEqual(input, before);
});

test('unused lights can be deleted when locked fixtures retain an explicit or dedicated mount binding', () => {
  for (const explicit of [true, false]) {
    const input = project(), lamp = input.bindings.find(item => item.id === 'lamp')!;
    lamp.lightAnchor = 'wall'; input.bindings.push(binding('unused-light', 'light'));
    input.map.fixtures = [{ id: 'fixed-lamp', role: 'light', x: 4, row: 2, direction: 90, offset: { x: 0, y: 1, z: 0 }, anchor: 'wall', ...(explicit ? { bindingId: 'lamp' } : {}) }];
    input.map.lockedCells = [{ x: 4, row: 2 }]; const before = structuredClone(input);
    const result = removeAssetBindings(input, ['unused-light']);
    assert.equal(result.removedBindings, 1); assert.equal(result.clearedFixtureBindings, 0);
    assert.deepEqual(result.project.map, input.map); assert.deepEqual(input, before);
  }
});

test('unrelated registrations remain deletable while other terrain is locked', () => {
  const input = project(); input.map.lockedCells = [{ x: 1, row: 1 }];
  const result = removeAssetBindings(input, ['crate', 'bush']);
  assert.equal(result.removedBindings, 2); assert.deepEqual(result.project.map.lockedCells, input.map.lockedCells);
});

test('batch cell release preserves surviving blocking instances, explicit prop intentions and untouched placeholders', () => {
  const input = project(); input.bindings.push(binding('retained', 'prop'));
  input.map.propInstances!.push(prop('retained-instance', 'retained', [{ x: 3, row: 2 }]));
  input.map.rows[3] = '#.PPP..#'; input.map.rows[5] = '#.P....#';
  input.map.propInstances!.push(prop('second-crate', 'crate', [{ x: 2, row: 3 }, { x: 3, row: 3 }, { x: 4, row: 3 }]));
  input.map.assetOverrides = [{ x: 3, row: 3, role: 'prop', bindingId: 'retained' }];
  const result = removeAssetBindings(input, ['crate']);
  assert.equal(result.removedPropInstances, 2); assert.equal(result.project.map.rows[2], '#..P...#'); assert.equal(result.project.map.rows[3], '#..P...#');
  assert.equal(result.project.map.rows[5], input.map.rows[5]); assert.deepEqual(result.project.map.assetOverrides, input.map.assetOverrides);
  assert.deepEqual(result.project.map.propInstances, [input.map.propInstances![1]]); assert.doesNotThrow(() => parseProjectFile(result.project));
});

test('surviving nonblocking dressing does not retain a deleted obstacle on shared cells', () => {
  const input = project(); input.map.propInstances!.push(prop('vase-instance', 'vase', [{ x: 3, row: 2 }], false));
  const result = removeAssetBindings(input, ['crate']);
  assert.equal(result.project.map.rows[2], '#......#'); assert.equal(result.project.map.propInstances![0].id, 'vase-instance'); assert.doesNotThrow(() => parseProjectFile(result.project));
});
