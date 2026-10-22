import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureBindings, resolveFixtureBinding } from '../src/shared/light-bindings';
import { serializeProject, normalizeProject } from '../electron/services/projects';
import { createDemoMap, DEFAULT_SETTINGS } from '../src/shared/map';
import type { AssetBinding, MapFixture } from '../src/shared/types';

const binding = (id: string, lightAnchor?: 'wall' | 'ceiling'): AssetBinding => ({ id, role: 'light', label: id, prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0, ...(lightAnchor ? { lightAnchor } : {}) });
const light: MapFixture = { id: 'panel', role: 'light', anchor: 'wall', x: 3, row: 2, direction: 270, offset: { x: 0, y: 0, z: 0 } };

test('wall and ceiling lights use their dedicated prefabs and retain compatible explicit overrides', () => {
  const bindings = [binding('generic'), binding('fluorescent', 'ceiling'), binding('wall-panel', 'wall')];
  assert.deepEqual(fixtureBindings(bindings, light).map(b => b.id), ['generic', 'wall-panel']);
  assert.equal(resolveFixtureBinding({ width: 8 }, bindings, light)?.id, 'wall-panel');
  assert.equal(resolveFixtureBinding({ width: 8 }, bindings, { ...light, anchor: 'ceiling' })?.id, 'fluorescent');
  assert.equal(resolveFixtureBinding({ width: 8 }, bindings, { ...light, bindingId: 'generic' })?.id, 'generic');
  assert.equal(resolveFixtureBinding({ width: 8 }, bindings, { ...light, bindingId: 'fluorescent' }), undefined);
  assert.equal(resolveFixtureBinding({ width: 8 }, [bindings[1]], light), undefined);
  assert.equal(resolveFixtureBinding({ width: 8 }, [bindings[0]], light)?.id, 'generic');
});


test('native save, recovery and export normalization preserve dedicated light mounts', () => {
  const project = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS }, bindings: [binding('fluorescent','ceiling'),binding('panel','wall'),binding('legacy')] };
  const saved = JSON.parse(serializeProject(project));
  assert.deepEqual(saved.bindings.map((b: AssetBinding) => b.lightAnchor), ['ceiling','wall',undefined]);
  assert.deepEqual(normalizeProject(saved).bindings, project.bindings);
});
