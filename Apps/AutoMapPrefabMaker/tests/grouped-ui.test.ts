import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePropField, renderPropLibraryFields } from '../src/prop-library';
import { effectivePropComposition } from '../src/shared/prop-composition';
import { applyImportedPropBounds } from '../src/shared/props';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import type { AssetBinding } from '../src/shared/types';

const consoleAsset = (): AssetBinding => ({
  id: 'console', role: 'prop', label: '제어 콘솔', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/console.prefab',
  scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
  prop: { category: '장비', tags: [], size: { x: 2, y: 1.5, z: 1 }, placement: 'floor', blocksMovement: true, weight: 1, roomTypes: ['battle'] },
});

test('composition suggestion is editable, survives measured bounds and project save, and can reset to automatic', () => {
  const original = consoleAsset(), suggested = effectivePropComposition(original);
  assert.equal(suggested.usage, 'equipment');
  assert.equal(original.prop?.composition, undefined, 'viewing suggestions does not freeze them');
  let edited = handlePropField(original, 'composition.usage', 'storage');
  edited = handlePropField(edited, 'composition.family', '  repair-supplies  ');
  edited = handlePropField(edited, 'composition.member', 'companion');
  edited = handlePropField(edited, 'composition.arrangement', 'island');
  assert.deepEqual(edited.prop?.composition, { usage: 'storage', family: 'repair-supplies', member: 'companion', arrangement: 'island' });
  assert.equal(original.prop?.composition, undefined, 'each edit remains detached for single Undo');
  const measured = applyImportedPropBounds(edited, { version: 1, assets: [{ guid: original.prefabGuid, size: { x: 3, y: 2, z: 2 } }] });
  assert.deepEqual(measured.prop?.composition, edited.prop?.composition);
  const saved = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings: [measured] })));
  assert.deepEqual(saved.bindings[0].prop?.composition, edited.prop?.composition);
  assert.equal(handlePropField(edited, 'composition.mode', 'automatic').prop?.composition, undefined);
  assert.deepEqual(effectivePropComposition(handlePropField(edited, 'composition.mode', 'automatic')), suggested);
  assert.deepEqual(handlePropField(original, 'composition.mode', 'manual').prop?.composition, suggested);
});

test('composition UI presents source, role and reset guidance and escapes user-defined families', () => {
  const automatic = renderPropLibraryFields(consoleAsset());
  assert.match(automatic, /data-prop-field="composition.mode"/);
  assert.match(automatic, /data-prop-composition-state="automatic"/);
  assert.match(automatic, /가장자리 난간/);
  assert.match(automatic, /확인 필요/);
  const edited = handlePropField(consoleAsset(), 'composition.family', 'repair & "supplies"');
  const html = renderPropLibraryFields(edited, true);
  assert.match(html, /data-prop-composition-state="manual"/);
  assert.match(html, /repair &amp; &quot;supplies&quot;/);
  assert.match(html, /data-prop-field="composition.family" disabled/);
  assert.match(html, /직접 지정을 초기화/);
  assert.throws(() => handlePropField(edited, 'composition.mode', 'unsupported'));
  assert.throws(() => handlePropField(edited, 'composition.member', 'unsupported'));
});
