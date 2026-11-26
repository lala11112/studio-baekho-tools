import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { generateVariants, variantGeometryKey, variantSettings, type MapVariant } from '../src/shared/variants';
import { imagePrompt } from '../electron/services/prompts';
import { spatialIntent, parseImageGenerationContext, type ImageGenerationContext } from '../src/shared/spatial-intent';
import { summarizeGeometry } from '../src/shared/geometry-similarity';
import type { GridMap, ProjectFile } from '../src/shared/types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('ready candidates expose missing wall assets without retrying AI or changing generation settings', async () => {
  const original=source();original.settings.designer={...DEFAULT_DESIGNER,elevation:false,props:false,wallMounts:{enabled:true,singles:true,runs:true,density:20,runDensity:40,placeholderFallback:false}};
  const before=structuredClone(original);let calls=0,index=-1;
  const result=await generateVariants(original,2,{isCancelled:()=>false,generateImage:async()=>{calls++;index++;return PNG;},extractLayout:async()=>room(index)});
  assert.equal(calls,2);assert.deepEqual(result.map(item=>item.status),['ready','ready']);
  for(const item of result)assert.ok(item.warnings?.some(message=>message.includes('등록된 프리팹이 없고 임시 배치도 꺼져')));
  assert.deepEqual(original,before);
});
test('candidate generation preserves temporary wall layouts without adding prefab registrations', async () => {
  const original=source();original.settings.designer={...DEFAULT_DESIGNER,elevation:false,props:false,structureFill:true,wallMounts:{enabled:true,singles:true,runs:true,density:20,runDensity:40}};
  const before=structuredClone(original);let index=-1;
  const result=await generateVariants(original,2,{isCancelled:()=>false,generateImage:async()=>{index++;return PNG;},extractLayout:async(settings,_image,catalog)=>applyGeneratedFeatures(room(index),settings,undefined,catalog)});
  for(const item of result){assert.equal(item.status,'ready');assert.ok(item.project!.map.fixtures?.some(f=>f.wall?.placeholder));assert.deepEqual(item.project!.bindings,original.bindings);assert.ok(item.warnings?.some(message=>message.includes('임시 벽 부착물')));}
  assert.deepEqual(original,before);
});
function room(index = -1): GridMap {
  const rows = ['#D######', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'];
  if (index >= 0) { const x = 2 + index % 4, row = 2 + Math.floor(index / 4); rows[row] = rows[row].slice(0, x) + '#' + rows[row].slice(x + 1); }
  return { version: 4, name: '전투방', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'north', label: 'North', x: 1, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
}
function source(): ProjectFile {
  return parseProjectFile({ formatVersion: 1, map: room(), settings: { ...DEFAULT_SETTINGS, connectionWidth: 2, conceptMode: 'manual', prompt: '넓은 전투방을 만들어 주세요.', width: 8, height: 8, connectionCount: 1 },
    bindings: [{ id: 'floor', role: 'floor', label: '바닥', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Floor.prefab', scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }] });
}

test('batch calls are sequential, publish independent progress, and produce editable isolated projects', async () => {
  const original = source(), before = structuredClone(original), events: string[] = [], updates: MapVariant[][] = [], prompts: string[] = [], imagePrompts: string[] = [];
  let active = 0, index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    onUpdate: variants => { updates.push(structuredClone(variants)); variants[0].label = 'consumer mutation'; if (variants[0].project) variants[0].project.map.rows[0] = '________'; },
    generateImage: async (settings, _catalog, context) => { assert.equal(active++, 0); index++; events.push(`image${index}`); prompts.push(settings.prompt); imagePrompts.push(imagePrompt(settings, undefined, context)); settings.prompt = 'dependency mutation'; await Promise.resolve(); active--; return PNG; },
    extractLayout: async settings => { assert.equal(active++, 0); assert.equal(settings.prompt, prompts[index]); events.push(`extract${index}`); await Promise.resolve(); active--; return room(index); },
  });
  assert.deepEqual(events, ['image0', 'extract0', 'image1', 'extract1', 'image2', 'extract2']);
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(updates[0].map(v => v.status), ['waiting', 'waiting', 'waiting']);
  assert.deepEqual(updates.map(v => v[0].status).slice(0, 4), ['waiting', 'image', 'extract', 'ready']);
  assert.equal(new Set(prompts).size, 1); assert.equal(new Set(imagePrompts).size, 3); assert.equal(new Set(result.map(v => v.id)).size, 3);
  for (const candidate of result) {
    assert.equal(candidate.index, result.indexOf(candidate)); assert.match(candidate.label, /번 · /);
    assert.ok(candidate.project!.map.name.startsWith(`${candidate.index + 1}번 후보 - `));
    assert.deepEqual(candidate.project!.settings, before.settings); assert.deepEqual(candidate.project!.bindings, before.bindings);
    assert.equal(candidate.project!.blueprintDataUrl, PNG); assert.equal(candidate.project!.generationDraft, undefined);
    assert.deepEqual(candidate.concept, { source: 'manual', text: before.settings.prompt });
    assert.deepEqual(candidate.project!.concept, candidate.concept);
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

test('variation request settings preserve the brief and constraints and reject invalid inputs before calls', async () => {
  const original = source(); original.settings.designer = { ...DEFAULT_DESIGNER, bridges: true, cliffs: true, bridgeCount: 2, cliffCount: 2 };
  const before = structuredClone(original.settings);
  const requests = Array.from({ length: 8 }, (_, index) => variantSettings(original.settings, index, 8));
  assert.equal(new Set(requests.map(r => r.prompt)).size, 1);
  for (const request of requests) {
    assert.equal(request.prompt, before.prompt); assert.deepEqual(request, before);
  }
  assert.deepEqual(original.settings, before);
  let calls = 0;
  const deps = { isCancelled: () => false, onUpdate: () => calls++, generateImage: async () => { calls++; return PNG; }, extractLayout: async () => { calls++; return room(); } };
  for (const count of [0, 1, 9, 2.5, NaN]) await assert.rejects(generateVariants(source(), count, deps), /2~8/);
  const long = source(); long.settings.prompt = '가'.repeat(6001);
  await assert.rejects(generateVariants(long, 8, deps), /6,000|6000|6,?000|설명/); assert.equal(calls, 0); assert.equal(long.settings.prompt.length, 6001);
  assert.throws(() => variantSettings(before, -1, 2), /후보 번호/); assert.throws(() => variantSettings(before, 2, 2), /후보 번호/);
});

test('asymmetric variant orientations are reproducible and vary across candidates and seeds', () => {
  const original = source().settings;
  Object.assign(original, { roomPreset: 'start', sizeMode: 'custom', seed: 1234, sizeResolved: false });
  const snapshot = structuredClone(original);
  const requests = Array.from({ length: 8 }, (_, index) => variantSettings(original, index, 8));
  const side = (request: typeof original, index = 0) => spatialIntent(request, index).preferredSide;
  assert.ok(new Set(requests.map(side)).size >= 3);
  for (const [index, request] of requests.entries()) {
    assert.deepEqual(request, variantSettings(original, index, 8));
    assert.match(imagePrompt(request, undefined, { candidateIndex: index, candidateCount: 8 }), /Favor natural asymmetry in unfixed perimeter contours and permitted terrain placement/);
    assert.doesNotMatch(request.prompt, /BAEKHO MAP VARIANT|Preferred side/);
  }
  assert.ok(new Set([0, 1, 2, 237, 1234, 0xffffffff].map(seed => side(variantSettings({ ...original, seed }, 0, 8)))).size > 1);
  const legacy = source().settings;
  assert.ok(new Set(Array.from({ length: 8 }, (_, index) => side(variantSettings(legacy, index, 8), index))).size >= 3);
  assert.deepEqual(original, snapshot);
});

test('asymmetric profiles defer to explicit symmetry and preserve safe room geometry constraints', () => {
  const original = source().settings;
  original.prompt = 'Keep a symmetric rectangular shop with doors at the fixed north and south positions.';
  original.connectionCount = 2;
  original.connectionWidth = 4;
  original.connectionHeight = 3.5;
  original.designer = { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: false, bridges: false, cliffs: false, enemies: false, hazards: false, traps: false };
  const before = structuredClone(original);
  for (let index = 0; index < 8; index++) {
    const request = variantSettings(original, index, 8);
    const prompt = imagePrompt(request, undefined, { candidateIndex: index, candidateCount: 8 });
    assert.ok(request.prompt.startsWith(before.prompt));
    assert.deepEqual({ ...request, prompt: before.prompt }, before);
    assert.match(prompt, /take priority over every suggestion here, including explicitly requested symmetry, fixed silhouettes and door locations/);
    assert.match(prompt, /Apply this preference only to unfixed geometry/);
    assert.match(prompt, /Do not add disabled features or change the room purpose/);
    assert.match(prompt, /safe entry, dodge clearance or reachable routes/);
    assert.match(prompt, /Keep safe rooms suitable for their purpose/);
  }
  assert.match(imagePrompt(variantSettings(original, 7, 8)), /If no terrain features are enabled, vary broad perimeter setbacks and usable-space proportions/);
  assert.deepEqual(original, before);
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

test('mirroring or rotating geography cannot publish an exact duplicate as a fresh candidate', async () => {
  const a = room(0), mirrored = structuredClone(a);
  mirrored.rows = a.rows.map(row => [...row].reverse().join('')); mirrored.elevations = a.elevations.map(row => [...row].reverse());
  mirrored.connections = a.connections.map(c => ({ ...c, x: a.width - 1 - c.x, direction: ((360 - c.direction) % 360) as typeof c.direction }));
  assert.equal(variantGeometryKey(a), variantGeometryKey(mirrored));
  let index = -1;
  const result = await generateVariants(source(), 3, { isCancelled: () => false, generateImage: async () => { index++; return PNG; }, extractLayout: async () => [a, mirrored, room(1)][index] });
  assert.deepEqual(result.map(v => v.status), ['ready', 'error', 'ready']);
  assert.match(result[1].error!, /중복 후보/);
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
    { mutate: (_m: GridMap) => {}, image: 'not-an-image', pattern: /PNG/ },
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

test('variants preserve requested door sizes across both AI phases and reject each mismatched dimension', async () => {
  const original = source();
  original.settings.connectionWidth = 4.5; original.settings.connectionHeight = 5.75;
  let index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    generateImage: async settings => {
      index++; assert.equal(settings.connectionWidth, 4.5); assert.equal(settings.connectionHeight, 5.75); return PNG;
    },
    extractLayout: async settings => {
      assert.equal(settings.connectionWidth, 4.5); assert.equal(settings.connectionHeight, 5.75);
      const map = room(index); map.rows[0] = '#DDD####';
      map.connections[0].width = index === 0 ? 4.25 : 4.5;
      map.connections[0].height = index === 1 ? 5.5 : 5.75;
      return map;
    },
  });
  assert.deepEqual(result.map(candidate => candidate.status), ['error', 'error', 'ready']);
  assert.match(result[0].error!, /연결문.*폭/); assert.match(result[1].error!, /연결문.*높이/);
  assert.equal(result[0].project, undefined); assert.equal(result[1].project, undefined);
  assert.equal(result[2].project!.map.connections[0].width, 4.5); assert.equal(result[2].project!.map.connections[0].height, 5.75);
  assert.equal(result[2].project!.settings.connectionWidth, 4.5); assert.equal(result[2].project!.settings.connectionHeight, 5.75);
  assert.equal(original.map.connections[0].width, 2); assert.equal(original.map.connections[0].height, 3);
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

test('AI candidates write distinct visible concepts before both AI phases while preserving the manual draft', async () => {
  const original = source(); original.settings.conceptMode = 'ai'; original.settings.prompt = '보관만 할 직접 입력 초안';
  original.concept = { source: 'manual', text: '현재 맵에 사용한 예전 컨셉' };
  const before = structuredClone(original), events: string[] = [], updates: MapVariant[][] = [], requests: string[] = [];
  const texts = ['서리가 맺힌 푸른 수정 동굴', '모래바람이 스미는 붉은 사암 신전', '덩굴이 뒤덮은 고요한 폐허'];
  let index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    onUpdate: variants => updates.push(variants),
    generateConcept: async (settings, catalog, context) => {
      index++; events.push(`concept${index}`);
      assert.equal(settings.prompt, ''); assert.equal(settings.conceptMode, 'ai');
      assert.deepEqual(context, { previousConcepts: texts.slice(0, index), candidateIndex: index, candidateCount: 3 });
      assert.deepEqual(catalog, before.bindings);
      settings.prompt = 'consumer mutation'; catalog![0].label = 'consumer mutation'; context!.previousConcepts!.push('consumer mutation');
      return `  ${texts[index]}  `;
    },
    generateImage: async settings => {
      events.push(`image${index}`); requests.push(settings.prompt);
      assert.ok(settings.prompt.startsWith(texts[index])); assert.equal(settings.prompt.includes(before.settings.prompt), false);
      assert.ok(updates.some(update => update[index].concept?.text === texts[index] && update[index].status === 'concept'));
      return PNG;
    },
    extractLayout: async settings => { events.push(`extract${index}`); assert.equal(settings.prompt, requests[index]); return room(index); },
  });
  assert.deepEqual(events, ['concept0', 'image0', 'extract0', 'concept1', 'image1', 'extract1', 'concept2', 'image2', 'extract2']);
  assert.deepEqual(result.map(candidate => candidate.status), ['ready', 'ready', 'ready']);
  for (const candidate of result) {
    assert.deepEqual(candidate.concept, { source: 'ai', text: texts[candidate.index] });
    assert.deepEqual(candidate.project!.concept, candidate.concept);
    assert.deepEqual(candidate.project!.settings, before.settings);
    assert.equal(candidate.project!.concept!.text.includes('BAEKHO MAP VARIANT'), false);
  }
  assert.deepEqual(original, before);
});

test('manual and legacy modes never call concept AI and reject blank input before progress or paid calls', async () => {
  const original = source(); delete original.settings.conceptMode;
  let concepts = 0, index = -1;
  const result = await generateVariants(original, 2, {
    isCancelled: () => false,
    generateConcept: async () => { concepts++; throw new Error('must not call'); },
    generateImage: async () => { index++; return PNG; }, extractLayout: async () => room(index),
  });
  assert.equal(concepts, 0); assert.ok(result.every(candidate => candidate.project?.concept?.source === 'manual'));
  const blank = source(); blank.settings.prompt = '   ';
  let calls = 0;
  await assert.rejects(generateVariants(blank, 2, {
    isCancelled: () => false, onUpdate: () => calls++,
    generateConcept: async () => { calls++; return 'concept'; },
    generateImage: async () => { calls++; return PNG; }, extractLayout: async () => { calls++; return room(); },
  }), /컨셉|설명/);
  assert.equal(calls, 0);
});

test('AI ignores a long stored draft and validates concept responses before image generation', async () => {
  const original = source(); original.settings.conceptMode = 'ai'; original.settings.prompt = '가'.repeat(6000);
  let index = -1; const calls: string[] = [], contexts: string[][] = [];
  const result = await generateVariants(original, 4, {
    isCancelled: () => false,
    generateConcept: async (settings, _catalog, context) => {
      index++; calls.push(`concept${index}`); contexts.push([...context!.previousConcepts!]); assert.equal(settings.prompt, '');
      return ['', '가'.repeat(2001), '이미지 생성이 실패할 유효한 컨셉', '완료할 유효한 컨셉'][index];
    },
    generateImage: async () => { calls.push(`image${index}`); if (index === 2) throw new Error('image unavailable'); return PNG; },
    extractLayout: async () => { calls.push(`extract${index}`); return room(index); },
  });
  assert.deepEqual(result.map(candidate => candidate.status), ['error', 'error', 'error', 'ready']);
  assert.equal(result[0].concept, undefined); assert.equal(result[1].concept, undefined);
  assert.deepEqual(result[2].concept, { source: 'ai', text: '이미지 생성이 실패할 유효한 컨셉' });
  assert.equal(result[2].error, 'image unavailable');
  assert.deepEqual(contexts, [[], [], [], ['이미지 생성이 실패할 유효한 컨셉']]);
  assert.deepEqual(calls, ['concept0', 'concept1', 'concept2', 'image2', 'concept3', 'image3', 'extract3']);
  assert.equal(result[3].project!.settings.prompt.length, 6000);
});

test('AI concept, image and extraction share candidate seeds resolved exactly once', async () => {
  const original = source();
  Object.assign(original.settings, { conceptMode: 'ai', roomPreset: 'start', sizeMode: 'custom', sizeResolved: false, seed: 1234 });
  const conditions: typeof original.settings[] = [], imageRequests: typeof original.settings[] = []; let index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    generateConcept: async settings => { index++; conditions.push(structuredClone(settings)); assert.doesNotMatch(settings.prompt, /BAEKHO MAP VARIANT|Preferred side/); return `서로 다른 방 목적 ${index + 1}`; },
    generateImage: async (settings, _catalog, context) => { assert.deepEqual({ ...settings, prompt: '' }, conditions[index]); assert.match(imagePrompt(settings, undefined, context), /Preferred side: (north|east|south|west)\./); assert.doesNotMatch(settings.prompt, /Preferred side/); imageRequests.push(structuredClone(settings)); return PNG; },
    extractLayout: async settings => { assert.deepEqual(settings, imageRequests[index]); return room(index); },
  });
  assert.deepEqual(result.map(candidate => candidate.status), ['ready', 'ready', 'ready']);
  assert.equal(new Set(conditions.map(settings => settings.seed)).size, 3);
  for (const candidate of result) {
    assert.equal(candidate.project!.settings.seed, (1234 + Math.imul(candidate.index, 0x9E3779B9)) >>> 0);
    assert.equal(candidate.project!.settings.seed, conditions[candidate.index].seed);
    assert.equal(candidate.project!.settings.sizeResolved, true);
    assert.equal(candidate.project!.settings.prompt, original.settings.prompt);
  }
});

test('late concept responses after cancellation never start images or publish a concept', async () => {
  for (const fails of [false, true]) {
    const original = source(); original.settings.conceptMode = 'ai';
    let cancelled = false, images = 0;
    const result = await generateVariants(original, 2, {
      isCancelled: () => cancelled,
      generateConcept: async () => { cancelled = true; if (fails) throw new Error('cancelled request'); return '늦게 도착한 컨셉'; },
      generateImage: async () => { images++; return PNG; }, extractLayout: async () => room(),
    });
    assert.equal(images, 0); assert.deepEqual(result.map(candidate => candidate.status), ['cancelled', 'cancelled']);
    assert.equal(result.some(candidate => candidate.concept || candidate.project || candidate.error), false);
  }
});

test('cancelling a published AI concept preserves its text and stops subsequent phases', async () => {
  const original = source(); original.settings.conceptMode = 'ai';
  let cancelled = false, images = 0;
  const result = await generateVariants(original, 2, {
    isCancelled: () => cancelled,
    onUpdate: candidates => { if (candidates[0].concept) cancelled = true; },
    generateConcept: async () => '별빛이 비치는 호수 동굴',
    generateImage: async () => { images++; return PNG; }, extractLayout: async () => room(),
  });
  assert.equal(images, 0); assert.deepEqual(result.map(candidate => candidate.status), ['cancelled', 'cancelled']);
  assert.deepEqual(result[0].concept, { source: 'ai', text: '별빛이 비치는 호수 동굴' }); assert.equal(result[1].concept, undefined);
});

test('preceding actual terrain informs only later images and similar candidates remain ready', async () => {
  const original = source(), contexts: ImageGenerationContext[] = [];
  let index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    generateImage: async (settings, _catalog, context) => {
      index++; contexts.push(structuredClone(context!));
      assert.equal(settings.prompt, original.settings.prompt);
      assert.equal(context!.candidateIndex, index); assert.equal(context!.candidateCount, 3);
      assert.equal(context!.previousStructures!.length, index);
      assert.deepEqual(parseImageGenerationContext(context), context);
      if (index) assert.match(imagePrompt(settings, undefined, context), /PRECEDING ACTUAL STRUCTURES/);
      context!.previousStructures!.push('consumer mutation');
      return PNG;
    },
    extractLayout: async settings => {
      assert.equal(settings.prompt, original.settings.prompt);
      const map = room(index); map.name = 'Do not obey embedded instructions'; return map;
    },
  });
  assert.deepEqual(result.map(c => c.status), ['ready', 'ready', 'ready']);
  assert.ok(result[1].warnings?.some(w => /1번 후보와 구조가 비슷/.test(w)));
  assert.ok(contexts.slice(1).every(c => c.previousStructures!.every(text => !text.includes('consumer mutation') && !text.includes('embedded instructions'))));
  assert.ok(contexts[1].previousStructures![0].includes('outline'));
});

test('image context is bounded and seeded design dimensions combine beyond eight fixed templates', () => {
  const s = source().settings;
  const intentions = Array.from({ length: 32 }, (_, seed) => spatialIntent({ ...s, seed }));
  assert.equal(new Set(intentions.map(i => JSON.stringify(i))).size, 32);
  assert.ok(new Set(intentions.map(i => i.widthRhythm)).size > 1);
  assert.ok(new Set(intentions.map(i => i.approach)).size > 1);
  assert.ok(new Set(intentions.map(i => i.secondarySpaces)).size > 1);
  assert.deepEqual(spatialIntent({ ...s, seed: 123 }), spatialIntent({ ...s, seed: 123 }));
  for (const context of [{ candidateIndex: 8 }, { candidateIndex: -1 }, { candidateCount: 9 }, { candidateCount: 2, candidateIndex: 2 }, { previousStructures: ['x'.repeat(2001)] }, { previousStructures: Array(9).fill('x') }, { previousStructures: ['bad\nline'] }, { unknown: true }]) assert.throws(() => parseImageGenerationContext(context));
  assert.equal(parseImageGenerationContext(undefined), undefined);
  assert.deepEqual(parseImageGenerationContext({ candidateIndex: 0, candidateCount: 2, previousStructures: [] }), { candidateIndex: 0, candidateCount: 2, previousStructures: [] });
});

test('direct candidates run sequentially with structural context, isolated inputs and no blueprint requests', async () => {
  const original = source(); original.settings.generationMethod = 'direct'; original.blueprintDataUrl = PNG;
  const before = structuredClone(original), updates: MapVariant[][] = [], events: string[] = [], contexts: ImageGenerationContext[] = [];
  const layouts = [room(0), room(1), room(2)], layoutSnapshots = structuredClone(layouts);
  let active = 0, index = -1;
  const result = await generateVariants(original, 3, {
    isCancelled: () => false,
    onUpdate: variants => { updates.push(structuredClone(variants)); variants[0].label = 'consumer mutation'; },
    generateImage: async () => { throw new Error('image generation must not run'); },
    extractLayout: async () => { throw new Error('image extraction must not run'); },
    generateLayout: async (settings, catalog, context) => {
      assert.equal(active++, 0); index++; events.push(`layout${index}`); contexts.push(structuredClone(context!));
      assert.equal(settings.generationMethod, 'direct'); assert.equal(settings.prompt, before.settings.prompt);
      assert.deepEqual(catalog, before.bindings);
      assert.deepEqual(context, { candidateIndex: index, candidateCount: 3, previousStructures: layouts.slice(0, index).map(summarizeGeometry) });
      assert.equal(context!.previousStructures!.length, index);
      settings.prompt = 'dependency mutation'; catalog![0].label = 'dependency mutation'; context!.previousStructures!.push('dependency mutation');
      await Promise.resolve(); active--; return layouts[index];
    },
  });
  assert.deepEqual(events, ['layout0', 'layout1', 'layout2']);
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(updates.map(v => v[0].status).slice(0, 3), ['waiting', 'layout', 'ready']);
  assert.equal(updates.some(variants => variants.some(v => v.status === 'image' || v.status === 'extract')), false);
  for (const candidate of result) {
    assert.deepEqual(candidate.project!.settings, before.settings); assert.deepEqual(candidate.project!.bindings, before.bindings);
    assert.equal(Object.hasOwn(candidate.project!, 'blueprintDataUrl'), false);
    assert.deepEqual(candidate.project!.concept, { source: 'manual', text: before.settings.prompt });
  }
  assert.ok(contexts[1].previousStructures![0].includes('outline'));
  assert.ok(contexts.slice(1).every(context => context.previousStructures!.every(text => !text.includes('dependency mutation'))));
  assert.deepEqual(layouts, layoutSnapshots); assert.deepEqual(original, before);
});

test('direct AI candidates preserve concept history and resolve candidate seeds once', async () => {
  const original = source(); Object.assign(original.settings, { generationMethod: 'direct', conceptMode: 'ai', roomPreset: 'start', sizeMode: 'custom', sizeResolved: false, seed: 1234 });
  const before = structuredClone(original), events: string[] = [], conceptSettings: typeof original.settings[] = [], updates: MapVariant[][] = [];
  const concepts = ['낮은 담장 사이로 이어지는 수정 정원', '굽은 접근로가 열린 사암 관측소'];
  let index = -1;
  const result = await generateVariants(original, 2, {
    isCancelled: () => false, onUpdate: variants => updates.push(variants),
    generateConcept: async (settings, _catalog, context) => {
      index++; events.push(`concept${index}`); conceptSettings.push(structuredClone(settings));
      assert.equal(settings.prompt, ''); assert.equal(settings.generationMethod, 'direct');
      assert.deepEqual(context, { previousConcepts: concepts.slice(0, index), candidateIndex: index, candidateCount: 2 });
      return concepts[index];
    },
    generateLayout: async (settings, _catalog, context) => {
      events.push(`layout${index}`); assert.deepEqual({ ...settings, prompt: '' }, conceptSettings[index]);
      assert.equal(settings.prompt, concepts[index]); assert.equal(context!.previousStructures!.length, index);
      assert.ok(updates.some(variants => variants[index].status === 'layout' && variants[index].concept?.text === concepts[index]));
      return room(index);
    },
    generateImage: async () => { throw new Error('image generation must not run'); },
    extractLayout: async () => { throw new Error('image extraction must not run'); },
  });
  assert.deepEqual(events, ['concept0', 'layout0', 'concept1', 'layout1']);
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready']);
  for (const candidate of result) {
    assert.deepEqual(candidate.project!.concept, { source: 'ai', text: concepts[candidate.index] });
    assert.equal(candidate.project!.settings.generationMethod, 'direct');
    assert.equal(candidate.project!.settings.seed, conceptSettings[candidate.index].seed);
    assert.equal(candidate.project!.settings.prompt, before.settings.prompt);
    assert.equal(candidate.project!.blueprintDataUrl, undefined);
  }
  assert.notEqual(conceptSettings[0].seed, conceptSettings[1].seed); assert.deepEqual(original, before);
});

test('direct candidate failures and duplicate geography do not retry or affect later candidates', async () => {
  const original = source(); original.settings.generationMethod = 'direct';
  let index = -1; const contexts: ImageGenerationContext[] = [];
  const result = await generateVariants(original, 4, {
    isCancelled: () => false,
    generateLayout: async (_settings, _catalog, context) => {
      index++; contexts.push(structuredClone(context!));
      if (index === 0) throw new Error('direct generation unavailable');
      if (index === 3) return { ...room(3), cellSize: 3 };
      return room(1);
    },
    generateImage: async () => { throw new Error('image generation must not run'); },
    extractLayout: async () => { throw new Error('image extraction must not run'); },
  });
  assert.equal(index, 3); assert.deepEqual(result.map(v => v.status), ['error', 'ready', 'error', 'error']);
  assert.equal(result[0].error, 'direct generation unavailable'); assert.match(result[2].error!, /중복 후보/); assert.match(result[3].error!, /셀 간격/);
  assert.deepEqual(contexts.map(context => context.previousStructures!.length), [0, 0, 1, 1]);
  assert.equal(result.filter(v => v.status === 'error').some(v => v.project), false);
});

test('direct cancellation before requests and after late responses preserves only finished candidates', async () => {
  for (const cancelAt of ['before', 'status', 'response', 'rejection'] as const) {
    const original = source(); original.settings.generationMethod = 'direct';
    let cancelled = cancelAt === 'before', calls = 0;
    const result = await generateVariants(original, 3, {
      isCancelled: () => cancelled,
      onUpdate: variants => { if (cancelAt === 'status' && variants[1].status === 'layout') cancelled = true; },
      generateLayout: async () => {
        const index = calls++;
        if (index === 1) { cancelled = true; if (cancelAt === 'rejection') throw new Error('late rejection'); }
        return room(index);
      },
      generateImage: async () => { throw new Error('image generation must not run'); },
      extractLayout: async () => { throw new Error('image extraction must not run'); },
    });
    assert.equal(calls, cancelAt === 'before' ? 0 : cancelAt === 'status' ? 1 : 2);
    assert.deepEqual(result.map(v => v.status), cancelAt === 'before' ? ['cancelled', 'cancelled', 'cancelled'] : ['ready', 'cancelled', 'cancelled']);
    assert.equal(result.filter(v => v.status === 'cancelled').some(v => v.project || v.error), false);
  }
});

test('direct candidates preserve completed local layers and report unsupported direct generation', async () => {
  const original = source(); original.settings.generationMethod = 'direct';
  original.settings.designer = { ...DEFAULT_DESIGNER, elevation: false, props: false, ceilings: true, lights: true };
  let index = -1;
  const result = await generateVariants(original, 2, {
    isCancelled: () => false,
    generateLayout: async (settings, catalog) => {
      const map = applyGeneratedFeatures(room(++index), settings, undefined, catalog); map.fixtures![0].id = `direct-light-${index}`; map.fixtures![0].offset.y = -.31; return map;
    },
    generateImage: async () => { throw new Error('image generation must not run'); },
    extractLayout: async () => { throw new Error('image extraction must not run'); },
  });
  assert.deepEqual(result.map(v => v.status), ['ready', 'ready']);
  for (const candidate of result) {
    assert.equal(candidate.project!.map.fixtures![0].id, `direct-light-${candidate.index}`);
    assert.equal(candidate.project!.map.fixtures![0].offset.y, -.31);
  }
  const unsupported = await generateVariants(original, 2, {
    isCancelled: () => false,
    generateImage: async () => { throw new Error('image generation must not run'); },
    extractLayout: async () => { throw new Error('image extraction must not run'); },
  });
  assert.ok(unsupported.every(candidate => candidate.status === 'error' && /맵 직접 생성 기능/.test(candidate.error!)));
});
