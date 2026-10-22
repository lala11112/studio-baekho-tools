import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { CodexService, validatedLoginUrl } from '../electron/services/codex';
import type { CodexRpc, RpcObject } from '../electron/services/codex-transport';
import { atomicWrite, createExportBundle, normalizeProject, readProject, serializeProject } from '../electron/services/projects';
import { scanUnityProject, verifyBindingProvenance } from '../electron/services/unity-project';
import { decodePngDataUrl, validateGenerationRegion, validateSettings } from '../electron/services/validation';
import { conceptPrompt, imagePrompt, layoutPrompt } from '../electron/services/prompts';
import { DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import type { AssetBinding, AssetRole, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';

const v4Map = (map: GridMap): GridMap => ({ ...map, version: 4, ceilings: [], wallHeights: [], bridges: [], cliffs: [], fixtures: [], markers: [], lockedCells: [], zones: [] });

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_BASE64}`;
const SETTINGS: GenerationSettings = { ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: '서늘한 석조 전투 공간', width: 8, height: 8, connectionCount: 1 };
const MAP: GridMap = {
  version: 3, name: 'Test dungeon', width: 8, height: 8, cellSize: SETTINGS.cellSize,
  rows: ['#D######', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
  connections: [{id:'north',label:'North',x:1,row:0,direction:0,width:2,height:3,kind:'door'}], assetOverrides: [],
  elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], maxStepHeight: SETTINGS.maxStepHeight,
};
const FLOOR_GUID = 'a'.repeat(32);
const WALL_GUID = 'b'.repeat(32);
function binding(role: AssetRole, guid: string, prefabPath = `Assets/${role}.prefab`): AssetBinding {
  return { id: role, label: role, role, prefabGuid: guid, prefabPath, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 };
}
function project(): ProjectFile {
  return { formatVersion: 1, map: structuredClone(MAP), settings: { ...SETTINGS }, bindings: [binding('floor', FLOOR_GUID), binding('wall', WALL_GUID), binding('door', 'd'.repeat(32))], blueprintDataUrl: PNG };
}
function raisedProject(): ProjectFile {
  const result = project();
  result.map.rows = ['#D######', '#..R...#', '########', '########', '########', '########', '########', '########'];
  for (let row = 0; row <= 2; row++) for (let x = 4; x <= 6; x++) result.map.elevations[row][x] = 2;
  result.map.ramps = [{ x: 3, row: 1, direction: 90, rise: 2 }];
  const stair = binding('stair', 'c'.repeat(32));
  stair.stairNativeRise = 0.5;
  stair.scale = { x: 1.5, y: 99, z: 2 };
  result.bindings.push(stair);
  return result;
}
class FakeCodex implements CodexRpc {
  requests: { method: string; params: RpcObject }[] = [];
  notifications = new Set<(method: string, params: RpcObject) => void>();
  closeListeners = new Set<() => void>();
  accountType: string | null = 'chatgpt';
  imageGeneration = true;
  hang = false;
  items: RpcObject[] = [{ type: 'imageGeneration', id: 'image-1', status: 'completed', result: PNG_BASE64 }];
  turnCount = 0;
  turnStarted?: () => void;
  closed = false;
  async request(method: string, params: RpcObject): Promise<RpcObject> {
    this.requests.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { external: { enabled: true, token: 'must-not-be-forwarded' } } } };
    if (method === 'account/read') return { account: this.accountType ? { type: this.accountType } : null, requiresOpenaiAuth: true };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: this.imageGeneration };
    if (method === 'model/list') return { data: [{ model: 'codex-test-model', displayName: 'Test Model', isDefault: true, inputModalities: ['text', 'image'] }] };
    if (method === 'account/login/start') return { type: 'chatgpt', authUrl: 'https://auth.openai.com/oauth/authorize?state=opaque' };
    if (method === 'thread/start') return { thread: { id: `thread-${this.turnCount + 1}` } };
    if (method === 'turn/start') {
      const id = `turn-${++this.turnCount}`;
      this.turnStarted?.();
      if (!this.hang) queueMicrotask(() => {
        for (const item of this.items) for (const listener of this.notifications) listener('item/completed', { threadId: params.threadId, turnId: id, item });
        for (const listener of this.notifications) listener('turn/completed', { threadId: params.threadId, turn: { id, status: 'completed', items: this.items } });
      });
      return { turn: { id, status: 'inProgress' } };
    }
    return {};
  }
  onNotification(listener: (method: string, params: RpcObject) => void): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  close(): void { this.closed = true; for (const listener of this.closeListeners) listener(); }
  layout(map: unknown): void { this.items = [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify(map) }]; }
}

async function codexFixture(t: TestContext, fake = new FakeCodex()): Promise<{ client: CodexService; fake: FakeCodex; root: string }> {
  const root = await fixture(t);
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'),
    discover: async () => ({ executable: 'mock-codex', version: 'test' }), connect: async () => fake });
  t.after(() => client.close());
  return { client, fake, root };
}
async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baekho-backend-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('baekho-backend-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'Assets'));
  await mkdir(path.join(root, 'ProjectSettings'));
  for (const [name, guid] of [['floor', FLOOR_GUID], ['wall', WALL_GUID], ['door','d'.repeat(32)]]) {
    await writeFile(path.join(root, 'Assets', `${name}.prefab`), 'local prefab contents must never enter the API or export bundle');
    await writeFile(path.join(root, 'Assets', `${name}.prefab.meta`), `fileFormatVersion: 2\nguid: ${guid}\n`);
  }
  return root;
}

test('backend rejects malformed or oversized settings and PNG data before any request', async t => {
  assert.throws(() => validateSettings({ ...SETTINGS, width: 41 }), /8~40/);
  assert.throws(() => validateSettings({ ...SETTINGS, cellSize: Infinity }), /0.25~10/);
  assert.throws(() => validateSettings({ ...SETTINGS, elevationStep: 0 }), /높이 단계/);
  assert.throws(() => validateSettings({ ...SETTINGS, maxStepHeight: 2 }), /단차/);
  assert.throws(() => validateSettings({ ...SETTINGS, codexModel: '../model' }), /모델 ID/);
  assert.throws(() => validateSettings({ ...SETTINGS, prompt: 'x'.repeat(6001) }), /6,000/);
  assert.throws(() => decodePngDataUrl('data:image/png;base64,abcd'), /올바른 PNG/);
  assert.throws(() => decodePngDataUrl('data:image/jpeg;base64,abcd'), /PNG/);
  const { client, fake } = await codexFixture(t);
  await assert.rejects(client.generateImage({ ...SETTINGS, height: NaN }));
  await assert.rejects(client.extractLayout(SETTINGS, 'data:image/png;base64,aaaa'));
  assert.equal(fake.requests.length, 0);
});

test('concept generation accepts an empty saved prompt and uses the same isolated model-aware connection', async t => {
  const { client, fake, root } = await codexFixture(t);
  const settings: GenerationSettings = { ...SETTINGS, conceptMode: 'ai', prompt: '', codexModel: 'codex-test-model',
    designer: { ...DEFAULT_DESIGNER, elevation: false, props: false }, connectionWidth: 3, connectionHeight: 4 };
  const concept = '진입 후 이동할 수 있는 범위를 파악하고 접근과 이탈 시점을 판단한다. 회피 뒤 다시 접근할지 거리를 유지할지 선택하며 이동 여유를 관리한다.';
  fake.items = [
    { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'This is not the result.' },
    { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify({ text: `  ${concept}  ` }) },
  ];
  const asset = { ...binding('prop', 'e'.repeat(32)), label: '석조 상자' };
  const context = { candidateIndex: 1, candidateCount: 3, previousConcepts: ['진입 후 이동 경로를 파악하고 안전하게 회피하는 판단을 익힌다.'], currentMap: MAP };
  assert.equal(await client.generateConcept(settings, [asset], context), concept);
  const thread = fake.requests.find(request => request.method === 'thread/start')!.params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.model, settings.codexModel);
  assert.equal(thread.sandbox, 'read-only'); assert.deepEqual(thread.config, { mcp_servers: { external: { enabled: false } } });
  const turn = fake.requests.find(request => request.method === 'turn/start')!.params;
  assert.deepEqual(turn.outputSchema, { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false });
  const prompt = String((turn.input as RpcObject[])[0].text);
  assert.match(prompt, /한국어/); assert.match(prompt, /도구를 사용하지 마세요/);
  assert.match(prompt, /"connectionWidth":3/); assert.match(prompt, /"connectionHeight":4/);
  assert.match(prompt, /석조 상자/); assert.ok(prompt.includes(context.previousConcepts[0])); assert.match(prompt, /2번 후보/);
  assert.match(prompt, /현재 맵 참고 정보/); assert.doesNotMatch(prompt, /Assets\/|eeeeeeee|must-not-be-forwarded/);
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('automatic concept prompts preserve generation constraints without consuming the retained manual input', () => {
  const prompt = conceptPrompt({ ...SETTINGS, conceptMode: 'ai', prompt: '지금은 사용하지 않는 직접 입력 문구',
    designer: { ...DEFAULT_DESIGNER, bridges: false }, levelDesign: { pattern: 'auto', characterRadius: .5, dodgeDistance: 2, theme: '우주 정거장' } });
  assert.match(prompt, /"bridges":false/); assert.match(prompt, /우주 정거장/);
  assert.match(prompt, /비활성 기능/); assert.match(prompt, /사용자가 지정한 필수 조건/);
  assert.doesNotMatch(prompt, /지금은 사용하지 않는 직접 입력 문구/);
});

test('automatic concepts describe gameplay choices without visual or concrete layout instructions', () => {
  const settings = { ...SETTINGS, conceptMode: 'ai' as const, designer: { ...DEFAULT_DESIGNER, preset: 'shop' as const, enemies: false, hazards: false } };
  const prompt = conceptPrompt(settings, undefined, { candidateIndex: 1, candidateCount: 2, previousConcepts: ['상인에게 안전하게 접근한 뒤 구매할 시점과 자원 사용을 판단한다.'] });
  assert.match(prompt, /컨셉은 플레이 의도만 설명합니다/);
  assert.match(prompt, /시각 디자인, 테마·배경 설정, 분위기, 색감, 조명, 재질, 장식 묘사는 포함하지 마세요/);
  assert.match(prompt, /구체적인 배치나 설계 지시도 포함하지 마세요/);
  assert.match(prompt, /플레이 목표 또는 판단·선택의 초점을 다르게/);
  assert.match(prompt, /같은 방 용도와 활성 기능 안에서/);
  assert.match(prompt, /"purpose":"shop"/); assert.match(prompt, /"enemies":false/); assert.match(prompt, /"hazards":false/);
  assert.match(prompt, /기본 블록아웃에서 가능한 플레이 목표와 선택만/);
  assert.doesNotMatch(prompt, /테마와 분위기, 공간의 시각적 특징|테마·분위기·공간의 인상이 분명히 다른/);
});

test('concept generation rejects malformed responses, blank or oversized text without making images', async t => {
  const { client, fake } = await codexFixture(t);
  const settings = { ...SETTINGS, conceptMode: 'ai' as const, prompt: '' };
  for (const response of ['not JSON', 'null', '[]', JSON.stringify({ text: '' }), JSON.stringify({ text: '   ' }),
    JSON.stringify({ text: 3 }), JSON.stringify({ text: '가'.repeat(2001) }), JSON.stringify({ text: '컨셉', unexpected: true })]) {
    fake.items = [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: response }];
    await assert.rejects(client.generateConcept(settings), /컨셉/);
  }
  fake.items = [{ type: 'imageGeneration', id: 'image-only', status: 'completed', result: PNG_BASE64 }];
  await assert.rejects(client.generateConcept(settings), /컨셉 JSON/);
  assert.equal(fake.requests.filter(request => request.method === 'turn/start').length, 9);
  for (const request of fake.requests.filter(request => request.method === 'turn/start')) {
    assert.deepEqual((request.params.input as RpcObject[]).map(item => item.type), ['text']);
  }
});

test('concept context and unresolved generation prompts fail before any Codex request', async t => {
  const { client, fake } = await codexFixture(t);
  for (const conceptMode of ['ai', 'manual'] as const) {
    const settings = { ...SETTINGS, conceptMode, prompt: '   ' };
    assert.equal(validateSettings(settings).prompt, '');
    await assert.rejects(client.generateImage(settings), /컨셉/);
    await assert.rejects(client.extractLayout(settings, PNG), /컨셉/);
  }
  await assert.rejects(client.generateConcept(SETTINGS, [{ bad: 'binding' }]));
  for (const context of [null, [], { unexpected: true }, { previousConcepts: [''] }, { candidateIndex: -1, candidateCount: 3 },
    { currentMap: { ...MAP, width: 9, rows: MAP.rows.map(row => `${row}#`), elevations: MAP.elevations.map(row => [...row, 0]) } }]) {
    await assert.rejects(client.generateConcept({ ...SETTINGS, conceptMode: 'ai', prompt: '' }, undefined, context));
  }
  assert.equal(fake.requests.length, 0);
});

test('concept cancellation rejects late answers and retains the busy guard', async t => {
  const { client, fake, root } = await codexFixture(t);
  fake.hang = true;
  const settings = { ...SETTINGS, conceptMode: 'ai' as const, prompt: '' };
  const started = new Promise<void>(resolve => { fake.turnStarted = resolve; });
  const first = client.generateConcept(settings);
  const cancelled = assert.rejects(first, /취소되었습니다/);
  await started;
  await new Promise(resolve => setImmediate(resolve));
  const lateListeners = [...fake.notifications];
  await assert.rejects(client.generateImage(SETTINGS), /이미 Codex 생성/);
  client.cancel();
  for (const listener of lateListeners) listener('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed',
    items: [{ type: 'agentMessage', id: 'late', text: JSON.stringify({ text: '늦게 도착한 컨셉' }) }] } });
  await cancelled;
  assert.equal(fake.closed, true); assert.equal(fake.notifications.size, 0);
  assert.ok(fake.requests.some(request => request.method === 'turn/interrupt'));
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('Codex generates native PNG then vision structured JSON using ephemeral isolated threads', async t => {
  const { client, fake, root } = await codexFixture(t);
  assert.equal((await client.getStatus()).state, 'ready');
  const image = await client.generateImage(SETTINGS);
  assert.equal(image, PNG);
  fake.layout(MAP);
  const result = await client.extractLayout(SETTINGS, image);
  assert.deepEqual(result, v4Map(MAP));
  const threadRequests = fake.requests.filter(request => request.method === 'thread/start');
  assert.equal(threadRequests.length, 2);
  for (const { params } of threadRequests) {
    assert.equal(params.ephemeral, true);
    assert.deepEqual(params.environments, []);
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.model, undefined, 'Default model must come from the runtime');
    assert.ok(String(params.cwd).startsWith(path.join(root, 'codex', 'jobs', 'map-')));
    assert.deepEqual(params.config, { mcp_servers: { external: { enabled: false } } });
  }
  const turns = fake.requests.filter(request => request.method === 'turn/start');
  const imageInput = turns[0].params.input as RpcObject[];
  assert.match(String(imageInput[0].text), /native image_generation/);
  assert.match(String(imageInput[0].text), /axonometric CUTAWAY 3D/);
  const layoutInput = turns[1].params.input as RpcObject[];
  assert.equal(layoutInput[1].url, PNG);
  assert.equal(layoutInput[1].type, 'image');
  assert.ok(turns[1].params.outputSchema);
  assert.match(String(layoutInput[0].text), /version must be 4/);
  assert.ok(!JSON.stringify(turns).includes('Assets/'));
  assert.ok(!JSON.stringify(turns).includes('must-not-be-forwarded'));
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('Codex rejects invalid layouts without substituting a sample', async t => {
  const { client, fake } = await codexFixture(t);
  const disconnected = { ...MAP, rows: ['#D######', '#.#....#', '###....#', '#......#', '#......#', '#......#', '#......#', '########'] };
  fake.layout(disconnected);
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /연결되어 있지 않습니다/);
  fake.layout({ ...MAP, cellSize: 3 });
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /요청한 설정과 다릅니다/);
  fake.layout(null);
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /검증을 통과하지 못했습니다/);
});

test('new-map prompts require exact connection dimensions and reserve the full multi-cell opening', () => {
  const settings = { ...SETTINGS, prompt: '연결문은 폭 1m, 높이 2m로 만들어 주세요.', connectionWidth: 4.5, connectionHeight: 5.75 };
  for (const prompt of [imagePrompt(settings), layoutPrompt(settings)]) {
    assert.match(prompt, /width exactly 4\.5m/);
    assert.match(prompt, /height exactly 5\.75m/);
    assert.match(prompt, /exactly 3 adjacent D cells/);
    assert.match(prompt, /without rounding it to whole cells/);
    assert.match(prompt, /Explicit connection dimensions override conflicting text/);
    assert.doesNotMatch(prompt, /Door openings are normally/);
  }
  const legacy = { ...SETTINGS }; delete legacy.connectionWidth; delete legacy.connectionHeight;
  for (const prompt of [imagePrompt(legacy), layoutPrompt(legacy)]) {
    assert.match(prompt, /normally 2m wide/); assert.match(prompt, /normally 3m tall/);
    assert.match(prompt, /honor a different width requested by the brief/);
  }
});

test('extraction preserves requested fractional door sizes and rejects mismatches without a designer', async t => {
  const { client, fake } = await codexFixture(t);
  const settings = { ...SETTINGS, connectionWidth: 4.5, connectionHeight: 5.75 };
  const wide = structuredClone(MAP);
  wide.rows[0] = '#DDD####';
  wide.connections[0].width = 4.5; wide.connections[0].height = 5.75;
  fake.layout(wide);
  const result = await client.extractLayout(settings, PNG);
  assert.deepEqual(result.connections, wide.connections);
  assert.equal(result.rows[0], '#DDD####');
  for (const dimensions of [{ width: 4.25, height: 5.75 }, { width: 4.5, height: 5.5 }]) {
    const mismatch = structuredClone(wide); Object.assign(mismatch.connections[0], dimensions);
    fake.layout(mismatch);
    await assert.rejects(client.extractLayout(settings, PNG), /연결문.*(?:폭|높이)/);
    assert.deepEqual(mismatch.connections[0], { ...wide.connections[0], ...dimensions }, 'mismatches are rejected, never silently resized');
  }
  const legacy = { ...SETTINGS }; delete legacy.connectionWidth; delete legacy.connectionHeight;
  fake.layout(wide);
  assert.deepEqual((await client.extractLayout(legacy, PNG)).connections, wide.connections, 'old settings without dimensions keep accepting brief-defined sizes');
});

test('region image and extraction retain heterogeneous door sizes despite new-map size preferences', async t => {
  const { client, fake } = await codexFixture(t);
  const region = { x: 3, row: 3, width: 2, height: 2 };
  const settings = { ...SETTINGS, connectionCount: 2, connectionWidth: 6.5, connectionHeight: 7.25 };
  const existing = structuredClone(MAP);
  existing.rows[0] = '#DDD####'; existing.rows[7] = '#####D##';
  existing.connections[0].width = 4.5; existing.connections[0].height = 5.75;
  existing.connections.push({ id: 'south', label: 'South', x: 5, row: 7, direction: 180, width: 1.25, height: 2.25, kind: 'door' });
  await client.generateImage(settings, region);
  fake.layout(existing);
  const result = await client.extractLayout(settings, PNG, region);
  assert.deepEqual(result.connections, existing.connections);
  assert.deepEqual(result.rows, existing.rows);
  for (const request of fake.requests.filter(request => request.method === 'turn/start')) {
    const prompt = String((request.params.input as RpcObject[])[0].text);
    assert.match(prompt, /Preserve every existing connection width and height exactly/);
    assert.match(prompt, /different sizes on different doors/);
    assert.match(prompt, /Global new-door size settings do not apply/);
    assert.doesNotMatch(prompt, /width exactly 6\.5m|height exactly 7\.25m|Door openings are normally/);
  }
});

test('vision extraction preserves a raised platform and rejects a stair that cannot reach its landing', async t => {
  const { client, fake } = await codexFixture(t);
  const raised = raisedProject().map;
  fake.layout(raised);
  assert.deepEqual(await client.extractLayout(SETTINGS, PNG), v4Map(raised));
  const mismatch = structuredClone(raised);
  mismatch.ramps[0].rise = 1;
  fake.layout(mismatch);
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /검증을 통과하지 못했습니다/);
});

test('designer extraction appends deterministic ceiling and content layers after validated AI geography',async t=>{
  const {client,fake}=await codexFixture(t);
  const settings={...SETTINGS,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,ceilings:true,lights:true,enemies:true,rewards:true,enemyCount:3,rewardCount:2,fixtureDensity:2}};
  fake.layout({...MAP,version:4,bridges:[]});const result=await client.extractLayout(settings,PNG);
  assert.equal(result.version,4);assert.deepEqual(result.rows,MAP.rows);assert.deepEqual(result.elevations,MAP.elevations);
  assert.ok(result.ceilings?.length);assert.equal(new Set(result.ceilings!.map(c=>c.undersideY)).size,1);
  assert.equal(result.fixtures?.filter(f=>f.role==='light').length,1);assert.equal(result.markers?.filter(m=>m.kind==='enemy').length,3);assert.equal(result.markers?.filter(m=>m.kind==='reward').length,2);
  const output=fake.requests.find(r=>r.method==='turn/start')!.params.outputSchema as {properties:{version:{enum:number[]}}};assert.deepEqual(output.properties.version.enum,[4]);
});

test('designer conditions fail visibly when AI omits requested structure instead of flattening or inventing it',async t=>{
  const {client,fake}=await codexFixture(t);fake.layout({...MAP,version:4,bridges:[]});
  await assert.rejects(client.extractLayout({...SETTINGS,designer:{...DEFAULT_DESIGNER,elevation:true,props:false}},PNG),/높이 지형/);
  fake.layout({...MAP,version:4,bridges:[]});
  await assert.rejects(client.extractLayout({...SETTINGS,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,bridges:true}},PNG),/다리/);
  fake.layout({...MAP,version:4,bridges:[],markers:[{id:'injected',label:'Injected',kind:'enemy',contentKey:'',x:1,row:1,direction:0,offset:{x:0,y:0,z:0}}]});
  await assert.rejects(client.extractLayout({...SETTINGS,designer:{...DEFAULT_DESIGNER,elevation:false,props:false}},PNG),/허용되지 않는 추가 콘텐츠/);
});

function groupedChokeMap(): GridMap {
  return { ...structuredClone(MAP), version: 4,
    rows: ['####D###', '#......#', '####P###', '#......#', '#......#', '#......#', '#......#', '########'],
    connections: [{ id: 'north', label: 'North', x: 4, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function groupedChokeSettings(): GenerationSettings {
  return { ...SETTINGS, designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: true, propLayout: 'grouped', propCoverage: 1 },
    levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
}

test('grouped extraction removes optional P choke hints before topology and local content validation', async t => {
  const { client, fake, root } = await codexFixture(t), geography = groupedChokeMap(), before = structuredClone(geography), config = groupedChokeSettings();
  const crate = { ...binding('prop', 'e'.repeat(32)), label: 'Crate', prop: { category: '상자', tags: [], blocksMovement: true,
    size: { x: 1, y: 1, z: 1 }, placement: 'floor' as const, roomTypes: ['shop' as const], weight: 1 } };
  assert.ok(validateMap(geography).some(issue => issue.severity === 'error'), 'the optional hint initially severs the only connecting path');
  fake.layout(geography);
  const result = await client.extractLayout(config, PNG, undefined, [crate]);
  assert.equal(result.rows[2][4], '.'); assert.deepEqual(result.connections, geography.connections); assert.deepEqual(result.elevations, geography.elevations);
  assert.deepEqual(validateMap(result).filter(issue => issue.severity === 'error'), []); assert.deepEqual(geography, before);
  assert.equal(fake.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('grouped hint cleanup never accepts AI-authored assignments, locks, fixtures or measured content', async t => {
  const { client, fake } = await codexFixture(t), config = groupedChokeSettings(), base = groupedChokeMap();
  const assigned = structuredClone(base); assigned.assetOverrides.push({ x: 4, row: 2, role: 'prop', bindingId: 'prop' });
  const locked = { ...structuredClone(base), lockedCells: [{ x: 4, row: 2 }] };
  const fixtureMap = { ...structuredClone(base), fixtures: [{ id: 'injected', role: 'decoration' as const, x: 4, row: 2, direction: 0 as const, offset: { x: 0, y: 0, z: 0 } }] };
  const measured = { ...structuredClone(base), version: 5 as const, propInstances: [{ id: 'injected-prop', bindingId: 'prop', role: 'prop' as const, x: 4, row: 2,
    direction: 0 as const, offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 4, row: 2 }], size: { x: 1, y: 1, z: 1 }, blocksMovement: true, category: '상자', provenance: 'generated' as const }] };
  for (const geography of [assigned, locked, fixtureMap, measured]) {
    fake.layout(geography);
    await assert.rejects(client.extractLayout(config, PNG), /허용되지 않는 추가 콘텐츠|AI 배치도는 셀 에셋/);
  }
});

test('grouped cleanup leaves real topology errors, malformed tiles, legacy counts and outside-region hints rejected', async t => {
  const { client, fake } = await codexFixture(t), config = groupedChokeSettings(), blocked = groupedChokeMap();
  blocked.rows[2] = '########'; fake.layout(blocked);
  await assert.rejects(client.extractLayout(config, PNG), /검증을 통과하지 못했습니다|연결되어 있지/);
  const malformed = groupedChokeMap(); malformed.rows[2] = '####X###'; fake.layout(malformed);
  await assert.rejects(client.extractLayout(config, PNG), /허용되지 않는 문자|검증을 통과하지 못했습니다/);
  fake.layout(groupedChokeMap());
  await assert.rejects(client.extractLayout({ ...config, designer: { ...config.designer!, propLayout: 'legacy' } }, PNG), /검증을 통과하지 못했습니다|연결되어 있지/);
  fake.layout(groupedChokeMap());
  await assert.rejects(client.extractLayout(config, PNG, { x: 1, row: 3, width: 6, height: 4 }), /검증을 통과하지 못했습니다|연결되어 있지/);
});

test('region requests validate bounds before calling Codex and explicitly scope image/layout prompts',async t=>{
  const {client,fake}=await codexFixture(t),region={x:4,row:4,width:3,height:3};
  assert.equal(validateGenerationRegion(undefined,SETTINGS),undefined);
  assert.deepEqual(validateGenerationRegion(region,SETTINGS),region);
  for(const invalid of [null,{},[],{...region,x:-1},{...region,width:5},{...region,row:1.5},{...region,height:0},{...region,unexpected:true}]){
    await assert.rejects(client.generateImage(SETTINGS,invalid),/재생성 영역/);
    await assert.rejects(client.extractLayout(SETTINGS,PNG,invalid),/재생성 영역/);
  }
  assert.equal(fake.requests.length,0);
  const settings={...SETTINGS,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,ceilings:true,enemies:true,enemyCount:100}};
  await client.generateImage(settings,region);
  const geography=structuredClone(MAP);geography.rows[1]='#.P....#';fake.layout(geography);
  const result=await client.extractLayout(settings,PNG,region);
  assert.deepEqual(result.rows,geography.rows,'outside props do not violate a local off toggle');
  assert.equal(result.ceilings,undefined);assert.equal(result.markers,undefined,'region extraction does not allocate whole-map content before merging');
  for(const request of fake.requests.filter(r=>r.method==='turn/start'))assert.match(String((request.params.input as {text?:string}[])[0].text),/ALL feature toggles and requested counts below apply ONLY to this selected editable region/);
  fake.layout({...geography,markers:[{id:'injected',label:'Injected',kind:'enemy',contentKey:'',x:1,row:1,direction:0,offset:{x:0,y:0,z:0}}]});
  await assert.rejects(client.extractLayout(settings,PNG,region),/허용되지 않는 추가 콘텐츠/);
});

test('Codex requires managed ChatGPT login and native image support', async t => {
  const { client, fake } = await codexFixture(t);
  fake.accountType = 'apiKey';
  assert.equal((await client.getStatus()).state, 'login-required');
  await assert.rejects(client.generateImage(SETTINGS), /ChatGPT 로그인/);
  assert.equal(fake.turnCount, 0);
  fake.accountType = null;
  assert.equal((await client.getStatus()).state, 'login-required');
  fake.accountType = 'chatgpt';
  fake.imageGeneration = false;
  assert.equal((await client.getStatus()).state, 'error');
  await assert.rejects(client.generateImage(SETTINGS), /이미지 생성을 지원하지 않습니다/);
  fake.imageGeneration = true;
  await assert.rejects(client.generateImage({ ...SETTINGS, codexModel: 'not-available' }), /모델을 현재 Codex 계정/);
  assert.equal(fake.turnCount, 0);
});

test('Codex reports missing runtime and only allows official HTTPS login URLs', async t => {
  const { client, root } = await codexFixture(t);
  assert.match(await client.startLogin(), /^https:\/\/auth\.openai\.com/);
  assert.throws(() => validatedLoginUrl('http://auth.openai.com'), /허용되지 않은/);
  assert.throws(() => validatedLoginUrl('https://auth.openai.com.attacker.test'), /허용되지 않은/);
  assert.throws(() => validatedLoginUrl('https://user:password@auth.openai.com'), /허용되지 않은/);
  const missing = new CodexService({ dataDirectory: path.join(root, 'missing'), discover: async () => null });
  assert.equal((await missing.getStatus()).state, 'missing');
  await assert.rejects(missing.generateImage(SETTINGS), /실행 파일을 찾지 못했습니다/);
});

test('Codex allows one active request, interrupts on cancel, and cleans isolated jobs', async t => {
  const { client, fake, root } = await codexFixture(t);
  fake.hang = true;
  const started = new Promise<void>(resolve => { fake.turnStarted = resolve; });
  const first = client.generateImage(SETTINGS);
  const cancelled = assert.rejects(first, /취소되었습니다/);
  await started;
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.generateImage(SETTINGS), /이미 Codex 생성/);
  client.cancel();
  await cancelled;
  assert.equal(fake.closed, true);
  assert.ok(fake.requests.some(request => request.method === 'turn/interrupt'));
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('concept, image and extraction wait beyond five minutes and accept late successful results', async t => {
  for (const stage of ['concept', 'image', 'extract'] as const) await t.test(stage, async t => {
    const { client, fake, root } = await codexFixture(t);
    fake.hang = true;
    const concept = '진입 후 이동 여유를 파악하고 접근과 이탈 시점을 선택한다.';
    if (stage === 'concept') fake.items = [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify({ text: concept }) }];
    else if (stage === 'extract') fake.layout(MAP);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = new Promise<void>(resolve => { fake.turnStarted = resolve; });
    const generation = stage === 'concept' ? client.generateConcept({ ...SETTINGS, conceptMode: 'ai', prompt: '' })
      : stage === 'image' ? client.generateImage(SETTINGS) : client.extractLayout(SETTINGS, PNG);
    let settled = false;
    const outcome = generation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await started;
    await new Promise(resolve => setImmediate(resolve));
    for (const elapsed of [5 * 60 * 1000 + 1, 60 * 60 * 1000]) {
      t.mock.timers.tick(elapsed);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'Elapsed generation time must not settle or cancel the request.');
      assert.equal(fake.closed, false);
      assert.ok(!fake.requests.some(request => request.method === 'turn/interrupt'));
    }
    await assert.rejects(client.generateImage(SETTINGS), /이미 Codex 생성/);
    for (const listener of [...fake.notifications]) listener('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: fake.items } });
    const result = await outcome;
    if ('error' in result) throw result.error;
    assert.deepEqual(result.value, stage === 'concept' ? concept : stage === 'image' ? PNG : v4Map(MAP));
    assert.equal(fake.notifications.size, 0);
    assert.ok(fake.requests.some(request => request.method === 'thread/unload'));
    assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
  });
});

test('closing a long-running generation cancels it and ignores late completion', async t => {
  const { client, fake, root } = await codexFixture(t);
  fake.hang = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = new Promise<void>(resolve => { fake.turnStarted = resolve; });
  const cancelled = assert.rejects(client.generateImage(SETTINGS), /취소되었습니다/);
  await started;
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60 * 60 * 1000);
  const lateListeners = [...fake.notifications];
  client.close();
  for (const listener of lateListeners) listener('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: fake.items } });
  await cancelled;
  assert.equal(fake.closed, true);
  assert.equal(fake.notifications.size, 0);
  assert.ok(fake.requests.some(request => request.method === 'turn/interrupt'));
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
  await assert.rejects(client.generateImage(SETTINGS), /연결이 종료/);
});

test('Codex refuses failed image tools even when the surrounding turn completed', async t => {
  const { client, fake } = await codexFixture(t);
  fake.items = [{ type: 'imageGeneration', id: 'bad-image', status: 'failed', result: '', failure: { type: 'usageLimitExceeded' } }];
  await assert.rejects(client.generateImage(SETTINGS), /사용량 한도/);
  fake.items = [{ type: 'agentMessage', id: 'text-only', text: 'I drew an image in text.' }];
  await assert.rejects(client.generateImage(SETTINGS), /이미지를 생성하지 못했습니다/);
});

test('closing during delayed connection prevents late worker assignment', async t => {
  const root = await fixture(t);
  const fake = new FakeCodex();
  let release!: (client: CodexRpc) => void;
  let connecting!: () => void;
  const connected = new Promise<void>(resolve => { connecting = resolve; });
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'),
    discover: async () => ({ executable: 'mock', version: 'test' }),
    connect: async () => { connecting(); return new Promise<CodexRpc>(resolve => { release = resolve; }); },
  });
  const status = client.getStatus();
  await connected;
  client.close();
  release(fake);
  assert.equal((await status).state, 'error');
  assert.equal(fake.closed, true);
  assert.equal(fake.requests.length, 0);
  assert.equal((await client.getStatus()).state, 'error');
});

test('cancel during discovery settles immediately and cannot start a late worker', async t => {
  const root = await fixture(t);
  let release!: (runtime: { executable: string; version: string }) => void;
  let discovering!: () => void;
  const started = new Promise<void>(resolve => { discovering = resolve; });
  let connects = 0;
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'),
    discover: () => { discovering(); return new Promise(resolve => { release = resolve; }); },
    connect: async () => { connects++; return new FakeCodex(); },
  });
  const generation = client.generateImage(SETTINGS);
  const cancelled = assert.rejects(generation, /취소되었습니다/);
  await started;
  client.cancel();
  await cancelled;
  release({ executable: 'mock', version: 'test' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connects, 0);
  client.close();
});

test('closing during initial config read closes the pending worker', async t => {
  const root = await fixture(t);
  const fake = new FakeCodex();
  let release!: (value: RpcObject) => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const original = fake.request.bind(fake);
  fake.request = async (method, params) => {
    if (method === 'config/read') { reading(); return new Promise(resolve => { release = resolve; }); }
    return original(method, params);
  };
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'),
    discover: async () => ({ executable: 'mock', version: 'test' }), connect: async () => fake,
  });
  const status = client.getStatus();
  await started;
  client.close();
  assert.equal(fake.closed, true);
  release({ config: {} });
  assert.equal((await status).state, 'error');
});

test('local turn processing failure terminates the private worker and cleans job files', async t => {
  const fake = new FakeCodex();
  fake.items = [{ type: 'agentMessage', id: 'oversize', phase: 'final_answer', text: 'x'.repeat(2 * 1024 * 1024 + 1) }];
  const { client, root } = await codexFixture(t, fake);
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /허용 크기/);
  assert.equal(fake.closed, true);
  assert.deepEqual(await readdir(path.join(root, 'codex', 'jobs')), []);
});

test('status failure closes a hung transport so a fresh status check reconnects', async t => {
  const root = await fixture(t);
  const failed = new FakeCodex();
  const healthy = new FakeCodex();
  const original = failed.request.bind(failed);
  failed.request = async (method, params) => {
    if (method === 'account/read') throw new Error('Codex request timeout');
    return original(method, params);
  };
  let connections = 0;
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'),
    discover: async () => ({ executable: 'mock', version: 'test' }), connect: async () => connections++ === 0 ? failed : healthy,
  });
  assert.equal((await client.getStatus()).state, 'error');
  assert.equal(failed.closed, true);
  assert.equal((await client.getStatus()).state, 'ready');
  assert.equal(connections, 2);
  client.close();
});

test('explicit commentary is never accepted as the structured final map', async t => {
  const { client, fake } = await codexFixture(t);
  fake.items = [{ type: 'agentMessage', id: 'commentary', phase: 'commentary', text: JSON.stringify(MAP) }];
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /올바른 배치도 JSON/);
});

test('Unity scan validates GUIDs, keeps Assets-relative paths, and excludes ambiguous duplicate GUIDs', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'Assets/Nested'));
  await writeFile(path.join(root, 'Assets/Nested/missing.prefab'), 'ignored');
  await writeFile(path.join(root, 'Assets/invalid.prefab'), 'ignored');
  await writeFile(path.join(root, 'Assets/invalid.prefab.meta'), 'guid: invalid');
  await writeFile(path.join(root, 'Assets/duplicate.prefab'), 'ignored');
  await writeFile(path.join(root, 'Assets/duplicate.prefab.meta'), `guid: ${WALL_GUID}`);
  const scan = await scanUnityProject(root);
  assert.deepEqual(scan.assets.map(asset => asset.path), ['Assets/door.prefab', 'Assets/floor.prefab']);
  assert.equal(scan.assets.find(asset => asset.path === 'Assets/floor.prefab')!.guid, FLOOR_GUID);
  assert.ok(scan.warnings.length >= 2);
  assert.ok(scan.warnings.some(warning => warning.includes('중복 GUID')));
});

test('Unity scan skips directory links rather than following external Assets', async t => {
  const root = await fixture(t);
  const linkedRoot = await fixture(t);
  const link = path.join(root, 'Assets/Linked');
  try { await symlink(path.join(linkedRoot, 'Assets'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Directory symlink creation is not permitted on this host'); return; }
    throw error;
  }
  const scan = await scanUnityProject(root);
  assert.equal(scan.assets.length, 3);
  assert.ok(scan.assets.every(asset => !asset.path.includes('Linked')));
});

test('export provenance requires rescan and detects path or GUID changes on disk', async t => {
  const root = await fixture(t);
  const scan = await scanUnityProject(root);
  await assert.rejects(verifyBindingProvenance(project().bindings, null), /스캔/);
  await verifyBindingProvenance(project().bindings, scan);
  await assert.rejects(verifyBindingProvenance([binding('floor', FLOOR_GUID, 'Assets/../secret.prefab')], scan), /일치하지 않습니다/);
  await writeFile(path.join(root, 'Assets/floor.prefab.meta'), `guid: ${'c'.repeat(32)}`);
  await assert.rejects(verifyBindingProvenance(project().bindings, scan), /다시 스캔/);
});

test('native project persistence rejects credentials and preserves editable unfinished maps', async t => {
  const root = await fixture(t);
  const incomplete = project();
  incomplete.map.connections = [];
  incomplete.bindings = [];
  const serialized = serializeProject(incomplete);
  assert.ok(!serialized.includes('apiKey'));
  assert.throws(() => serializeProject({ ...incomplete, apiKey: 'secret' }), /구조가 올바르지 않습니다/);
  assert.throws(() => normalizeProject({ ...incomplete, settings: { ...SETTINGS, apiKey: 'secret' } }), /settings/);
  const filePath = path.join(root, 'Map.baekho.json');
  await atomicWrite(filePath, serialized);
  assert.deepEqual(await readProject(filePath), { ...incomplete, map:v4Map(incomplete.map) });
  await writeFile(filePath, 'not JSON');
  await assert.rejects(readProject(filePath), /프로젝트 JSON/);
});

test('v2 project persistence preserves editable heights, ramp direction, rise and movement settings', async t => {
  const root = await fixture(t);
  const original = raisedProject();
  const filePath = path.join(root, 'Raised.baekho.json');
  await atomicWrite(filePath, serializeProject(original));
  const reopened = await readProject(filePath);
  assert.deepEqual(reopened, { ...original, map:v4Map(original.map) });
  assert.equal(reopened.map.elevations[1][4], 2);
  assert.deepEqual(reopened.map.ramps, [{ x: 3, row: 1, direction: 90, rise: 2 }]);
  assert.equal(reopened.settings.elevationStep, SETTINGS.elevationStep);
  assert.equal(reopened.map.maxStepHeight, SETTINGS.maxStepHeight);
  assert.equal(reopened.bindings.find(item => item.role === 'stair')!.stairNativeRise, 0.5);
  reopened.map.elevations[1][4] = 3;
  assert.equal(original.map.elevations[1][4], 2);
});

test('legacy flat project migration initializes v2 heights and settings before safe serialization', () => {
  const { connections: _connections, assetOverrides: _overrides, elevations: _elevations, ramps: _ramps, maxStepHeight: _mapMaxStepHeight, ...legacyMap } = MAP;
  const { elevationStep: _elevationStep, maxStepHeight: _settingsMaxStepHeight, ...legacySettings } = SETTINGS;
  const migrated = normalizeProject({ ...project(), map: { ...legacyMap, version: 1 }, settings: legacySettings });
  assert.equal(migrated.map.version, 4);
  assert.deepEqual(migrated.map.elevations, Array.from({ length: 8 }, () => Array(8).fill(0)));
  assert.deepEqual(migrated.map.ramps, []);
  assert.equal(migrated.map.maxStepHeight, 0.4);
  assert.equal(migrated.settings.elevationStep, 2);
});

test('atomic save replaces only the selected file and cleans staging files', async t => {
  const root = await fixture(t);
  const selected = path.join(root, 'selected.json');
  const neighbor = path.join(root, 'neighbor.json');
  await writeFile(selected, 'old');
  await writeFile(neighbor, 'keep');
  await atomicWrite(selected, 'new');
  assert.equal(await readFile(selected, 'utf8'), 'new');
  assert.equal(await readFile(neighbor, 'utf8'), 'keep');
  assert.ok((await readdir(root)).every(file => !file.endsWith('.tmp')));
});

test('ZIP contains validated manifest, importer, blueprint and instructions, without source prefabs', async t => {
  const root = await fixture(t);
  const scan = await scanUnityProject(root);
  const files = unzipSync(await createExportBundle(project(), scan, '// importer fixture', '// runtime fixture', '// marker fixture', '// fixture metadata'));
  assert.deepEqual(Object.keys(files).sort(), ['Map.baekhomap.json', 'README.txt', 'Unity/Editor/BaekhoMapImporter.cs', 'Unity/Runtime/BaekhoMapConnection.cs', 'Unity/Runtime/BaekhoGameplayMarker.cs', 'Unity/Runtime/BaekhoMapFixture.cs', 'blueprint.png'].sort());
  const manifest = JSON.parse(strFromU8(files['Map.baekhomap.json']));
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.placements.some((placement: { role: string }) => ['spawn','exit'].includes(placement.role)), false);
  assert.equal(manifest.connections.length, 1);
  assert.equal(manifest.connections[0].id, 'north');
  assert.deepEqual(manifest.connections[0].position, { x: -5, y: 0, z: 8 });
  assert.equal(strFromU8(files['Unity/Runtime/BaekhoMapConnection.cs']), '// runtime fixture');
  assert.ok(manifest.placements.some((placement: { prefabGuid: string }) => placement.prefabGuid === FLOOR_GUID));
  assert.equal(strFromU8(files['Unity/Editor/BaekhoMapImporter.cs']), '// importer fixture');
  assert.match(strFromU8(files['README.txt']), /Assets > Baekho > Build Prefab/);
  assert.match(strFromU8(files['README.txt']), /JSON 파일과 같은 폴더/);
  const guide = strFromU8(files['README.txt']);
  assert.ok(guide.indexOf('Assets/Baekho/Runtime/BaekhoMapConnection.cs') < guide.indexOf('4. Map.baekhomap.json'));
  assert.equal(guide.includes('스폰·출구'), false);
  assert.match(strFromU8(files['README.txt']), /덮어쓰지 않습니다/);
  assert.match(strFromU8(files['README.txt']), /Assets\/Baekho\/Editor\/BaekhoMapImporter\.cs/);
  assert.deepEqual(Buffer.from(files['blueprint.png']), decodePngDataUrl(PNG));
  assert.ok(!strFromU8(files['Map.baekhomap.json']).includes('prefab contents'));
  const wallBundle=unzipSync(await createExportBundle(project(),scan,'// importer','// connection','// marker','// fixture','// catalog v2','// wall module','# 벽 부착물 제작'));
  assert.equal(strFromU8(wallBundle['Unity/Editor/BaekhoPropCatalog.cs']),'// catalog v2');
  assert.equal(strFromU8(wallBundle['Unity/Runtime/BaekhoWallModule.cs']),'// wall module');
  assert.equal(strFromU8(wallBundle['Unity/WALL_PREFABS.ko.md']),'# 벽 부착물 제작');
  const assetBundle = unzipSync(await createExportBundle(project(), scan, '// importer', '// connection', '// marker', '// fixture', '// bounds', '// wall', undefined,
    { runtime: '// map asset', editor: '// multi edit', catalog: '// asset catalog' }));
  assert.equal(strFromU8(assetBundle['Unity/Runtime/BaekhoMapAsset.cs']), '// map asset');
  assert.equal(strFromU8(assetBundle['Unity/Editor/BaekhoMapAssetEditor.cs']), '// multi edit');
  assert.equal(strFromU8(assetBundle['Unity/Editor/BaekhoAssetCatalog.cs']), '// asset catalog');
  assert.ok(!Object.keys(assetBundle).some(name => /Mcp|GetAssetCatalogTool/.test(name)), 'Offline ZIP remains independent of Unity MCP.');
  await assert.rejects(createExportBundle(project(), scan, '// importer', '// connection', '// marker', '// fixture', undefined, undefined, undefined,
    { runtime: '// map asset', editor: '// multi edit', catalog: '// asset catalog' }), /모두 필요/);
  const incomplete = project();
  incomplete.map.connections = [];
  await assert.rejects(createExportBundle(incomplete, scan, '// importer', '// runtime', '// marker fixture', '// fixture metadata'), /맵 오류/);
});

test('v2 export retains real elevations and stair placement rotation with explicit geometry instructions', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'Assets/stair.prefab'), 'local stair geometry');
  await writeFile(path.join(root, 'Assets/stair.prefab.meta'), `guid: ${'c'.repeat(32)}`);
  const scan = await scanUnityProject(root);
  const files = unzipSync(await createExportBundle(raisedProject(), scan, '// importer fixture', '// runtime fixture', '// marker fixture', '// fixture metadata'));
  const manifest = JSON.parse(strFromU8(files['Map.baekhomap.json']));
  const stair = manifest.placements.find((placement: { role: string }) => placement.role === 'stair');
  assert.equal(stair.rotation.y, 90);
  assert.equal(stair.position.y, 0);
  assert.equal(stair.prefabGuid, 'c'.repeat(32));
  assert.deepEqual(stair.scale, { x: 1.5, y: 4, z: 2 });
  assert.ok(manifest.placements.some((placement: { role: string; position: { y: number } }) => placement.role === 'floor' && placement.position.y === 2));
  assert.match(strFromU8(files['README.txt']), /Y 스케일은 rise \/ stairNativeRise로 자동 계산/);
  assert.match(strFromU8(files['README.txt']), /maxStepHeight/);
});

test('AI connection count is bounded and returned maps must match count with no local asset overrides', async t => {
  for (const connectionCount of [0,17,1.5,NaN]) assert.throws(() => validateSettings({...SETTINGS,connectionCount}), /연결문 수/);
  const {client,fake}=await codexFixture(t);
  fake.layout(MAP);
  await assert.rejects(client.extractLayout({...SETTINGS,connectionCount:2},PNG),/연결문 수/);
  fake.layout({...MAP,assetOverrides:[{x:1,row:1,role:'floor',bindingId:'floor'}]});
  await assert.rejects(client.extractLayout(SETTINGS,PNG),/AI 배치도는 셀 에셋/);
  fake.layout({...MAP,rows:['#D######','#S.....#',...MAP.rows.slice(2)]});
  await assert.rejects(client.extractLayout(SETTINGS,PNG),/허용되지 않는 문자/);
});

test('native serialization preserves multiple same-role assets and cell overrides without leaking unknown data', () => {
  const input=project();
  input.bindings.push({...input.bindings[0],id:'floor-variant',label:'Floor variant',offset:{x:1,y:2,z:3}});
  input.map.assetOverrides=[{x:1,row:1,role:'floor',bindingId:'floor-variant'}];
  const result=normalizeProject(JSON.parse(serializeProject(input)));
  assert.deepEqual(result.map.connections,input.map.connections);assert.deepEqual(result.map.assetOverrides,input.map.assetOverrides);
  assert.equal(result.bindings.filter(item=>item.role==='floor').length,2);
  assert.equal(result.bindings[3].label,'Floor variant');
  assert.throws(()=>normalizeProject({...input,bindings:input.bindings.slice(0,3)}),/bindingId/);
});

test('export requires runtime component and emits selected cell asset transforms', async t => {
  const root=await fixture(t),scan=await scanUnityProject(root),input=project();
  input.bindings.push({...input.bindings[0],id:'floor-variant',label:'Floor variant',offset:{x:1,y:2,z:3}});
  input.map.assetOverrides=[{x:1,row:1,role:'floor',bindingId:'floor-variant'}];
  await assert.rejects(createExportBundle(input,scan,'// importer','','// marker fixture','// fixture metadata'),/런타임 스크립트/);
  await assert.rejects(createExportBundle(input,scan,'// importer','// runtime','','// fixture metadata'),/런타임 스크립트/);
  await assert.rejects(createExportBundle(input,scan,'// importer','// runtime','// marker fixture',''),/런타임 스크립트/);
  const bundle=unzipSync(await createExportBundle(input,scan,'// importer','// runtime','// marker fixture','// fixture metadata'));
  const manifest=JSON.parse(strFromU8(bundle['Map.baekhomap.json']));
  assert.deepEqual(manifest.placements.find((item:{id:string})=>item.id==='floor-1-1').position,{x:-4,y:2,z:8});
  assert.deepEqual(manifest.connections[0].position,{x:-5,y:0,z:8});
});
