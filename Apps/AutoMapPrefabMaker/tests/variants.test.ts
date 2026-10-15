import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { generateVariants, variantGeometryKey, variantSettings, type MapVariant } from '../src/shared/variants';
import type { GridMap, ProjectFile } from '../src/shared/types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function room(index = -1): GridMap {
  const rows = ['#D######', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'];
  if (index >= 0) { const x = 2 + index % 4, row = 2 + Math.floor(index / 4); rows[row] = rows[row].slice(0, x) + '#' + rows[row].slice(x + 1); }
  return { version: 4, name: '전투방', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'north', label: 'North', x: 1, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
}
function source(): ProjectFile {
  return parseProjectFile({ formatVersion: 1, map: room(), settings: { ...DEFAULT_SETTINGS, prompt: '넓은 전투방을 만들어 주세요.', width: 8, height: 8, connectionCount: 1 },
    bindings: [{ id: 'floor', role: 'floor', label: '바닥', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Floor.prefab', scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }] });
}

test('batch calls are sequential, publish independent progress, and produce editable isolated projects', async () => {
  const original = source(), before = structuredClone(original), events: string[] = [], updates: MapVariant[][] = [], prompts: string[] = [];
  let active = 0, index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    onUpdate: variants => { updates.push(structuredClone(variants)); variants[0].label = 'consumer mutation'; if (variants[0].project) variants[0].project.map.rows[0] = '________'; },
    generateImage: async settings => { assert.equal(active++, 0); index++; events.push(`image${index}`); prompts.push(settings.prompt); settings.prompt = 'dependency mutation'; await Promise.resolve(); active--; return PNG; },
    extractLayout: async settings => { assert.equal(active++, 0); assert.equal(settings.prompt, prompts[index]); events.push(`extract${index}`); await Promise.resolve(); active--; return room(index); },
  });
  assert.deepEqual(events, ['image0', 'extract0', 'image1', 'extract1', 'image2', 'extract2']);
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(updates[0].map(v => v.status), ['waiting', 'waiting', 'waiting']);
  assert.deepEqual(updates.map(v => v[0].status).slice(0, 4), ['waiting', 'image', 'extract', 'ready']);
  assert.equal(new Set(prompts).size, 3); assert.equal(new Set(result.map(v => v.id)).size, 3);
  for (const candidate of result) {
    assert.equal(candidate.index, result.indexOf(candidate)); assert.match(candidate.label, /번 · /);
    assert.ok(candidate.project!.map.name.startsWith(`${candidate.index + 1}번 후보 - `));
    assert.deepEqual(candidate.project!.settings, before.settings); assert.deepEqual(candidate.project!.bindings, before.bindings);
    assert.equal(candidate.project!.blueprintDataUrl, PNG); assert.equal(candidate.project!.generationDraft, undefined);
  }
  result[0].project!.settings.prompt = 'changed'; result[0].project!.bindings[0].scale.x = 99; result[0].project!.map.elevations[1][1] = 40;
  assert.deepEqual(result[1].project!.settings, before.settings); assert.deepEqual(result[1].project!.bindings, before.bindings);
  assert.deepEqual(original, before); assert.equal(updates[0][0].status, 'waiting');
});

test('settings and bindings are captured before the first async call', async () => {
  const original = source(), before = structuredClone(original); let index = -1;
  const result = await generateVariants(original, 2, { isCancelled: () => false,
    generateImage: async settings => { index++; original.settings.prompt = 'external edit during generation'; original.bindings[0].scale.x = 17; assert.ok(settings.prompt.startsWith(before.settings.prompt)); return PNG; },
    extractLayout: async settings => { assert.ok(settings.prompt.startsWith(before.settings.prompt)); return room(index); },
  });
  for (const candidate of result) { assert.deepEqual(candidate.project!.settings, before.settings); assert.deepEqual(candidate.project!.bindings, before.bindings); }
});

test('all variations preserve constraints and reject oversized prompts/counts before any call or progress', async () => {
  const original = source(); original.settings.designer = { ...DEFAULT_DESIGNER, bridges: true, cliffs: true, bridgeCount: 2, cliffCount: 2 };
  const before = structuredClone(original.settings);
  const requests = Array.from({ length: 8 }, (_, index) => variantSettings(original.settings, index, 8));
  assert.equal(new Set(requests.map(r => r.prompt)).size, 8);
  for (const request of requests) {
    assert.ok(request.prompt.startsWith(before.prompt)); assert.match(request.prompt, /original brief and explicit generation settings take priority/);
    assert.match(request.prompt, /Never create corridors/); assert.deepEqual({ ...request, prompt: before.prompt }, before);
  }
  assert.deepEqual(original.settings, before);
  let calls = 0;
  const deps = { isCancelled: () => false, onUpdate: () => calls++, generateImage: async () => { calls++; return PNG; }, extractLayout: async () => { calls++; return room(); } };
  for (const count of [0, 1, 9, 2.5, NaN]) await assert.rejects(generateVariants(source(), count, deps), /2~8/);
  const long = source(); long.settings.prompt = '가'.repeat(5900);
  await assert.rejects(generateVariants(long, 8, deps), /6,000/); assert.equal(calls, 0); assert.equal(long.settings.prompt.length, 5900);
  assert.throws(() => variantSettings(before, -1, 2), /후보 번호/); assert.throws(() => variantSettings(before, 2, 2), /후보 번호/);
});

test('one failed candidate does not stop later calls and failures are not silently retried', async () => {
  let index = -1; const calls: string[] = [];
  const result = await generateVariants(source(), 4, { isCancelled: () => false,
    generateImage: async () => { index++; calls.push(`image${index}`); if (index === 0) throw new Error('image unavailable'); return PNG; },
    extractLayout: async () => { calls.push(`extract${index}`); if (index === 1) throw new Error('extraction failed'); return index === 2 ? { ...room(index), rows: [] } : room(index); },
  });
  assert.deepEqual(result.map(v => v.status), ['error', 'error', 'error', 'ready']);
  assert.equal(result[0].error, 'image unavailable'); assert.equal(result[1].error, 'extraction failed');
  assert.equal(result.slice(0, 3).some(v => v.project !== undefined), false);
  assert.deepEqual(calls, ['image0', 'image1', 'extract1', 'image2', 'extract2', 'image3', 'extract3']);
});

test('duplicate terrain ignores names, IDs, decoration and ordering but keeps structural differences', async () => {
  const a = room(0), b = structuredClone(a); b.name = '다른 이름'; b.connections[0].id = 'another'; b.connections[0].label = 'South?'; b.connections[0].kind = 'custom';
  b.fixtures = [{ id: 'lamp', role: 'light', x: 4, row: 4, direction: 0, offset: { x: 0, y: 1, z: 0 } }];
  b.markers = [{ id: 'reward', label: '보상', kind: 'reward', contentKey: 'chest', x: 3, row: 4, direction: 90, offset: { x: 0, y: 0, z: 0 } }];
  assert.equal(variantGeometryKey(a), variantGeometryKey(b)); assert.notEqual(variantGeometryKey(a), variantGeometryKey(room(1)));
  const withLayers = { ...a, ceilings: [{ x: 4, row: 4, undersideY: 4 }, { x: 5, row: 4, undersideY: 4 }], bridges: [{ x: 2, row: 2, direction: 0 as const }] };
  assert.equal(variantGeometryKey(withLayers), variantGeometryKey({ ...withLayers, ceilings: [...withLayers.ceilings].reverse(), bridges: [{ x: 2, row: 2, direction: 180 }] }));
  let index = -1;
  const result = await generateVariants(source(), 3, { isCancelled: () => false, generateImage: async () => { index++; return PNG; }, extractLayout: async () => [a, b, room(1)][index] });
  assert.deepEqual(result.map(v => v.status), ['ready', 'error', 'ready']); assert.match(result[1].error!, /중복 후보/);
  assert.equal(a.name, '전투방'); assert.equal(b.name, '다른 이름');
});

test('cancellation before calls and between phases stops new work while preserving ready candidates', async () => {
  let cancelled = true, calls = 0;
  const before = await generateVariants(source(), 2, { isCancelled: () => cancelled, generateImage: async () => { calls++; return PNG; }, extractLayout: async () => { calls++; return room(); } });
  assert.equal(calls, 0); assert.deepEqual(before.map(v => v.status), ['cancelled', 'cancelled']);
  cancelled = false; let index = -1; const events: string[] = [];
  const result = await generateVariants(source(), 4, { isCancelled: () => cancelled,
    generateImage: async () => { index++; events.push(`image${index}`); if (index === 1) cancelled = true; return PNG; },
    extractLayout: async () => { events.push(`extract${index}`); return room(index); },
  });
  assert.deepEqual(result.map(v => v.status), ['ready', 'cancelled', 'cancelled', 'cancelled']);
  assert.ok(result[0].project); assert.deepEqual(events, ['image0', 'extract0', 'image1']);
});

test('cancellation during extraction or its failure does not publish a ready/error candidate', async () => {
  for (const fail of [false, true]) {
    let cancelled = false, calls = 0;
    const result = await generateVariants(source(), 2, { isCancelled: () => cancelled,
      generateImage: async () => { calls++; return PNG; },
      extractLayout: async () => { calls++; cancelled = true; if (fail) throw new Error('stopped'); return room(); },
    });
    assert.equal(calls, 2); assert.deepEqual(result.map(v => v.status), ['cancelled', 'cancelled']); assert.equal(result.some(v => v.project || v.error), false);
  }
});

test('candidate validation checks request dimensions, connection counts, feature conditions and image data', async () => {
  const cases = [
    { mutate: (m: GridMap) => { m.cellSize = 3; }, image: PNG, pattern: /셀 간격/ },
    { mutate: (m: GridMap) => { m.maxStepHeight = .5; }, image: PNG, pattern: /이동 단차/ },
    { mutate: (m: GridMap) => { m.connections[0].width = 1; }, image: 'not-an-image', pattern: /PNG/ },
  ];
  for (const scenario of cases) {
    let index = -1;
    const result = await generateVariants(source(), 2, { isCancelled: () => false, generateImage: async () => { index++; return scenario.image; }, extractLayout: async () => { const m = room(index); scenario.mutate(m); return m; } });
    assert.ok(result.every(v => v.status === 'error')); assert.match(result[0].error!, scenario.pattern);
  }
  const noProps = source(); noProps.settings.designer = { ...DEFAULT_DESIGNER, elevation: false, props: false };
  let index = -1;
  const result = await generateVariants(noProps, 2, { isCancelled: () => false, generateImage: async () => { index++; return PNG; }, extractLayout: async () => { const m = room(index); m.rows[5] = '#..P...#'; return m; } });
  assert.ok(result.every(v => v.status === 'error')); assert.match(result[0].error!, /장애물 끄기/);
  const twoDoors = source(); twoDoors.settings.connectionCount = 2;
  const doors = await generateVariants(twoDoors, 2, { isCancelled: () => false, generateImage: async () => PNG, extractLayout: async () => room() });
  assert.ok(doors.every(v => v.status === 'error')); assert.match(doors[0].error!, /연결문 수/);
});

test('extracted local layers are preserved without a second feature-generation pass', async () => {
  const original = source(); original.settings.designer = { ...DEFAULT_DESIGNER, elevation: false, props: false, ceilings: true, lights: true };
  let index = -1;
  const result = await generateVariants(original, 2, { isCancelled: () => false, generateImage: async () => { index++; return PNG; },
    extractLayout: async settings => { const m = applyGeneratedFeatures(room(index), settings); m.fixtures![0].offset.y = -.31; m.fixtures![0].id = `extracted-light-${index}`; return m; },
  });
  assert.ok(result.every(v => v.status === 'ready'));
  for (const candidate of result) { assert.equal(candidate.project!.map.fixtures![0].offset.y, -.31); assert.equal(candidate.project!.map.fixtures![0].id, `extracted-light-${candidate.index}`); }
});
