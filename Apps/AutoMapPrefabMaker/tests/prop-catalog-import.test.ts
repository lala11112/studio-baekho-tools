import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { furnishExistingMap } from '../src/shared/furnishing';
import { DEFAULT_SETTINGS, MAX_BINDINGS, parseBindings, parseProjectFile } from '../src/shared/map';
import { importPropCatalogBindings } from '../src/shared/prop-catalog-import';
import { suggestPropDefinition, type PropBoundsCatalog } from '../src/shared/props';
import { defaultWallMount } from '../src/shared/wall-mounts';
import type { AssetBinding, GridMap, PrefabAsset } from '../src/shared/types';

const guid = (index: number) => index.toString(16).padStart(32, '0');
const asset = (index: number): PrefabAsset => ({ guid: guid(index), name: `Crate_${index}`, path: `Assets/Props/Crate_${index}.prefab` });
const catalog = (...indices: number[]): PropBoundsCatalog => ({ version: 1, assets: indices.map(index => ({ guid: guid(index), size: { x: 1 + index / 100, y: .8, z: 1 } })) });
function binding(index: number, role: AssetBinding['role'] = 'prop'): AssetBinding {
  const source = asset(index);
  const result: AssetBinding = { id: `existing_${index}`, label: source.name, role, prefabGuid: source.guid, prefabPath: source.path,
    scale: { x: 2, y: 3, z: 1 }, offset: { x: .1, y: .2, z: .3 }, rotationY: 90 };
  if (['prop', 'decoration', 'vegetation'].includes(role)) result.prop = { ...suggestPropDefinition(result), category: '직접 분류', tags: ['수동'], placement: 'wall', roomTypes: ['shop'], weight: 0, size: { x: 8, y: 9, z: 10 } };
  return result;
}
function wallCatalog(...indices: number[]): PropBoundsCatalog {
  return { version: 2, assets: indices.map(index => ({ guid: guid(index), size: { x: 1, y: .8, z: .2 },
    bounds: { center: { x: 0, y: .4, z: .1 }, size: { x: 1, y: .8, z: .2 } }, wallMount: defaultWallMount(binding(index, 'decoration')) })) };
}

test('a wall catalog cannot silently register wall prefabs as default floor props and rejects all pending changes', () => {
  const existing = [binding(1)], source = wallCatalog(1, 2), scan = [asset(1), asset(2)];
  delete source.assets[0].wallMount;
  const before = structuredClone({ existing, source, scan });
  assert.throws(() => importPropCatalogBindings(existing, source, scan), /벽 부착.*장식.*조명.*적용되지/);
  assert.deepEqual({ existing, source, scan }, before);
});

test('existing incompatible asset roles must be changed explicitly before importing wall metadata', () => {
  for (const role of ['prop', 'wall'] as const) {
    const existing = [binding(10, 'decoration'), binding(15, role)], source = wallCatalog(10, 15), scan = [asset(10), asset(15)];
    existing[1].prefabGuid = existing[1].prefabGuid.toUpperCase();
    const before = structuredClone({ existing, source, scan });
    assert.throws(() => importPropCatalogBindings(existing, source, scan, 'light'), /기존 에셋 'Crate_15'.*장식.*조명.*먼저 변경.*적용되지/);
    assert.deepEqual({ existing, source, scan }, before);
  }
});

test('supported wall import roles preserve complete metadata and existing roles', () => {
  for (const role of ['decoration', 'light'] as const) {
    const source = wallCatalog(1), imported = importPropCatalogBindings([], source, [asset(1)], role);
    assert.equal(imported.added, 1); assert.equal(imported.bindings[0].role, role);
    assert.deepEqual(imported.bindings[0].wallMount, source.assets[0].wallMount);
    assert.deepEqual(imported.bindings[0].bounds, source.assets[0].bounds);
    assert.deepEqual(parseBindings(imported.bindings), imported.bindings);
    const again = importPropCatalogBindings(imported.bindings, source, [asset(1)]);
    assert.equal(again.added, 0); assert.deepEqual(again.bindings, imported.bindings);
  }
  const existing = [binding(1, 'vegetation'), binding(2, 'switch')], source = wallCatalog(1, 2);
  const result = importPropCatalogBindings(existing, source, [asset(1), asset(2)], 'light');
  assert.deepEqual(result.bindings.map(item => item.role), ['vegetation', 'switch']);
  assert.deepEqual(result.bindings.map(item => item.wallMount), source.assets.map(item => item.wallMount));
  assert.deepEqual(parseBindings(result.bindings), result.bindings);
});

test('ordinary v2 measurements still register as props and foreign wall entries do not block that import', () => {
  const source = wallCatalog(1, 2); delete source.assets[0].wallMount;
  const before = structuredClone(source), result = importPropCatalogBindings([], source, [asset(1)]);
  assert.equal(result.added, 1); assert.equal(result.unmatched, 1); assert.equal(result.bindings[0].role, 'prop');
  assert.equal(result.bindings[0].wallMount, undefined); assert.deepEqual(result.bindings[0].bounds, source.assets[0].bounds);
  assert.deepEqual(source, before);
});

test('eleven measured prefabs register in one import using only scanned identity and native scale', () => {
  const indices = Array.from({ length: 11 }, (_, i) => i + 1), source = catalog(...indices), scan = [...indices.map(asset), asset(99)];
  const before = structuredClone({ source, scan });
  const result = importPropCatalogBindings([], source, scan);
  assert.deepEqual({ added: result.added, updated: result.updated, available: result.available, missing: result.missing, unmatched: result.unmatched, existingOtherRoles: result.existingOtherRoles },
    { added: 11, updated: 0, available: 11, missing: 0, unmatched: 0, existingOtherRoles: 0 });
  assert.equal(result.bindings.length, 11);
  assert.deepEqual(parseBindings(result.bindings), result.bindings);
  for (const [index, actual] of result.bindings.entries()) {
    assert.equal(actual.role, 'prop'); assert.equal(actual.label, scan[index].name); assert.equal(actual.prefabPath, scan[index].path);
    assert.deepEqual(actual.scale, { x: 1, y: 1, z: 1 }); assert.deepEqual(actual.offset, { x: 0, y: 0, z: 0 }); assert.equal(actual.rotationY, 0);
    assert.deepEqual(actual.prop, { ...suggestPropDefinition(actual), size: source.assets[index].size });
  }
  assert.deepEqual({ source, scan }, before);
  result.bindings[0].prop!.size!.x = 90; result.catalog.assets[0].size.y = 80;
  assert.deepEqual({ source, scan }, before); assert.equal(result.bindings[0].prop!.size!.y, .8);
});

test('repeated imports update sizes without duplicating GUIDs or replacing manually chosen settings', () => {
  const first = importPropCatalogBindings([], catalog(1, 2), [asset(1), asset(2)]);
  first.bindings[0].prop!.tags = ['사용자']; first.bindings[0].prop!.roomTypes = ['boss']; first.bindings[0].scale.x = 2;
  const before = structuredClone(first.bindings), source = catalog(1, 2); source.assets[0].size.x = 4;
  const again = importPropCatalogBindings(first.bindings, source, [asset(2), asset(1)], 'decoration');
  assert.equal(again.added, 0); assert.equal(again.updated, 2); assert.equal(again.bindings.length, 2);
  assert.deepEqual(again.bindings.map(item => item.id), before.map(item => item.id));
  assert.deepEqual(again.bindings[0], { ...before[0], prop: { ...before[0].prop, size: source.assets[0].size } });
  assert.deepEqual(again.bindings[1], before[1]); assert.deepEqual(first.bindings, before);
});

test('selected eleven GUIDs define registration even when the project contains sixty other prefabs', () => {
  const selected = Array.from({ length: 11 }, (_, index) => index + 1);
  const unselected = Array.from({ length: 60 }, (_, index) => index + 100);
  const source = catalog(...selected);
  // Mix selected and unselected prefabs in scan order so neither position nor total count can define registration.
  const scan = unselected.flatMap((index, offset) => offset < selected.length ? [asset(index), asset(selected[offset])] : [asset(index)]);
  const result = importPropCatalogBindings([], source, scan);
  assert.equal(scan.length, 71); assert.equal(result.added, 11); assert.equal(result.bindings.length, 11);
  assert.deepEqual(result.bindings.map(binding => binding.prefabGuid).sort(), selected.map(guid).sort());
  assert.ok(result.bindings.every(binding => !unselected.map(guid).includes(binding.prefabGuid)));
  assert.equal(result.available, 11); assert.equal(result.unmatched, 0);
  const repeated = importPropCatalogBindings(result.bindings, source, [...scan].reverse());
  assert.deepEqual(repeated.bindings, result.bindings); assert.equal(repeated.added, 0);
});

test('all existing eligible roles receive measurements, structural roles remain unchanged, and absent measurements are reported', () => {
  const existing = [binding(1), binding(2, 'decoration'), binding(3, 'vegetation'), binding(4, 'wall'), binding(5)];
  const before = structuredClone(existing), source = catalog(1, 2, 3, 4, 6);
  const result = importPropCatalogBindings(existing, source, [1, 2, 3, 4, 5, 6].map(asset), 'vegetation');
  assert.equal(result.updated, 3); assert.equal(result.added, 1); assert.equal(result.missing, 1); assert.equal(result.existingOtherRoles, 1);
  for (let i = 0; i < 3; i++) assert.deepEqual(result.bindings[i], { ...before[i], prop: { ...before[i].prop, size: source.assets[i].size } });
  assert.deepEqual(result.bindings[3], before[3]); assert.deepEqual(result.bindings[4], before[4]);
  assert.equal(result.bindings[5].role, 'vegetation'); assert.equal(result.bindings[5].prop!.blocksMovement, false);
  assert.deepEqual(existing, before);
});

test('GUID matching is case insensitive across catalog, scan and all registered roles', () => {
  const upper = 'A'.repeat(32), lower = upper.toLowerCase(), existing = binding(1, 'door'); existing.prefabGuid = upper;
  const source = { version: 1, assets: [{ guid: lower, size: { x: 1, y: 1, z: 1 } }] };
  const scan = [{ ...asset(1), guid: lower }];
  const result = importPropCatalogBindings([existing], source, scan);
  assert.equal(result.added, 0); assert.equal(result.updated, 0); assert.equal(result.existingOtherRoles, 1); assert.deepEqual(result.bindings, [existing]);
  const addition = importPropCatalogBindings([], source, [{ ...scan[0], guid: upper }]);
  assert.equal(addition.added, 1); assert.equal(addition.bindings[0].prefabGuid, lower);
  addition.bindings[0].prefabGuid = upper;
  const repeat = importPropCatalogBindings(addition.bindings, { version: 1, assets: [{ ...source.assets[0], guid: upper }] }, scan);
  assert.equal(repeat.added, 0); assert.equal(repeat.updated, 1); assert.equal(repeat.bindings.length, 1);
});

test('partial project matches add only measured scanned prefabs and count foreign measurements', () => {
  const source = catalog(1, 2, 3), scan = [asset(1), asset(3), asset(4)];
  const result = importPropCatalogBindings([], source, scan, 'decoration');
  assert.equal(result.available, 2); assert.equal(result.unmatched, 1); assert.equal(result.added, 2);
  assert.deepEqual(result.catalog, catalog(1, 3)); assert.deepEqual(result.bindings.map(item => item.prefabGuid), [guid(1), guid(3)]);
  assert.ok(result.bindings.every(item => item.role === 'decoration' && !item.prop!.blocksMovement));
  assert.equal(source.assets.length, 3);
});

test('an unscanned project retains measurement-only compatibility without creating unverified prefab paths', () => {
  const existing = binding(1), source = catalog(1, 2), result = importPropCatalogBindings([existing], source, null);
  assert.equal(result.added, 0); assert.equal(result.updated, 1); assert.equal(result.available, 2); assert.equal(result.unmatched, 0);
  assert.equal(result.bindings.length, 1); assert.deepEqual(result.catalog, source);
});

test('a capacity overflow rejects the entire import including pending measurement updates', () => {
  const existing = Array.from({ length: MAX_BINDINGS - 1 }, (_, i) => binding(i + 1, 'wall'));
  existing[0] = binding(1);
  const before = structuredClone(existing), source = catalog(1, 500, 501), savedSource = structuredClone(source), scan = [1, 500, 501].map(asset);
  assert.throws(() => importPropCatalogBindings(existing, source, scan), /255.*2.*256.*적용/);
  assert.deepEqual(existing, before); assert.deepEqual(source, savedSource);
  const full = importPropCatalogBindings(existing, catalog(1, 500), [asset(1), asset(500)]);
  assert.equal(full.bindings.length, MAX_BINDINGS); assert.equal(full.added, 1); assert.equal(full.updated, 1);
  assert.deepEqual(parseBindings(full.bindings), full.bindings);
  assert.equal(importPropCatalogBindings(full.bindings, catalog(500), [asset(500)]).added, 0);
});

test('empty, malformed, duplicate GUID and entirely unmatched catalogs fail without changing inputs', () => {
  const existing = [binding(1)], before = structuredClone(existing), scan = [asset(1)];
  const invalid = [
    { version: 1, assets: [] }, { version: 2, assets: [] },
    { version: 1, assets: [{ guid: guid(1), size: { x: 0, y: 1, z: 1 } }] },
    { version: 1, assets: [{ guid: guid(1), size: { x: 1, y: 1, z: 1 }, path: 'Assets/untrusted.prefab' }] },
    { version: 1, assets: [{ guid: 'a'.repeat(32), size: { x: 1, y: 1, z: 1 } }, { guid: 'A'.repeat(32), size: { x: 2, y: 1, z: 1 } }] },
    catalog(2),
  ];
  for (const value of invalid) { assert.throws(() => importPropCatalogBindings(existing, value, scan)); assert.deepEqual(existing, before); }
  assert.throws(() => importPropCatalogBindings(existing, catalog(1), []), /일치/);
  assert.throws(() => importPropCatalogBindings(existing, catalog(1), scan, 'wall' as 'prop'), /소품·장식·식생/);
});

test('stable imported IDs avoid collisions with unrelated existing bindings and survive a repeat import', () => {
  const first = binding(99, 'floor'), second = binding(98, 'wall');
  first.id = `asset_bounds_${guid(1)}`; second.id = `${first.id}_2`;
  const source = catalog(1, 2), scan = [asset(1), asset(2)];
  const result = importPropCatalogBindings([first, second], source, scan);
  assert.equal(result.bindings[2].id, `${first.id}_3`); assert.equal(new Set(result.bindings.map(item => item.id)).size, 4);
  assert.deepEqual(parseBindings(result.bindings), result.bindings);
  assert.deepEqual(importPropCatalogBindings([first, second], source, [...scan].reverse()).bindings, result.bindings);
  assert.deepEqual(importPropCatalogBindings(result.bindings, source, scan).bindings, result.bindings);
});

test('unusual scanned prefab labels remain valid without changing the scanned path', () => {
  const names = ['  Crate\u0001\t\n  ', '나'.repeat(100), '\t\n\u007f'];
  const scan = names.map((name, index) => ({ ...asset(index + 1), name }));
  const result = importPropCatalogBindings([], catalog(1, 2, 3), scan);
  assert.deepEqual(result.bindings.map(item => item.label), ['Crate', '나'.repeat(80), '프리팹']);
  assert.deepEqual(result.bindings.map(item => item.prefabPath), scan.map(item => item.path));
  assert.deepEqual(parseBindings(result.bindings), result.bindings);
});

test('imported bounds can furnish existing terrain and save/reopen without a manual registration pass', () => {
  const width = 16, height = 16;
  const map: GridMap = { version: 5, name: 'Bulk import furnishing', width, height, cellSize: 2, maxStepHeight: .4,
    rows: Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`),
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], connections: [{ id: 'north', label: 'North', x: 8, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
  map.rows[0] = '########D#######';
  const settings = { ...DEFAULT_SETTINGS, width, height, connectionCount: 1, seed: 731, designer: { ...DEFAULT_DESIGNER, props: false, decorations: false, propCoverage: 4 } };
  const indices = Array.from({ length: 11 }, (_, i) => i + 1);
  const imported = importPropCatalogBindings([], catalog(...indices), indices.map(asset));
  const furnished = furnishExistingMap(map, settings, imported.bindings, { props: true, decorations: false });
  assert.ok(furnished.addedProps > 0, JSON.stringify(furnished.issues)); assert.ok(furnished.usedBindingIds.length > 1);
  const project = { formatVersion: 1, map: furnished.map, settings, bindings: imported.bindings };
  const reopened = parseProjectFile(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reopened.bindings, imported.bindings);
  assert.deepEqual(reopened.map.propInstances, furnished.map.propInstances); assert.deepEqual(reopened.map.rows, furnished.map.rows);
  assert.deepEqual(reopened.map.elevations, map.elevations); assert.deepEqual(reopened.map.connections, map.connections);
  assert.equal(reopened.settings.designer!.props, false);
  for (let row = 0; row < height; row++) for (let x = 0; x < width; x++) assert.ok(map.rows[row][x] === furnished.map.rows[row][x] || map.rows[row][x] === '.' && furnished.map.rows[row][x] === 'P');
  assert.deepEqual(furnished.map.elevations, map.elevations);
});
