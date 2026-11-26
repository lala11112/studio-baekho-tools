import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { applyRoomPreset, resolveGenerationSettings, ROOM_PRESETS, setCustomRoomSize } from '../src/shared/room-presets';
import { parseGenerationSettings } from '../src/shared/features';
import { generateVariants } from '../src/shared/variants';
import type { GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';

test('room preset ranges and default purposes/counts are explicit and independent', () => {
  const original = structuredClone(DEFAULT_SETTINGS);
  for (const p of Object.values(ROOM_PRESETS)) {
    const request = applyRoomPreset(DEFAULT_SETTINGS, p.id);
    assert.equal(request.roomPreset, p.id); assert.equal(request.sizeMode, 'preset'); assert.equal(request.cellSize, 2);
    assert.equal(request.connectionCount, p.connections); assert.equal(request.designer!.preset, p.purpose);
    assert.equal(request.designer!.enemies, p.enemies > 0); assert.equal(request.designer!.rewards, p.rewards > 0);
    assert.equal(request.designer!.enemyCount, Math.max(1, p.enemies)); assert.equal(request.designer!.rewardCount, Math.max(1, p.rewards));
    assert.equal(request.designer!.merchants, p.id === 'shop'); assert.equal(request.designer!.altars, false);
    assert.equal(request.designer!.structureFill, true); assert.equal(request.designer!.pitBottomKind, 'deadzone');
    assert.deepEqual(parseGenerationSettings(request), request);
    if (['start', 'reward', 'shop'].includes(p.id)) for (const key of ['enemies', 'hazards', 'traps', 'cliffs'] as const) assert.equal(request.designer![key], false);
  }
  assert.deepEqual(DEFAULT_SETTINGS, original);
});

test('range sizes are reproducible two-cell choices resolved once before both phases', () => {
  for (const p of Object.values(ROOM_PRESETS)) {
    const sizes = new Set<string>();
    for (let seed = 0; seed < 32; seed++) {
      const request = { ...applyRoomPreset(DEFAULT_SETTINGS, p.id), seed };
      const resolved = resolveGenerationSettings(request);
      assert.deepEqual(resolved, resolveGenerationSettings(request));
      assert.deepEqual(resolved, resolveGenerationSettings(resolved));
      for (const size of [resolved.width, resolved.height]) { assert.ok(size >= p.min && size <= p.max); assert.equal((size - p.min) % 2, 0); }
      assert.equal(resolved.sizeResolved, true); assert.notEqual(resolved.levelDesign!.pattern, 'auto');
      sizes.add(`${resolved.width}x${resolved.height}`);
    }
    assert.ok(sizes.size > 2, p.id);
  }
});

test('custom sizing retains purpose and changed counts while legacy settings stay unchanged', () => {
  const preset = applyRoomPreset(DEFAULT_SETTINGS, 'shop'); preset.designer!.eventCount = 7; preset.designer!.events = true;
  const custom = setCustomRoomSize(preset, { width: 19, height: 11, cellSize: 1.5 });
  const resolved = resolveGenerationSettings({ ...custom, seed: 123 });
  assert.equal(resolved.designer!.preset, 'shop'); assert.equal(resolved.designer!.eventCount, 7);
  assert.deepEqual([resolved.width, resolved.height, resolved.cellSize], [19, 11, 1.5]); assert.equal(resolved.sizeMode, 'custom');
  assert.deepEqual(resolveGenerationSettings(DEFAULT_SETTINGS, 2), DEFAULT_SETTINGS);
});

test('candidate resolution captures separate deterministic seeds without resetting feature overrides', () => {
  const request = { ...applyRoomPreset(DEFAULT_SETTINGS, 'medium'), seed: 1234 };
  request.designer!.enemyCount = 9; request.connectionCount = 3;
  const candidates = Array.from({ length: 8 }, (_, i) => resolveGenerationSettings(request, i));
  assert.equal(new Set(candidates.map(c => c.seed)).size, 8);
  assert.ok(new Set(candidates.map(c => `${c.width}x${c.height}`)).size > 1);
  for (const c of candidates) { assert.equal(c.designer!.enemyCount, 9); assert.equal(c.connectionCount, 3); }
});

test('variants share a catalog snapshot across phases and persist resolved sizes/seeds/patterns', async () => {
  const request = { ...applyRoomPreset(DEFAULT_SETTINGS, 'start'), connectionWidth: 2, conceptMode: 'manual' as const, prompt: '안전한 시작방', seed: 12 };
  const makeMap = (s: GenerationSettings, index: number): GridMap => {
    const rows = Array.from({ length: s.height }, (_, row) => row === 0 || row === s.height - 1 ? '#'.repeat(s.width) : `#${'.'.repeat(s.width - 2)}#`);
    rows[0] = rows[0].slice(0, 3) + 'D' + rows[0].slice(4);
    if (index) rows[s.height - 2] = '##' + rows[s.height - 2].slice(2);
    return { version: 5, name: '시작방', width: s.width, height: s.height, cellSize: s.cellSize, rows, elevations: Array.from({ length: s.height }, () => Array(s.width).fill(0)), ramps: [], maxStepHeight: s.maxStepHeight, connections: [{ id: 'north', label: '북쪽', x: 3, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
  };
  const source: ProjectFile = { formatVersion: 1, map: makeMap(request, 0), settings: request, bindings: [{ id: 'floor', label: '바닥', role: 'floor', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Floor.prefab', scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }] };
  const originalBindings = structuredClone(source.bindings), requests: GenerationSettings[] = [];
  let index = -1;
  const result = await generateVariants(source, 2, { isCancelled: () => false,
    generateImage: async (s, catalog) => { index++; requests.push(structuredClone(s)); assert.deepEqual(catalog, originalBindings); source.bindings[0].label = 'Changed mid-batch'; catalog![0].label = 'Dependency changed copy'; return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='; },
    extractLayout: async (s, _image, catalog) => { assert.deepEqual(s, requests[index]); assert.deepEqual(catalog, originalBindings); return makeMap(s, index); },
  });
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready']);
  for (let i = 0; i < result.length; i++) {
    const saved = result[i].project!; assert.equal(saved.settings.width, requests[i].width); assert.equal(saved.settings.height, requests[i].height);
    assert.equal(saved.settings.seed, requests[i].seed); assert.equal(saved.settings.sizeResolved, true); assert.equal(saved.settings.levelDesign!.pattern, 'openArena');
    assert.equal(saved.settings.prompt, request.prompt); assert.deepEqual(saved.bindings, originalBindings);
  }
});
