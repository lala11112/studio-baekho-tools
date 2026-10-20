import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { insertPropInstance, propPosition } from '../src/shared/props';
import { captureRegion, pasteRegion } from '../src/shared/editing';
import { normalizeProject, serializeProject } from '../electron/services/projects';
import { conceptPrompt, imagePrompt, layoutPrompt } from '../electron/services/prompts';
import type { AssetBinding, AssetRole, GridMap, ProjectFile } from '../src/shared/types';

const settings = { ...DEFAULT_SETTINGS, width: 12, height: 12, connectionCount: 1,
  designer: { ...DEFAULT_DESIGNER, elevation: false, decorations: true, vegetation: true, decorationDensity: 3, vegetationDensity: 8 } };
function room(): GridMap {
  return { version: 5, name: 'Vegetation integration', width: 12, height: 12, cellSize: 2,
    rows: ['######D#####', ...Array(10).fill('#..........#'), '############'],
    elevations: Array.from({ length: 12 }, () => Array(12).fill(0)), ramps: [], assetOverrides: [], maxStepHeight: .4,
    connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function asset(role: AssetRole, id = role as string): AssetBinding {
  return { id, label: id, role, prefabGuid: id.charCodeAt(0).toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    ...(['decoration', 'vegetation'].includes(role) ? { prop: { category: role, tags: [], blocksMovement: false,
      size: { x: 3, y: 2, z: 4 }, placement: 'floor' as const, roomTypes: ['battle' as const], weight: 1 } } : {}) };
}
const library = () => ['floor', 'wall', 'door', 'decoration', 'vegetation'].map(role => asset(role as AssetRole));

test('separate measured decoration and vegetation retain roles, densities, bounds and native transforms through save/export', () => {
  const bindings = library();
  let map = insertPropInstance(room(), { x: 2, row: 2 }, 'decoration', settings, bindings);
  map = insertPropInstance(map, { x: 7, row: 7 }, 'vegetation', settings, bindings);
  const project: ProjectFile = { formatVersion: 1, map, settings, bindings };
  const loaded = normalizeProject(JSON.parse(serializeProject(project)));
  assert.deepEqual(loaded.map.propInstances, map.propInstances);
  assert.deepEqual(loaded.bindings, bindings);
  assert.equal(loaded.settings.designer!.decorationDensity, 3);
  assert.equal(loaded.settings.designer!.vegetationDensity, 8);
  const manifest = buildManifest(loaded.map, loaded.bindings);
  for (const role of ['decoration', 'vegetation'] as const) {
    const instance = loaded.map.propInstances!.find(p => p.role === role)!;
    assert.equal(instance.cells.length, 4, 'all cells of the enclosing rectangle stay reserved');
    const placement = manifest.placements.find(p => p.role === role)!;
    assert.deepEqual(placement.position, propPosition(map, instance, bindings.find(b => b.id === role)));
    assert.deepEqual(placement.scale, { x: 1, y: 1, z: 1 });
    assert.equal(placement.centerXZ, true);
    assert.equal(placement.fitSize, undefined, 'native shape is not replaced or box-fitted');
  }
});

test('vegetation fixtures survive v4 project parsing and export as a separate role', () => {
  const map = room(); map.version = 4;
  map.fixtures = [{ id: 'fern', role: 'vegetation', bindingId: 'vegetation', x: 3, row: 3, direction: 90, offset: { x: 0, y: 0, z: 0 } }];
  const project = parseProjectFile({ formatVersion: 1, map, settings, bindings: library() });
  const placement = buildManifest(project.map, project.bindings).placements.find(p => p.id === 'fixture-fern')!;
  assert.equal(placement.role, 'vegetation'); assert.equal(placement.rotation.y, 90); assert.equal(placement.surface, 'pivot');
});

test('legacy plant decorations are not silently reclassified or enabled as vegetation', () => {
  const plant = asset('decoration', 'plant'); plant.prop!.category = '식생';
  const map = insertPropInstance(room(), { x: 2, row: 2 }, plant.id, settings, [plant]);
  const designer = { ...settings.designer }; delete (designer as Partial<typeof designer>).vegetation;
  delete (designer as Partial<typeof designer>).decorationDensity; delete (designer as Partial<typeof designer>).vegetationDensity;
  const project = parseProjectFile({ formatVersion: 1, map, settings: { ...settings, designer }, bindings: [plant] });
  assert.equal(project.settings.designer!.vegetation, false);
  assert.equal(project.bindings[0].role, 'decoration');
  assert.equal(project.map.propInstances![0].role, 'decoration');
});

test('copy and rotation preserve vegetation role and full rectangular footprint', () => {
  const map = insertPropInstance(room(), { x: 2, row: 2 }, 'vegetation', settings, library());
  const snapshot = captureRegion(map, { x: 2, row: 2, width: 2, height: 2 });
  const pasted = pasteRegion(map, snapshot, { x: 7, row: 7 }, { rotate90: 1 });
  const copy = pasted.propInstances!.at(-1)!;
  assert.equal(copy.role, 'vegetation'); assert.equal(copy.cells.length, 4); assert.equal(copy.direction, 90);
  assert.deepEqual(copy.size, { x: 4, y: 2, z: 3 });
});

test('AI instructions keep decoration and vegetation toggles/densities independent', () => {
  for (const prompt of [imagePrompt, layoutPrompt]) {
    const text = prompt({ ...settings, designer: { ...settings.designer, decorations: false } });
    assert.match(text, /Decorations: DISABLED/);
    assert.match(text, /Vegetation \(grass, shrubs, trees\): ENABLED at 8%/);
    const decorationOnly = prompt({ ...settings, designer: { ...settings.designer, vegetation: false } });
    assert.match(decorationOnly, /Decorations: ENABLED at 3%/);
    assert.match(decorationOnly, /Vegetation \(grass, shrubs, trees\): DISABLED/);
  }
  assert.match(conceptPrompt(settings), /장식\(decorations\)과 식생\(vegetation\)은 독립/);
});
