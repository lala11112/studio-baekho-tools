import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGeneratedRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { applyRoomPreset } from '../src/shared/room-presets';
import type { GridMap, PropInstance } from '../src/shared/types';

function room(): GridMap {
  return { version: 5, name: 'Preserved room', width: 10, height: 10, cellSize: 2, maxStepHeight: .4,
    rows: ['#####D####', ...Array(8).fill('#........#'), '##########'],
    elevations: Array.from({ length: 10 }, () => Array(10).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: 5, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function withProp(authored = false): GridMap {
  const map = room(); map.rows[3] = '#.PP.....#';
  const prop: PropInstance = { id: 'prop_2_3', bindingId: 'table', role: 'prop', x: 2, row: 3, direction: 0,
    offset: { x: 1, y: 0, z: 0 }, cells: [{ x: 2, row: 3 }, { x: 3, row: 3 }], size: { x: 3, y: 1, z: 1 },
    blocksMovement: true, category: 'table', anchor: 'floor', ...(authored ? { authored: true } : {}) };
  map.propInstances = [prop]; return map;
}
test('region regeneration preserves whole crossing props and leaves outside terrain unchanged', () => {
  const original = withProp(), before = structuredClone(original);
  const result = mergeGeneratedRegion(original, room(), { x: 3, row: 2, width: 4, height: 4 });
  assert.deepEqual(result.propInstances, original.propInstances);
  assert.equal(result.rows[3], original.rows[3]);
  assert.deepEqual(original, before);
  assert.equal(result.lockedCells, undefined);
});
test('authored props and manually assigned proxy cells survive feature regeneration without new locks', () => {
  const original = withProp(true); original.rows[6] = '#.P......#';
  original.assetOverrides = [{ x: 2, row: 6, role: 'prop', bindingId: 'manual-proxy' }];
  const settings = { ...DEFAULT_SETTINGS, width: 10, height: 10, connectionCount: 1,
    designer: { ...DEFAULT_DESIGNER, elevation: false, props: false } };
  const rect = { x: 1, row: 1, width: 8, height: 8 };
  const result = mergeGeneratedRegion(original, room(), rect, merged => applyGeneratedFeatures(merged, settings, rect));
  assert.deepEqual(result.propInstances, original.propInstances);
  assert.deepEqual(result.assetOverrides, original.assetOverrides);
  assert.equal(result.rows[6][2], 'P');
  assert.equal(result.lockedCells, undefined);
});
test('a locked footprint protects the complete prop while ordinary generated props can regenerate', () => {
  const original = withProp(); original.lockedCells = [{ x: 3, row: 3 }];
  const rect = { x: 1, row: 1, width: 8, height: 8 };
  const result = mergeGeneratedRegion(original, room(), rect);
  assert.deepEqual(result.propInstances, original.propInstances);
  assert.deepEqual(result.lockedCells, original.lockedCells);
  const unlocked = withProp();
  assert.equal(mergeGeneratedRegion(unlocked, room(), rect).propInstances?.length, 0);
});
test('new projects opt into grouped composition while existing preset preferences remain compatible', () => {
  const created = applyRoomPreset(DEFAULT_SETTINGS, 'medium');
  assert.equal(created.designer?.propLayout, 'grouped'); assert.equal(created.designer?.propCoverage, 12);
  const legacy = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER } };
  assert.equal(applyRoomPreset(legacy, 'large').designer?.propLayout, 'legacy');
  const custom = { ...created, designer: { ...created.designer!, propCoverage: 18 } };
  assert.equal(applyRoomPreset(custom, 'large').designer?.propCoverage, 18);
  const saved = { formatVersion: 1, map: room(), settings: legacy, bindings: [] };
  assert.deepEqual(parseProjectFile(saved).map.rows, saved.map.rows, 'opening a saved map never changes terrain');
  assert.equal(parseProjectFile(saved).map.propInstances, undefined, 'opening a saved map never populates props');
  assert.notEqual(parseProjectFile(saved).settings.designer?.propLayout, 'balanced');
});
