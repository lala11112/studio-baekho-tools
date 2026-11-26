import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePropField, renderPropLibraryFields } from '../src/prop-library';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { parsePropDefinition } from '../src/shared/props';
import { importUnityAssetCatalogBindings, parseUnityAssetCatalog, type UnityAssetCatalog, type UnityPropSetCatalogEntry } from '../src/shared/unity-asset-catalog';
import type { PrefabAsset } from '../src/shared/types';

const guid = (index: number) => index.toString(16).padStart(32, '0');
const assets: PrefabAsset[] = [1, 2, 3].map(index => ({ guid: guid(index), name: `SM_${index}`, path: `Assets/SM_${index}.prefab` }));
const set = (index: number, members = [1, 2]): UnityPropSetCatalogEntry => ({ guid: guid(100 + index), path: `Assets/Set${index}.asset`, label: `작업 구역 ${index}`, usage: 'equipment', arrangement: 'either', prefabGuids: members.map(guid) });
const catalog = (propSets?: UnityPropSetCatalogEntry[]): UnityAssetCatalog => ({
  format: 'baekho-asset-catalog', version: 1, skipped: [],
  assets: assets.map(asset => ({ ...asset, role: 'prop' as const, size: { x: 1, y: 1, z: 1 }, bounds: { center: { x: 0, y: .5, z: 0 }, size: { x: 1, y: 1, z: 1 } } })).map(({ name: _name, ...entry }) => entry),
  ...(propSets === undefined ? {} : { propSets }),
});

test('Unity prefab lists import shared membership, persist, and refresh without duplicate registrations', () => {
  const source = catalog([set(1), set(2, [2, 3])]), before = structuredClone(source);
  const first = importUnityAssetCatalogBindings([], source, assets, 2);
  assert.equal(first.added, 3); assert.equal(first.propSetCount, 2); assert.equal(first.propSetMembers, 3);
  assert.deepEqual(first.bindings.map(b => b.prop!.unitySets!.length), [1, 2, 1]);
  assert.equal(first.bindings[1].prop!.composition, undefined);
  assert.equal(first.bindings[1].prop!.category, '미분류');
  const second = importUnityAssetCatalogBindings(first.bindings, source, assets, 2);
  assert.equal(second.added, 0); assert.deepEqual(second.bindings, first.bindings);
  const project = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings: first.bindings });
  assert.deepEqual(parseProjectFile(JSON.parse(JSON.stringify(project))).bindings, first.bindings);
  assert.deepEqual(source, before);
});

test('Unity refresh updates only set membership, preserving manual exclusions and placement choices', () => {
  const initial = importUnityAssetCatalogBindings([], catalog([set(1)]), assets, 2).bindings;
  initial[1] = handlePropField(initial[1], 'composition.usage', 'excluded');
  initial[1].prop!.weight = 0; initial[1].prop!.tags = ['공장']; initial[1].prop!.roomTypes = ['boss'];
  initial[1].prop!.behavior = 'floorEquipment'; initial[1].prop!.frontYaw = 180;
  initial[1].scale = { x: 3, y: 2, z: 1 };
  const manual = structuredClone(initial[1]);
  const changed = { ...set(1, [2, 3]), label: '새 세트 이름', arrangement: 'wall' as const };
  const updated = importUnityAssetCatalogBindings(initial, catalog([changed]), assets, 2).bindings;
  assert.equal(updated[0].prop!.unitySets, undefined);
  assert.equal(updated[1].prop!.unitySets![0].label, changed.label);
  assert.deepEqual(updated[1].prop!.composition, manual.prop!.composition);
  assert.equal(updated[1].prop!.weight, 0); assert.deepEqual(updated[1].scale, manual.scale);
  assert.deepEqual(updated[1].prop!.tags, ['공장']); assert.deepEqual(updated[1].prop!.roomTypes, ['boss']);
  assert.equal(updated[1].prop!.behavior, 'floorEquipment'); assert.equal(updated[1].prop!.frontYaw, 180);
  assert.deepEqual(initial[1], manual);
  assert.deepEqual(importUnityAssetCatalogBindings(updated, catalog(), assets, 2).bindings, updated, 'old exporters do not erase set memberships');
  const cleared = importUnityAssetCatalogBindings(updated, catalog([]), assets, 2).bindings;
  assert.ok(cleared.every(b => !b.prop!.unitySets));
  assert.deepEqual(cleared[1].prop!.composition, manual.prop!.composition);
});

test('removing or disabling an unmarked set member clears membership even when absent from the next asset catalog', () => {
  const initial = importUnityAssetCatalogBindings([], catalog([set(1)]), assets, 2).bindings;
  const source = catalog([set(1, [2])]); source.assets = source.assets.filter(asset => asset.guid === guid(2));
  const updated = importUnityAssetCatalogBindings(initial, source, assets, 2);
  assert.equal(updated.bindings.length, initial.length, 'registrations are retained');
  assert.equal(updated.bindings[0].prop!.unitySets, undefined);
  assert.equal(updated.bindings[1].prop!.unitySets?.length, 1);
});

test('stale or foreign members are filtered against the connected project before assigning memberships', () => {
  const result = importUnityAssetCatalogBindings([], catalog([set(1)]), [assets[0]], 2);
  assert.equal(result.bindings.length, 1); assert.equal(result.propSetMembers, 1);
  assert.deepEqual(result.catalog.propSets![0].prefabGuids, [guid(1)]);
  assert.ok(result.skipped.some(item => item.path === set(1).path));
  assert.deepEqual(parseUnityAssetCatalog(result.catalog), result.catalog);
});

test('invalid sets fail before importing any registrations', () => {
  const invalid: unknown[] = [null, {}, [set(1), set(1)], [{ ...set(1), path: 'Assets/../Outside.asset' }],
    [{ ...set(1), path: 'Assets/Set.prefab' }], [{ ...set(1), label: '' }], [{ ...set(1), label: 'x'.repeat(81) }],
    [{ ...set(1), usage: 'unknown' }], [{ ...set(1), arrangement: 'ceiling' }],
    [{ ...set(1), prefabGuids: [] }], [{ ...set(1), prefabGuids: [guid(1), guid(1)] }],
    [{ ...set(1), prefabGuids: [guid(999)] }], [{ ...set(1), extra: true }], Array.from({ length: 257 }, (_, i) => set(i))];
  for (const propSets of invalid) assert.throws(() => importUnityAssetCatalogBindings([], { ...catalog(), propSets }, assets, 2), /세트|propSets/);
  const wrongRole = catalog([set(1)]); wrongRole.assets[0].role = 'wall';
  assert.throws(() => parseUnityAssetCatalog(wrongRole), /바닥용/);
  const prop = importUnityAssetCatalogBindings([], catalog([set(1)]), assets, 2).bindings[0].prop!;
  assert.throws(() => parsePropDefinition({ ...prop, unitySets: [...prop.unitySets!, ...prop.unitySets!] }), /중복/);
  assert.throws(() => parsePropDefinition({ ...prop, unitySets: [{ ...prop.unitySets![0], member: 'anchor' }] }), /Unity 소품 세트/);
});

test('Unity set UI needs no per-prefab composition fields, while manual override and return to sets are reversible', () => {
  const source = catalog([{ ...set(1), label: '<img src=x> 작업 구역' }]);
  const imported = importUnityAssetCatalogBindings([], source, assets, 2).bindings[0];
  const html = renderPropLibraryFields(imported);
  assert.match(html, /Unity 세트 사용/); assert.match(html, /data-prop-composition-state="unity"/);
  assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /data-prop-field="composition.family"/);
  assert.match(html, /data-prop-field="behavior"/); assert.match(html, /data-prop-field="frontYaw"/);
  const manual = handlePropField(imported, 'composition.mode', 'manual');
  assert.match(renderPropLibraryFields(manual), /data-prop-field="composition.family"/);
  assert.match(renderPropLibraryFields(manual), /현재는 앱에서 직접 지정/);
  assert.deepEqual(handlePropField(manual, 'composition.mode', 'automatic'), imported);
});
