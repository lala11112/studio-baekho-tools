import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { effectivePropComposition, getCompositionIssues, suggestPropComposition } from '../src/shared/prop-composition';
import type { AssetBinding } from '../src/shared/types';

const asset = (label: string): AssetBinding => ({ id: 'asset', label, role: 'prop', prefabGuid: '1'.repeat(32), prefabPath: `Assets/Props/${label}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 });

test('semantic suggestions distinguish equipment, storage, natural objects, floor detail, and edge parts', () => {
  for (const [name, usage] of [['SM_Console_01', 'equipment'], ['Terminal01', 'equipment'], ['MetalCrate02', 'storage'], ['Barrel_Oak', 'storage'], ['Rock_Large', 'natural'], ['바위_큰것', 'natural'], ['MetalFloorPlate', 'floorDetail'], ['Ground_Grate', 'floorDetail'], ['SCIFI_Railing_1', 'edge'], ['난간_직선', 'edge']] as const) {
    assert.equal(suggestPropComposition(asset(name)).usage, usage, name);
  }
  assert.equal(suggestPropComposition(asset('Chair')).member, 'companion');
  assert.equal(suggestPropComposition(asset('Console')).arrangement, 'wall');
  assert.equal(suggestPropComposition(asset('Crate')).arrangement, 'island');
});

test('unknown prefab names remain unknown even when a parent folder has a recognized purpose', () => {
  const binding = asset('SM_A001'); binding.prefabPath = 'Assets/Storage/Crate/SM_A001.prefab';
  assert.deepEqual(suggestPropComposition(binding), { usage: 'unknown', family: 'unknown', member: 'either', arrangement: 'either' });
  assert.equal(suggestPropComposition({ ...binding, role: 'railing' }).usage, 'edge');
});

test('an explicit composition overrides the filename and is returned without sharing mutable state', () => {
  const binding = asset('Crate');
  binding.prop = { category: 'custom', tags: [], blocksMovement: true, size: { x: 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle'], weight: 1,
    composition: { usage: 'excluded', family: 'excluded', member: 'companion', arrangement: 'wall' } };
  const before = structuredClone(binding), effective = effectivePropComposition(binding);
  assert.equal(effective.usage, 'excluded'); effective.family = 'changed';
  assert.deepEqual(binding, before);
});

test('an authored semantic category is recognized, while size alone never invents a purpose', () => {
  const binding = asset('SM_A001');
  binding.prop = { category: '상자', tags: [], blocksMovement: true, size: { x: 4, y: 1, z: 2 }, placement: 'floor', roomTypes: ['battle'], weight: 1 };
  assert.equal(suggestPropComposition(binding).usage, 'storage');
  binding.prop.category = '미분류';
  assert.equal(suggestPropComposition(binding).usage, 'unknown');
});

test('composition diagnostics are available without generation and leave the catalog and settings untouched', () => {
  const names = ['SM_A001', 'Railing', 'Floor_Panel', 'CrateExcluded', 'CrateWall', 'CrateNonblocking'];
  const bindings: AssetBinding[] = names.map((name, i) => ({ ...asset(name), id: `asset_${i}`, prop: { category: name, tags: [], blocksMovement: true, size: { x: 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle'], weight: 1 } }));
  bindings[3].prop = { ...bindings[3].prop!, weight: 0, composition: { usage: 'excluded', family: 'excluded', member: 'either', arrangement: 'either' } };
  bindings[4].prop!.placement = 'wall'; bindings[5].prop!.blocksMovement = false;
  const settings = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, props: true } }, before = structuredClone({ bindings, settings });
  const codes = getCompositionIssues(bindings, settings).map(i => i.code);
  for (const code of ['unknown', 'edge', 'floor-detail', 'excluded', 'wrong-placement', 'nonblocking-prop']) assert.ok(codes.includes(`grouped-props-${code}`), code);
  assert.deepEqual({ bindings, settings }, before);
  settings.designer.props = false;
  assert.deepEqual(getCompositionIssues(bindings, settings), []);
});

test('measured size allows large recognized accessories to anchor a set and includes the registered scale', () => {
  for (const name of ['Monitor', 'Chair', 'Keyboard']) {
    const binding = asset(name);
    binding.prop = { category: '미분류', tags: [], blocksMovement: true, size: { x: .6, y: .6, z: .6 }, placement: 'floor', roomTypes: ['battle'], weight: 1 };
    assert.equal(suggestPropComposition(binding).usage, 'equipment');
    assert.equal(suggestPropComposition(binding).member, 'companion');
    binding.scale.x = 4;
    assert.equal(suggestPropComposition(binding).member, 'either', 'a large display or chair can become a group anchor');
    binding.scale.x = 1; binding.scale.y = 4;
    assert.equal(suggestPropComposition(binding).member, 'either', 'height can also qualify a substantial object');
    binding.scale.y = 1; binding.prop.size = { x: 1.2, y: 1, z: 1.2 };
    assert.equal(suggestPropComposition(binding).member, 'companion', 'ordinary existing accessory recommendations remain unchanged');
  }
  for (const name of ['Console', 'Crate', 'Bush']) {
    const binding = asset(name);
    binding.prop = { category: '미분류', tags: [], blocksMovement: true, size: { x: .4, y: .4, z: .4 }, placement: 'floor', roomTypes: ['battle'], weight: 1 };
    assert.equal(suggestPropComposition(binding).member, 'either', 'small generic catalogs must still form groups');
  }
});

test('measured bounds provide the same conservative hint while unknown geometry and explicit composition keep priority', () => {
  const binding = asset('Monitor'); binding.bounds = { center: { x: 0, y: .2, z: 0 }, size: { x: .4, y: .4, z: .4 } };
  assert.equal(suggestPropComposition(binding).member, 'companion');
  binding.bounds.size.x = 2.4;
  assert.equal(suggestPropComposition(binding).member, 'either');
  const unknown = { ...binding, label: 'SM_A001', prefabPath: 'Assets/SM_A001.prefab' };
  assert.equal(suggestPropComposition(unknown).usage, 'unknown'); assert.equal(suggestPropComposition(unknown).member, 'either');
  binding.prop = { category: '장비', tags: [], blocksMovement: true, size: { x: 3, y: 3, z: 3 }, placement: 'floor', roomTypes: ['battle'], weight: 1,
    composition: { usage: 'equipment', family: 'authored', member: 'companion', arrangement: 'wall' } };
  assert.deepEqual(effectivePropComposition(binding), binding.prop.composition);
});
