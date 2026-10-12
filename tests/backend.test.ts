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
import { decodePngDataUrl, validateSettings } from '../electron/services/validation';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import type { AssetBinding, AssetRole, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_BASE64}`;
const SETTINGS: GenerationSettings = { ...DEFAULT_SETTINGS, width: 8, height: 8, connectionCount: 1 };
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

async function codexFixture(t: TestContext, fake = new FakeCodex(), timeoutMs = 1000): Promise<{ client: CodexService; fake: FakeCodex; root: string }> {
  const root = await fixture(t);
  const client = new CodexService({ dataDirectory: path.join(root, 'codex'), timeoutMs,
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

test('Codex generates native PNG then vision structured JSON using ephemeral isolated threads', async t => {
  const { client, fake, root } = await codexFixture(t);
  assert.equal((await client.getStatus()).state, 'ready');
  const image = await client.generateImage(SETTINGS);
  assert.equal(image, PNG);
  fake.layout(MAP);
  const result = await client.extractLayout(SETTINGS, image);
  assert.deepEqual(result, MAP);
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
  assert.match(String(layoutInput[0].text), /version must be 3/);
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

test('vision extraction preserves a raised platform and rejects a stair that cannot reach its landing', async t => {
  const { client, fake } = await codexFixture(t);
  const raised = raisedProject().map;
  fake.layout(raised);
  assert.deepEqual(await client.extractLayout(SETTINGS, PNG), raised);
  const mismatch = structuredClone(raised);
  mismatch.ramps[0].rise = 1;
  fake.layout(mismatch);
  await assert.rejects(client.extractLayout(SETTINGS, PNG), /검증을 통과하지 못했습니다/);
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

test('Codex aborts requests after timeout', async t => {
  const fake = new FakeCodex();
  fake.hang = true;
  const { client } = await codexFixture(t, fake, 15);
  await assert.rejects(client.generateImage(SETTINGS), /5분 안에 완료되지 않았습니다/);
  assert.equal(fake.closed, true);
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
  assert.deepEqual(await readProject(filePath), incomplete);
  await writeFile(filePath, 'not JSON');
  await assert.rejects(readProject(filePath), /프로젝트 JSON/);
});

test('v2 project persistence preserves editable heights, ramp direction, rise and movement settings', async t => {
  const root = await fixture(t);
  const original = raisedProject();
  const filePath = path.join(root, 'Raised.baekho.json');
  await atomicWrite(filePath, serializeProject(original));
  const reopened = await readProject(filePath);
  assert.deepEqual(reopened, original);
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
  assert.equal(migrated.map.version, 3);
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
  const files = unzipSync(await createExportBundle(project(), scan, '// importer fixture', '// runtime fixture'));
  assert.deepEqual(Object.keys(files).sort(), ['Map.baekhomap.json', 'README.txt', 'Unity/Editor/BaekhoMapImporter.cs', 'Unity/Runtime/BaekhoMapConnection.cs', 'blueprint.png'].sort());
  const manifest = JSON.parse(strFromU8(files['Map.baekhomap.json']));
  assert.equal(manifest.schemaVersion, 3);
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
  const incomplete = project();
  incomplete.map.connections = [];
  await assert.rejects(createExportBundle(incomplete, scan, '// importer', '// runtime'), /맵 오류/);
});

test('v2 export retains real elevations and stair placement rotation with explicit geometry instructions', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'Assets/stair.prefab'), 'local stair geometry');
  await writeFile(path.join(root, 'Assets/stair.prefab.meta'), `guid: ${'c'.repeat(32)}`);
  const scan = await scanUnityProject(root);
  const files = unzipSync(await createExportBundle(raisedProject(), scan, '// importer fixture', '// runtime fixture'));
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
  await assert.rejects(createExportBundle(input,scan,'// importer',''),/런타임 스크립트/);
  const bundle=unzipSync(await createExportBundle(input,scan,'// importer','// runtime'));
  const manifest=JSON.parse(strFromU8(bundle['Map.baekhomap.json']));
  assert.deepEqual(manifest.placements.find((item:{id:string})=>item.id==='floor-1-1').position,{x:-4,y:2,z:8});
  assert.deepEqual(manifest.connections[0].position,{x:-5,y:0,z:8});
});
