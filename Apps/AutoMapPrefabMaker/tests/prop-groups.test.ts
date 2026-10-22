import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRegion, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { markPropGroupAuthored, protectedPropIds } from '../src/shared/prop-groups';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { parsePropInstance } from '../src/shared/props';
import type { AssetBinding, GridMap, PropInstance } from '../src/shared/types';

function room(): GridMap {
  return { version: 5, name: 'Prop groups', width: 12, height: 10, cellSize: 2, maxStepHeight: .4,
    rows: ['#####D######', ...Array(8).fill('#..........#'), '############'],
    elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: 5, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function prop(id: string, x: number, row: number, groupId?: string): PropInstance {
  return { id, bindingId: 'crate', role: 'prop', x, row, direction: 0, offset: { x: 0, y: 0, z: 0 },
    cells: [{ x, row }], size: { x: 1, y: 1, z: 1 }, blocksMovement: true, category: '상자', anchor: 'floor',
    provenance: 'generated', ...(groupId ? { groupId } : {}) };
}
function withProps(props: PropInstance[]): GridMap {
  const map = room(), rows = map.rows.map(row => [...row]);
  map.propInstances = structuredClone(props);
  for (const item of props) for (const cell of item.cells) rows[cell.row][cell.x] = item.blocksMovement ? 'P' : '.';
  map.rows = rows.map(row => row.join('')); return map;
}
const group = () => [prop('one', 2, 2, 'workstation'), prop('two', 5, 2, 'workstation'), prop('unrelated', 8, 4)];

test('manual provenance, authored state and legacy manual IDs each protect the complete group', () => {
  for (const state of [{ authored: true }, { provenance: 'manual' as const }, { id: 'prop_manual_2_2' }]) {
    const members = group(); Object.assign(members[0], state);
    const map = withProps(members), before = structuredClone(map);
    assert.deepEqual(protectedPropIds(map), new Set([members[0].id, members[1].id]));
    assert.deepEqual(map, before, 'protection lookup leaves the source unchanged');
  }
});

test('a lock or direct assignment anywhere in a footprint protects every group member', () => {
  const members = group(); members[0].cells.push({ x: 3, row: 2 }); members[0].size.x = 3; members[0].offset.x = 1;
  for (const kind of ['lock', 'assignment'] as const) {
    const map = withProps(members);
    if (kind === 'lock') map.lockedCells = [{ x: 3, row: 2 }];
    else map.assetOverrides = [{ x: 3, row: 2, role: 'prop', bindingId: 'crate' }];
    assert.deepEqual(protectedPropIds(map), new Set(['one', 'two']));
  }
});

test('region boundaries protect groups even when each separate member fits wholly on one side', () => {
  const map = withProps(group());
  assert.deepEqual(protectedPropIds(map, { x: 1, row: 1, width: 3, height: 3 }), new Set(['one', 'two']));
  assert.deepEqual(protectedPropIds(map, { x: 1, row: 1, width: 6, height: 3 }), new Set());
  const wide = prop('wide', 2, 5); wide.cells.push({ x: 3, row: 5 });
  assert.deepEqual(protectedPropIds(withProps([wide]), { x: 3, row: 4, width: 3, height: 3 }), new Set(['wide']));
});

test('a direct edit marks the entire group manual and leaves unrelated objects alone', () => {
  const map = withProps(group()); markPropGroupAuthored(map, 'two');
  for (const item of map.propInstances!.slice(0, 2)) { assert.equal(item.authored, true); assert.equal(item.provenance, 'manual'); }
  assert.equal(map.propInstances![2].authored, undefined); assert.equal(map.propInstances![2].provenance, 'generated');
  const before = structuredClone(map); markPropGroupAuthored(map, 'missing'); assert.deepEqual(map, before);
  markPropGroupAuthored(map, 'unrelated'); assert.equal(map.propInstances![2].authored, true);
});

test('copy and target paste reject partial groups without modifying either map', () => {
  const map = withProps(group()), before = structuredClone(map);
  assert.throws(() => captureRegion(map, { x: 1, row: 1, width: 3, height: 3 }), /소품 묶음/);
  const empty = captureRegion(room(), { x: 1, row: 5, width: 3, height: 3 });
  assert.throws(() => pasteRegion(map, empty, { x: 1, row: 1 }), /소품 묶음/);
  assert.deepEqual(map, before);
});

test('pasted complete groups get independent IDs and manual provenance, including repeated rotated copies', () => {
  const map = withProps(group()), before = structuredClone(map);
  const snapshot = captureRegion(map, { x: 1, row: 1, width: 5, height: 3 });
  const pasted = pasteRegion(map, snapshot, { x: 1, row: 5 });
  const repeated = pasteRegion(pasted, snapshot, { x: 7, row: 4 }, { rotate90: 1 });
  const copies = repeated.propInstances!.filter(item => !map.propInstances!.some(old => old.id === item.id));
  assert.equal(copies.length, 4);
  assert.equal(new Set(copies.map(item => item.id)).size, 4);
  assert.equal(new Set(copies.map(item => item.groupId)).size, 2);
  for (const item of copies) {
    assert.notEqual(item.groupId, 'workstation'); assert.ok(item.groupId!.length <= 80);
    assert.equal(item.authored, true); assert.equal(item.provenance, 'manual');
  }
  assert.equal(copies[0].groupId, copies[1].groupId); assert.equal(copies[2].groupId, copies[3].groupId);
  assert.deepEqual(map, before); assert.equal(snapshot.propInstances![0].provenance, 'generated');
  assert.deepEqual(validateMap(repeated).filter(issue => issue.severity === 'error'), []);
});

test('partial generation retains whole original groups across selection, locks and manual edits', () => {
  for (const kind of ['crossing', 'locked', 'manual'] as const) {
    const map = withProps(group());
    if (kind === 'locked') map.lockedCells = [{ x: 2, row: 2 }];
    if (kind === 'manual') map.propInstances![0].provenance = 'manual';
    const before = structuredClone(map), rect = { x: 1, row: 1, width: kind === 'crossing' ? 3 : 6, height: 3 };
    const result = mergeGeneratedRegion(map, room(), rect);
    assert.deepEqual(result.propInstances, map.propInstances);
    assert.equal(result.rows[2], map.rows[2]); assert.deepEqual(result.lockedCells, map.lockedCells);
    assert.deepEqual(map, before);
  }
  const map = withProps(group());
  const regenerated = mergeGeneratedRegion(map, room(), { x: 1, row: 1, width: 6, height: 3 });
  assert.deepEqual(regenerated.propInstances, [map.propInstances![2]], 'fully selected generated groups remain replaceable');
});

test('partial generation rejects candidate groups crossing selection or a protected cell', () => {
  const candidate = withProps(group()), before = structuredClone(candidate);
  assert.throws(() => mergeGeneratedRegion(room(), candidate, { x: 1, row: 1, width: 3, height: 3 }), /소품 묶음/);
  const original = room(); original.lockedCells = [{ x: 2, row: 2 }];
  assert.throws(() => mergeGeneratedRegion(original, candidate, { x: 1, row: 1, width: 6, height: 3 }), /소품 묶음.*잠금/);
  assert.deepEqual(candidate, before);
});

test('feature decoration receives temporary protection for every group member and restores actual locks', () => {
  const original = withProps(group()); original.lockedCells = [{ x: 2, row: 2 }];
  let decorated = false;
  const result = mergeGeneratedRegion(original, room(), { x: 1, row: 1, width: 6, height: 3 }, merged => {
    decorated = true;
    assert.ok(merged.lockedCells!.some(cell => cell.x === 5 && cell.row === 2));
    assert.deepEqual(merged.propInstances, original.propInstances);
    return merged;
  });
  assert.equal(decorated, true); assert.deepEqual(result.lockedCells, original.lockedCells);
});

test('regenerated group IDs colliding with a retained outside group are remapped once', () => {
  const outside = prop('outside', 8, 5, 'shared'), original = withProps([outside]);
  const candidate = withProps([prop('new-one', 2, 2, 'shared'), prop('new-two', 4, 2, 'shared')]);
  const result = mergeGeneratedRegion(original, candidate, { x: 1, row: 1, width: 5, height: 3 });
  const added = result.propInstances!.filter(item => item.id !== outside.id);
  assert.equal(result.propInstances![0].groupId, 'shared'); assert.equal(added.length, 2);
  assert.equal(added[0].groupId, added[1].groupId); assert.notEqual(added[0].groupId, 'shared');
  assert.equal(candidate.propInstances![0].groupId, 'shared');
});

test('saved projects retain composition and group provenance while legacy metadata stays absent', () => {
  const map = withProps(group()); markPropGroupAuthored(map, 'one');
  const binding: AssetBinding = { id: 'crate', label: 'Crate', role: 'prop', prefabGuid: 'a'.repeat(32), prefabPath: 'Assets/Crate.prefab',
    scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    prop: { category: '상자', tags: [], blocksMovement: true, size: { x: 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle'], weight: 1,
      composition: { usage: 'storage', family: 'storage', member: 'either', arrangement: 'island' } } };
  const saved = { formatVersion: 1, map, bindings: [binding], settings: { ...DEFAULT_SETTINGS, width: 12, height: 10, connectionCount: 1,
    designer: { ...DEFAULT_DESIGNER, propLayout: 'grouped' as const } } };
  const restored = parseProjectFile(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.map.propInstances, map.propInstances);
  assert.deepEqual(restored.bindings[0].prop!.composition, binding.prop!.composition);
  assert.deepEqual(protectedPropIds(restored.map), new Set(['one', 'two']));
  const legacy = structuredClone(saved);
  for (const item of legacy.map.propInstances!) { delete item.groupId; delete item.provenance; delete item.authored; }
  delete legacy.bindings[0].prop!.composition;
  const reopened = parseProjectFile(legacy);
  assert.ok(reopened.map.propInstances!.every(item => item.groupId === undefined && item.provenance === undefined));
  assert.equal(reopened.bindings[0].prop!.composition, undefined);
  assert.throws(() => parsePropInstance({ ...prop('invalid', 2, 2), groupId: 'not a safe ID' }, 12, 10));
  assert.throws(() => parsePropInstance({ ...prop('invalid', 2, 2), provenance: 'automatic' }, 12, 10));
});
