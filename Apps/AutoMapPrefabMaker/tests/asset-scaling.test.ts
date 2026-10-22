import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAssetScale, scaleAssets } from '../src/shared/asset-scaling';
import type { AssetBinding, AssetRole } from '../src/shared/types';

const binding = (role: AssetRole): AssetBinding => ({ id: role, role, label: role, prefabGuid: '1'.repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: .5, z: 1 }, offset: { x: .1, y: .2, z: .3 }, rotationY: 90 });

test('unit tile defaults and cell fit close 2m grid gaps without changing thickness or fixtures', () => {
  assert.deepEqual(defaultAssetScale('floor', 2), { x: 2, y: 1, z: 2 });
  assert.deepEqual(defaultAssetScale('light', 2), { x: 1, y: 1, z: 1 });
  const input = [binding('floor'), binding('ceiling'), binding('stair'), binding('light')], before = structuredClone(input);
  const result = scaleAssets(input, 'tiles', { kind: 'cell', cellSize: 2 });
  for (const item of result.slice(0, 3)) { assert.deepEqual(item.scale, { x: 2, y: .5, z: 2 }); assert.deepEqual(item.offset, before[0].offset); assert.equal(item.rotationY, 90); }
  assert.deepEqual(result[3], before[3]); assert.deepEqual(input, before);
});

test('batch scale supports role filtering, absolute values and multiplication without partial mutation', () => {
  const input = [binding('wall'), binding('light')], before = structuredClone(input);
  const scaled = scaleAssets(input, 'wall', { kind: 'multiply', axes: { x: 3, y: 2 } });
  assert.deepEqual(scaled[0].scale, { x: 3, y: 1, z: 1 }); assert.deepEqual(scaled[1], input[1]);
  const reset = scaleAssets(scaled, 'all', { kind: 'set', axes: { z: 4 } });
  assert.equal(reset[0].scale.x, 3); assert.equal(reset[1].scale.z, 4);
  for (const axes of [{ x: 0 }, { y: NaN }, { z: -1 }, {}]) assert.throws(() => scaleAssets(input, 'all', { kind: 'set', axes }));
  assert.throws(() => scaleAssets([{ ...input[0], scale: { x: 9999, y: 1, z: 1 } }, input[1]], 'all', { kind: 'multiply', axes: { x: 2 } }));
  assert.deepEqual(input, before);
});
