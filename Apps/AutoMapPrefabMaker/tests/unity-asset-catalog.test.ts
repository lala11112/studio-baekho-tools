import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAssetScale } from '../src/shared/asset-scaling';
import { ASSET_ROLES } from '../src/shared/features';
import { MAX_BINDINGS, parseBindings, parseProjectFile, DEFAULT_SETTINGS } from '../src/shared/map';
import { suggestPropDefinition } from '../src/shared/props';
import { importUnityAssetCatalogBindings, parseUnityAssetCatalog, type UnityAssetCatalog, type UnityAssetCatalogEntry } from '../src/shared/unity-asset-catalog';
import { defaultWallMount } from '../src/shared/wall-mounts';
import type { AssetBinding, AssetRole, PrefabAsset } from '../src/shared/types';

const guid = (index: number) => index.toString(16).padStart(32, '0');
const prefab = (index: number): PrefabAsset => ({ guid: guid(index), name: `Crate_${index}`, path: `Assets/Prefabs/Crate_${index}.prefab` });
const entry = (index: number, role: AssetRole = 'prop'): UnityAssetCatalogEntry => ({
  guid: guid(index), path: prefab(index).path, role, size: { x: 1.2, y: .8, z: 1 },
  bounds: { center: { x: .1, y: .4, z: -.3 }, size: { x: 1.2, y: .8, z: 1 } },
});
const catalog = (...assets: UnityAssetCatalogEntry[]): UnityAssetCatalog => ({ format: 'baekho-asset-catalog', version: 1, assets, skipped: [] });
const binding = (index: number, role: AssetRole = 'prop'): AssetBinding => ({
  id: `existing_${index}`, label: '직접 지정한 이름', role, prefabGuid: guid(index), prefabPath: prefab(index).path,
  scale: { x: 2, y: 3, z: 4 }, offset: { x: .1, y: .2, z: .3 }, rotationY: 75,
  ...(['stair', 'slope'].includes(role) ? { stairNativeRise: 1.8 } : {}),
  ...(role === 'light' ? { lightAnchor: 'wall' as const } : {}),
});
const wallEntry = (index: number, role: AssetRole = 'decoration'): UnityAssetCatalogEntry => ({ ...entry(index, role), wallMount: defaultWallMount(binding(index, 'decoration')) });

test('all supported Unity catalog roles register together with manual role defaults and measured bounds', () => {
  const source = catalog(...ASSET_ROLES.map((role, index) => entry(index + 1, role)));
  const scan = source.assets.map((_, index) => prefab(index + 1));
  const before = structuredClone({ source, scan });
  const result = importUnityAssetCatalogBindings([], source, scan, 3);
  assert.equal(result.added, ASSET_ROLES.length); assert.equal(result.updated, 0); assert.equal(result.unmatched, 0);
  assert.deepEqual(parseBindings(result.bindings), result.bindings);
  for (const [index, actual] of result.bindings.entries()) {
    const expected = source.assets[index];
    assert.equal(actual.role, expected.role); assert.equal(actual.prefabPath, scan[index].path); assert.equal(actual.label, scan[index].name);
    assert.deepEqual(actual.scale, defaultAssetScale(actual.role, 3)); assert.deepEqual(actual.bounds, expected.bounds);
    assert.deepEqual(actual.offset, { x: 0, y: 0, z: 0 }); assert.equal(actual.rotationY, 0);
    assert.equal(result.byRole[actual.role].added, 1); assert.equal(result.byRole[actual.role].updated, 0);
    if (['prop', 'decoration', 'vegetation'].includes(actual.role)) assert.deepEqual(actual.prop, { ...suggestPropDefinition(actual), size: expected.size });
    else assert.equal(actual.prop, undefined);
    if (['stair', 'slope'].includes(actual.role)) assert.equal(actual.stairNativeRise, 1);
  }
  assert.deepEqual({ source, scan }, before);
  result.bindings[0].bounds!.center.y = 99; result.catalog.assets[0].bounds.size.x = 99;
  assert.deepEqual({ source, scan }, before);
});

test('new catalog metadata overrides only initial registration defaults', () => {
  const stair = { ...entry(1, 'stair'), label: '높은 계단', scale: { x: .8, y: .9, z: 2 }, offset: { x: -.1, y: .7, z: -.9 }, rotationY: 180, stairNativeRise: 2.5 };
  const light = { ...entry(2, 'light'), lightAnchor: 'ceiling' as const };
  const result = importUnityAssetCatalogBindings([], catalog(stair, light), [prefab(1), prefab(2)], 3);
  assert.deepEqual(result.bindings[0], { id: `asset_catalog_${guid(1)}`, label: stair.label, role: 'stair', prefabGuid: guid(1), prefabPath: prefab(1).path,
    scale: stair.scale, offset: stair.offset, rotationY: 180, stairNativeRise: 2.5, bounds: stair.bounds });
  assert.equal(result.bindings[1].lightAnchor, 'ceiling'); assert.deepEqual(result.bindings[1].scale, { x: 1, y: 1, z: 1 });
});

test('repeated imports are idempotent and retain user roles, names, transforms and prop placement settings', () => {
  const first = importUnityAssetCatalogBindings([], catalog(entry(1), entry(2, 'light'), entry(3, 'stair')), [1, 2, 3].map(prefab), 2);
  const prop = first.bindings[0]; prop.label = '사용자 책상'; prop.scale = { x: 4, y: 3, z: 2 }; prop.offset.y = .9; prop.rotationY = 35;
  prop.prop = { ...suggestPropDefinition(prop), category: '기계', tags: ['사용자'], blocksMovement: false, placement: 'wall', roomTypes: ['shop'], weight: 0,
    composition: { usage: 'equipment', family: '실험실', member: 'companion', arrangement: 'wall' } };
  first.bindings[1].lightAnchor = 'wall'; first.bindings[2].stairNativeRise = 3.4;
  const source = catalog({ ...entry(1, 'vegetation'), label: '새 Unity 이름', scale: { x: 1, y: 1, z: 1 }, rotationY: 180 },
    { ...entry(2, 'light'), lightAnchor: 'ceiling' }, { ...entry(3, 'stair'), stairNativeRise: 1 });
  const before = structuredClone(first.bindings);
  const second = importUnityAssetCatalogBindings(first.bindings, source, [1, 2, 3].map(prefab), 4);
  assert.equal(second.added, 0); assert.equal(second.updated, 3); assert.equal(second.bindings.length, 3);
  assert.deepEqual(second.bindings[0], { ...before[0], prop: { ...before[0].prop, size: source.assets[0].size } });
  assert.deepEqual(second.bindings.slice(1), before.slice(1)); assert.deepEqual(first.bindings, before);
  assert.deepEqual(importUnityAssetCatalogBindings(second.bindings, source, [1, 2, 3].map(prefab), 1).bindings, second.bindings);
});

test('a moved prefab refreshes its path while preserving app identity and absent registrations', () => {
  const registered = [binding(1), binding(2, 'floor')], before = structuredClone(registered);
  const moved = { ...prefab(1), path: 'Assets/Moved/Crate.prefab' };
  const source = catalog({ ...entry(1), path: moved.path, size: { x: 3, y: 2, z: 1 }, bounds: { center: { x: 1, y: 1, z: 1 }, size: { x: 3, y: 2, z: 1 } } });
  const result = importUnityAssetCatalogBindings(registered, source, [moved], 2);
  assert.equal(result.added, 0); assert.equal(result.updated, 1); assert.equal(result.bindings[0].id, registered[0].id);
  assert.equal(result.bindings[0].prefabPath, moved.path); assert.deepEqual(result.bindings[0].prop!.size, source.assets[0].size);
  assert.deepEqual(result.bindings[1], registered[1]); assert.deepEqual(registered, before);
});

test('foreign GUIDs and stale source paths are skipped and never fabricate project identities', () => {
  const existing = [binding(1)], before = structuredClone(existing);
  const source = catalog({ ...entry(1), path: 'Assets/Stale.prefab' }, entry(2), entry(3, 'wall'));
  source.skipped.push({ path: 'Assets/Unspecified.prefab', reason: '종류를 지정해 주세요.' });
  const result = importUnityAssetCatalogBindings(existing, source, [prefab(1), prefab(3)], 2);
  assert.equal(result.added, 1); assert.equal(result.updated, 0); assert.equal(result.unmatched, 2);
  assert.deepEqual(result.bindings[0], existing[0]); assert.deepEqual(result.catalog.assets, [entry(3, 'wall')]);
  assert.equal(result.skipped.length, 3); assert.deepEqual(result.skipped[0], source.skipped[0]);
  assert.deepEqual(existing, before);
});

test('GUID matching is case insensitive and existing multi-role registrations all refresh without duplication', () => {
  const upper = 'A'.repeat(32), lower = upper.toLowerCase();
  const entries = [binding(1), binding(2, 'floor')]; entries.forEach(item => { item.prefabGuid = upper; });
  const source = catalog({ ...entry(1, 'vegetation'), guid: lower });
  const result = importUnityAssetCatalogBindings(entries, source, [{ ...prefab(1), guid: upper }], 2);
  assert.equal(result.added, 0); assert.equal(result.updated, 2); assert.equal(result.bindings.length, 2);
  assert.deepEqual(result.bindings.map(item => item.role), ['prop', 'floor']);
  assert.equal(result.byRole.prop.updated, 1); assert.equal(result.byRole.floor.updated, 1);
  assert.deepEqual(result.bindings.map(item => item.bounds), [source.assets[0].bounds, source.assets[0].bounds]);
  assert.equal(result.bindings[1].prop, undefined);
  const added = importUnityAssetCatalogBindings([], source, [{ ...prefab(1), guid: upper }], 2);
  assert.equal(added.bindings[0].prefabGuid, lower);
});

test('new wall metadata is imported fully and nullable metadata is treated as absent', () => {
  const existing = binding(1, 'decoration'), source = catalog(wallEntry(1));
  const first = importUnityAssetCatalogBindings([existing], source, [prefab(1)], 2);
  assert.deepEqual(first.bindings[0].wallMount, source.assets[0].wallMount); assert.equal(first.bindings[0].rotationY, existing.rotationY);
  const nullable = catalog(wallEntry(1)) as unknown as { assets: { wallMount: unknown }[] };
  nullable.assets[0].wallMount = null;
  assert.equal(parseUnityAssetCatalog(nullable).assets[0].wallMount, undefined);
});

test('existing wall installation policy survives while measured connection geometry refreshes', () => {
  const existing = binding(1, 'decoration');
  existing.wallMount = { ...defaultWallMount(existing), kind: 'single', family: '사용자 계열', sites: ['upper', 'lower'],
    heightMode: 'top', height: .75, spacing: 4.5, probability: 35, doorSide: 'left' };
  const measured = wallEntry(1), incoming = measured.wallMount!;
  incoming.family = 'Unity 새 계열'; incoming.heightMode = 'floor'; incoming.height = 2;
  incoming.mounts = [{ position: { x: .2, y: .6, z: -.4 }, direction: { x: 0, y: 0, z: 1 } }];
  incoming.collisionBoxes = [{ center: { x: .1, y: .4, z: -.3 }, size: { x: .4, y: .3, z: .2 } }];
  const source = catalog(measured), before = structuredClone({ existing, source });
  const result = importUnityAssetCatalogBindings([existing], source, [prefab(1)], 2);
  assert.deepEqual(result.bindings[0].wallMount, { ...existing.wallMount, mounts: incoming.mounts, sockets: incoming.sockets, collisionBoxes: incoming.collisionBoxes });
  assert.equal(result.updated, 1); assert.deepEqual(parseBindings(result.bindings), result.bindings);
  assert.deepEqual({ existing, source }, before);
});

test('missing source wall module retains app-authored installation and geometry while refreshing size', () => {
  const existing = binding(1, 'decoration');
  existing.wallMount = { ...defaultWallMount(existing), heightMode: 'floor', height: 1.2, probability: 45, sites: ['doorTop'] };
  const sourceEntry = entry(1, 'decoration'); sourceEntry.size.y = 1.6; sourceEntry.bounds.size.y = 1.6;
  const before = structuredClone(existing);
  const result = importUnityAssetCatalogBindings([existing], catalog(sourceEntry), [prefab(1)], 2);
  assert.deepEqual(result.bindings[0].wallMount, existing.wallMount); assert.deepEqual(result.bindings[0].bounds, sourceEntry.bounds);
  assert.deepEqual(result.bindings[0].prop!.size, sourceEntry.size); assert.equal(result.updated, 1); assert.deepEqual(result.skipped, []);
  assert.deepEqual(existing, before);
});

test('connection geometry incompatible with a preserved wall kind rejects every pending update atomically', () => {
  const existing = binding(1, 'decoration'); existing.wallMount = defaultWallMount(existing);
  const incoming = wallEntry(1); incoming.wallMount!.kind = 'straight'; incoming.wallMount!.family = 'Unity 배관';
  incoming.wallMount!.sockets = [
    { position: { x: -.5, y: .4, z: -.4 }, direction: { x: -1, y: 0, z: 0 } },
    { position: { x: .5, y: .4, z: -.4 }, direction: { x: 1, y: 0, z: 0 } },
  ];
  const source = catalog(incoming, entry(2)), scan = [prefab(1), prefab(2)], before = structuredClone({ existing, source, scan });
  assert.equal(parseUnityAssetCatalog(source).assets[0].wallMount!.kind, 'straight');
  assert.throws(() => importUnityAssetCatalogBindings([existing], source, scan, 2), /벽 부착물/);
  assert.deepEqual({ existing, source, scan }, before);
});

test('a duplicate GUID under any incompatible role rejects all wall metadata changes atomically', () => {
  for (const role of ['floor', 'wall', 'prop', 'door', 'stair'] as const) {
    const compatible = binding(1, 'decoration'), incompatible = { ...binding(2, role), prefabGuid: guid(1) };
    const existing = [compatible, incompatible], source = catalog(wallEntry(1), entry(3));
    const scan = [prefab(1), prefab(3)], before = structuredClone({ existing, source, scan });
    assert.throws(() => importUnityAssetCatalogBindings(existing, source, scan, 2), /벽 부착.*기존 에셋.*먼저 변경.*적용되지/);
    assert.deepEqual({ existing, source, scan }, before);
  }
});

test('capacity overflow rejects pending refreshes and exact capacity remains valid', () => {
  const existing = Array.from({ length: MAX_BINDINGS - 1 }, (_, index) => binding(index + 1, 'wall'));
  const source = catalog(entry(1, 'wall'), entry(1000), entry(1001)), scan = [prefab(1), prefab(1000), prefab(1001)];
  const before = structuredClone(existing);
  assert.throws(() => importUnityAssetCatalogBindings(existing, source, scan, 2), /최대 256.*적용되지/); assert.deepEqual(existing, before);
  const result = importUnityAssetCatalogBindings(existing, catalog(entry(1, 'wall'), entry(1000)), scan, 2);
  assert.equal(result.bindings.length, MAX_BINDINGS); assert.equal(result.added, 1); assert.equal(result.updated, 1);
});

test('catalog IDs avoid collisions with unrelated manually registered IDs', () => {
  const existing = binding(2); existing.id = `asset_catalog_${guid(1)}`;
  const result = importUnityAssetCatalogBindings([existing], catalog(entry(1)), [prefab(1)], 2);
  assert.equal(result.bindings[1].id, `asset_catalog_${guid(1)}_2`);
});

test('empty catalogs and all-excluded catalogs are valid no-op imports', () => {
  const existing = [binding(1)], empty = catalog(); empty.skipped = [{ path: 'Assets/Disabled.prefab', reason: '등록 제외' }];
  const result = importUnityAssetCatalogBindings(existing, empty, [], 2);
  assert.deepEqual(result.bindings, existing); assert.equal(result.added, 0); assert.equal(result.updated, 0); assert.deepEqual(result.skipped, empty.skipped);
  assert.deepEqual(parseUnityAssetCatalog(catalog()), catalog());
});

test('malformed catalog shape, identities, measurements and metadata reject without partial output', () => {
  const variants: unknown[] = [null, { version: 1, assets: [] }, { ...catalog(), version: 2 }, { ...catalog(), unexpected: true }, { ...catalog(), skipped: null },
    catalog({ ...entry(1), guid: 'made-up' }), catalog({ ...entry(1), path: 'Packages/Crate.prefab' }), catalog({ ...entry(1), path: 'Assets/../Crate.prefab' }),
    catalog({ ...entry(1), path: 'Assets\\Crate.prefab' }), catalog({ ...entry(1), path: 'Assets/Crate.fbx' }),
    catalog({ ...entry(1), size: { x: 0, y: 1, z: 1 } }), catalog({ ...entry(1), size: { x: Infinity, y: 1, z: 1 } }),
    catalog({ ...entry(1), size: { x: 1e-100, y: 1, z: 1 } }), catalog({ ...entry(1), size: { x: 1.2, y: 2, z: 1 } }),
    catalog({ ...entry(1), role: 'unknown' as AssetRole }), catalog({ ...entry(1), label: '' }), catalog({ ...entry(1), label: 'x'.repeat(81) }),
    catalog({ ...entry(1), rotationY: NaN }), catalog({ ...entry(1), scale: { x: 0, y: 1, z: 1 } }), catalog({ ...entry(1), lightAnchor: 'wall' }),
    catalog({ ...entry(1), stairNativeRise: 1 }), catalog({ ...entry(1, 'stair'), stairNativeRise: 0 }),
    catalog({ ...wallEntry(1), role: 'floor' }), catalog({ ...entry(1), bounds: undefined } as unknown as UnityAssetCatalogEntry),
    catalog(entry(1), { ...entry(1), guid: guid(1).toUpperCase() }),
    { ...catalog(), skipped: [{ path: 'Assets/Bad.prefab', reason: 3 }] }, { ...catalog(), skipped: [{ path: '', reason: '실패' }] },
    { ...catalog(), skipped: [{ path: 'Assets/Bad.prefab', reason: 'a'.repeat(2001) }] },
    { ...catalog(), assets: Array.from({ length: 20_001 }, () => entry(1)) }];
  for (const source of variants) assert.throws(() => parseUnityAssetCatalog(source));
});

test('ambiguous or invalid current scan identities cannot be used to register a prefab', () => {
  const source = catalog(entry(1));
  for (const scan of [[prefab(1), { ...prefab(1), path: 'Assets/DuplicateGuid.prefab' }], [prefab(1), { ...prefab(2), path: prefab(1).path }],
    [{ ...prefab(1), path: 'Assets/../Outside.prefab' }], [{ ...prefab(1), guid: 'unverified' }]]) {
    assert.throws(() => importUnityAssetCatalogBindings([], source, scan, 2), /스캔/);
  }
  for (const size of [0, -1, NaN, Infinity]) assert.throws(() => importUnityAssetCatalogBindings([], source, [prefab(1)], size));
});

test('imported registrations survive the existing project serialization format', () => {
  const result = importUnityAssetCatalogBindings([], catalog(entry(1, 'floor'), entry(2, 'stair'), entry(3, 'light'), wallEntry(4)), [1, 2, 3, 4].map(prefab), 2);
  const project = parseProjectFile({ formatVersion: 1, map: { version: 3, name: '카탈로그', width: 8, height: 8, cellSize: 2,
    rows: Array.from({ length: 8 }, () => '........'), elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], maxStepHeight: .5, connections: [], assetOverrides: [] },
    settings: { ...DEFAULT_SETTINGS, width: 8, height: 8 }, bindings: result.bindings });
  assert.deepEqual(project.bindings, result.bindings);
  assert.deepEqual(parseProjectFile(JSON.parse(JSON.stringify(project))).bindings, result.bindings);
});
