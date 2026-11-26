import assert from 'node:assert/strict';
import test from 'node:test';
import { generationConditionIssues, parseGenerationSettings } from '../src/shared/features';
import { addMapConnection, buildManifest, connectionCells, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { applyRoomPreset, resolveGenerationSettings } from '../src/shared/room-presets';
import type { AssetBinding, GenerationSettings, GridMap, MapConnection } from '../src/shared/types';

function room(): GridMap {
  return { version: 4, name: 'Door creation', width: 8, height: 8, cellSize: 2,
    rows: ['________', '_######_', '_#....#_', '_#....#_', '_#....#_', '_#....#_', '_######_', '________'],
    elevations: Array.from({ length: 8 }, () => Array<number>(8).fill(0)), ramps: [], maxStepHeight: .4,
    connections: [], assetOverrides: [] };
}

function doorway(direction: MapConnection['direction'] = 0): MapConnection {
  const anchors = { 0: { x: 2, row: 1 }, 90: { x: 6, row: 2 }, 180: { x: 2, row: 6 }, 270: { x: 1, row: 2 } };
  return { id: `port-${direction}`, label: '연결문', ...anchors[direction], direction, width: 5.5, height: 3.75, kind: 'default' };
}

function bindings(): AssetBinding[] {
  return (['floor', 'wall', 'door'] as const).map((role, index) => ({ id: role, label: role, role,
    prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${role}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));
}

test('new generation defaults specify door dimensions while old projects keep unspecified fields', () => {
  assert.equal(DEFAULT_SETTINGS.connectionWidth, 4);
  assert.equal(DEFAULT_SETTINGS.connectionHeight, 3);
  const { connectionWidth: _width, connectionHeight: _height, ...legacy } = DEFAULT_SETTINGS;
  assert.deepEqual(parseGenerationSettings(legacy), legacy);
  const map = addMapConnection(room(), doorway());
  const restored = parseProjectFile({ formatVersion: 1, map, settings: legacy, bindings: [] });
  assert.equal(Object.hasOwn(restored.settings, 'connectionWidth'), false);
  assert.equal(Object.hasOwn(restored.settings, 'connectionHeight'), false);
  assert.deepEqual(generationConditionIssues(map, restored.settings), []);
});

test('door size settings survive save/load and room preset resolution', () => {
  const settings = { ...DEFAULT_SETTINGS, connectionWidth: 5.5, connectionHeight: 3.75 };
  const preset = applyRoomPreset(settings, 'medium');
  const resolved = resolveGenerationSettings({ ...preset, seed: 17 });
  for (const value of [parseGenerationSettings(settings), parseGenerationSettings(resolved)]) {
    assert.equal(value.connectionWidth, 5.5);
    assert.equal(value.connectionHeight, 3.75);
  }
  const saved = parseProjectFile({ formatVersion: 1, map: addMapConnection(room(), doorway()), settings, bindings: [] });
  assert.equal(saved.settings.connectionWidth, 5.5);
  assert.equal(saved.settings.connectionHeight, 3.75);
  assert.equal(saved.map.connections[0].width, 5.5);
  assert.equal(saved.map.connections[0].height, 3.75);
});

test('door dimensions reject non-finite, nonnumeric and out-of-range settings', () => {
  for (const connectionWidth of [null, '2', NaN, Infinity, -.25, 0, .249, 40.01])
    assert.throws(() => parseGenerationSettings({ ...DEFAULT_SETTINGS, connectionWidth }), /연결문 폭/);
  for (const connectionHeight of [null, '3', NaN, Infinity, -.25, 0, .249, 20.01])
    assert.throws(() => parseGenerationSettings({ ...DEFAULT_SETTINGS, connectionHeight }), /연결문 높이/);
  for (const connectionWidth of [.25, 40])
    assert.equal(parseGenerationSettings({ ...DEFAULT_SETTINGS, width: 40, connectionWidth }).connectionWidth, connectionWidth);
  for (const connectionHeight of [.25, 20])
    assert.equal(parseGenerationSettings({ ...DEFAULT_SETTINGS, connectionHeight }).connectionHeight, connectionHeight);
});

test('requested width must fit at least one orientation after dimensions are known', () => {
  assert.doesNotThrow(() => parseGenerationSettings({ ...DEFAULT_SETTINGS, width: 8, height: 16, cellSize: 1, connectionWidth: 16 }));
  assert.throws(() => parseGenerationSettings({ ...DEFAULT_SETTINGS, width: 8, height: 16, cellSize: 1, connectionWidth: 16.01 }), /맵의 가로·세로/);
  const pending: GenerationSettings = { ...DEFAULT_SETTINGS, roomPreset: 'medium', sizeMode: 'preset', width: 14, height: 14, cellSize: 1, connectionWidth: 16 };
  assert.doesNotThrow(() => parseGenerationSettings(pending));
  assert.throws(() => parseGenerationSettings({ ...pending, sizeResolved: true }), /맵의 가로·세로/);
});

test('whole-map generation enforces requested dimensions without a designer and region edits preserve doors', () => {
  const map = addMapConnection(room(), doorway());
  assert.deepEqual(generationConditionIssues(map, { ...DEFAULT_SETTINGS, connectionWidth: 5.5, connectionHeight: 3.75 }), []);
  const issues = generationConditionIssues(map, DEFAULT_SETTINGS);
  assert.equal(issues.length, 2);
  assert.ok(issues.every(issue => issue.severity === 'error' && issue.message.includes('연결문')));
  assert.deepEqual(generationConditionIssues(map, DEFAULT_SETTINGS, { x: 2, row: 2, width: 2, height: 2 }), []);
  assert.equal(generationConditionIssues(map, { ...DEFAULT_SETTINGS, connectionWidth: undefined }).length, 1);
  assert.equal(generationConditionIssues(map, { ...DEFAULT_SETTINGS, connectionHeight: undefined }).length, 1);
});

test('manual creation builds every requested door cell in all four directions and exports the dimensions', () => {
  for (const direction of [0, 90, 180, 270] as const) {
    const source = room(), original = structuredClone(source), door = doorway(direction);
    const map = addMapConnection(source, door);
    assert.deepEqual(source, original);
    assert.deepEqual(validateMap(map), []);
    const cells = connectionCells(map, map.connections[0]);
    assert.equal(cells.length, 3);
    for (const cell of cells) assert.equal(map.rows[cell.row][cell.x], 'D');
    const manifest = buildManifest(map, bindings());
    assert.equal(manifest.connections[0].width, 5.5);
    assert.equal(manifest.connections[0].height, 3.75);
    const doors = manifest.placements.filter(item => item.role === 'door');
    assert.equal(doors.length, 1);
    assert.equal(doors[0].fitWidth, 5.5);
  }
});

test('new 4 by 3 metre door defaults reserve two cells and fit one native-sized prefab in every direction', () => {
  for (const direction of [0, 90, 180, 270] as const) {
    const door = { ...doorway(direction), width: DEFAULT_SETTINGS.connectionWidth!, height: DEFAULT_SETTINGS.connectionHeight! };
    const map = addMapConnection(room(), door), catalog = bindings(), nativeDoor = catalog.find(binding => binding.role === 'door')!;
    nativeDoor.bounds = { center: { x: 0, y: 1.5, z: 0 }, size: { x: 4, y: 3, z: .2 } };
    assert.equal(connectionCells(map, door).length, 2);
    const manifest = buildManifest(map, catalog), doors = manifest.placements.filter(item => item.role === 'door');
    assert.equal(doors.length, 1);
    assert.equal(doors[0].fitWidth, 4);
    assert.deepEqual(doors[0].scale, { x: 1, y: 1, z: 1 });
    assert.equal(doors[0].rotation.y, direction);
    assert.equal(manifest.connections[0].width, 4);
    assert.equal(manifest.connections[0].height, 3);
  }
});

test('saved two metre doors and their generation settings are retained after the new default changes', () => {
  const map = addMapConnection(room(), { ...doorway(), width: 2, height: 3 });
  const saved = parseProjectFile({ formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS, connectionWidth: 2, connectionHeight: 3 }, bindings: [] });
  assert.equal(saved.settings.connectionWidth, 2);
  assert.equal(saved.settings.connectionHeight, 3);
  assert.equal(saved.map.connections[0].width, 2);
  assert.equal(saved.map.connections[0].height, 3);
});

test('failed creation preserves original map for locks, overlap, invalid size and blocked footprints', () => {
  const base = addMapConnection(room(), doorway(180));
  const variations: { map: GridMap; door: MapConnection }[] = [
    { map: { ...base, lockedCells: [{ x: 3, row: 1 }] }, door: doorway() },
    { map: base, door: { ...doorway(180), id: 'overlap' } },
    { map: base, door: { ...doorway(), id: base.connections[0].id } },
    { map: base, door: { ...doorway(), width: NaN } },
    { map: base, door: { ...doorway(), width: 40 } },
    { map: base, door: { ...doorway(), x: -1 } },
    { map: { ...base, rows: base.rows.map((row, index) => index === 1 ? '_##P###_' : row) }, door: doorway() },
    { map: { ...base, markers: [{ id: 'event', label: 'Event', kind: 'event', contentKey: '', x: 3, row: 1, direction: 0, offset: { x: 0, y: 0, z: 0 } }] }, door: doorway() },
  ];
  for (const { map, door } of variations) {
    const original = structuredClone(map);
    assert.throws(() => addMapConnection(map, door));
    assert.deepEqual(map, original);
  }
  const overLimit = { ...base, connections: Array.from({ length: 1600 }, (_, index) => ({ ...base.connections[0], id: `port-${index}` })) };
  assert.throws(() => addMapConnection(overLimit, doorway()), /1,600/);
});
