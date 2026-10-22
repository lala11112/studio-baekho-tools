import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { UnityBridgeService } from '../electron/services/unity-bridge';
import { connectUnityMcp, DEFAULT_UNITY_ENDPOINT, validatedUnityEndpoint, type UnityMcpClient } from '../electron/services/unity-mcp';
import { scanUnityProject } from '../electron/services/unity-project';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import type { ProjectFile, UnityBuildStatus } from '../src/shared/types';

type Call = { name: string; parameters: Record<string, unknown>; timeout?: number };
class FakeUnity implements UnityMcpClient {
  calls: Call[] = [];
  roots = new Map<string, string>();
  active = 'selected';
  hasAdapter = false;
  playing = false;
  compiling = false;
  consoleErrors: string[] = [];
  dropBuild = false;
  dropCatalog = false;
  catalog: unknown = { format: 'baekho-asset-catalog', version: 1, assets: [], skipped: [] };
  recoveryState: 'completed' | 'unknown' | 'running' | 'failed' = 'completed';
  failInfoAfterRefresh = false;
  infoFailures = 0;
  buildState: 'completed' | 'failed' = 'completed';
  output = { prefabPath: 'Assets/Baekho/Generated/Test dungeon/Test dungeon.prefab', navMeshPath: 'Assets/Baekho/Generated/Test dungeon/Test dungeon.NavMesh.asset' };
  connects: string[] = [];
  constructor(root: string) { this.roots.set('selected', root); }
  async readResource(uri: string): Promise<unknown> {
    if (uri.endsWith('/instances')) return { success: true, instances: [...this.roots].map(([id]) => ({ id })) };
    if (uri.endsWith('/project/info')) {
      if (this.infoFailures > 0) { this.infoFailures--; throw new Error('domain reloading'); }
      return { success: true, data: { projectRoot: this.roots.get(this.active) } };
    }
    if (uri.endsWith('/editor/state')) return { success: true, data: {
      compilation: { is_compiling: this.compiling }, editor: { play_mode: { is_playing: this.playing } },
      advice: { ready_for_tools: false, blocking_reasons: ['stale_status'] },
    } };
    if (uri.endsWith('/custom-tools')) return { success: true, data: { tools: this.hasAdapter ? [{ name: 'baekho_build_map' }, { name: 'baekho_get_asset_catalog' }] : [] } };
    throw new Error(`Unexpected resource ${uri}`);
  }
  async callTool(name: string, parameters: Record<string, unknown>, timeout?: number): Promise<unknown> {
    this.calls.push({ name, parameters, timeout });
    if (name === 'set_active_instance') { this.active = String(parameters.instance); return { success: true }; }
    if (name === 'read_console') return { success: true, data: this.consoleErrors.map(message => ({ message })) };
    if (name === 'refresh_unity') { this.hasAdapter = true; if (this.failInfoAfterRefresh) this.infoFailures = 1; return { result: { success: true } }; }
    if (name === 'execute_custom_tool') {
      if (parameters.tool_name === 'baekho_get_asset_catalog') {
        if (this.dropCatalog) throw new Error('catalog socket disconnected');
        return { success: true, data: { catalog: this.catalog } };
      }
      assert.equal(parameters.tool_name, 'baekho_build_map');
      const input = parameters.parameters as Record<string, unknown>;
      if (input.action === 'build' && this.dropBuild) throw new Error('socket disconnected after Unity accepted request');
      const state = input.action === 'status' ? this.recoveryState : this.buildState;
      return { success: true, data: { requestId: input.requestId, state, message: `Unity ${state}`,
        ...(state === 'completed' ? this.output : { prefabPath: null, navMeshPath: null }),
      } };
    }
    throw new Error(`Unexpected tool ${name}`);
  }
  close(): void { /* Reconnection uses another session in production; this fake retains editor state. */ }
  buildCalls(): Call[] { return this.calls.filter(call => call.name === 'execute_custom_tool' && (call.parameters.parameters as Record<string, unknown>).action === 'build'); }
  statusCalls(): Call[] { return this.calls.filter(call => call.name === 'execute_custom_tool' && (call.parameters.parameters as Record<string, unknown>).action === 'status'); }
  catalogCalls(): Call[] { return this.calls.filter(call => call.parameters.tool_name === 'baekho_get_asset_catalog'); }
}
async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'baekho-unity-bridge-'));
  const root = path.join(base, 'UnityProject');
  const dataDirectory = path.join(base, 'app-data');
  const services: UnityBridgeService[] = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('baekho-unity-bridge-'));
    await rm(base, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'Assets'), { recursive: true });
  await mkdir(path.join(root, 'ProjectSettings'));
  await mkdir(path.join(root, 'Packages'));
  await writeFile(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.unity.ai.navigation': '2.0.9', 'com.coplaydev.unity-mcp': 'local' } }));
  const input: ProjectFile = { formatVersion: 1, settings: structuredClone(DEFAULT_SETTINGS), bindings: [], map: {
    version: 3, name: 'Test dungeon', width: 8, height: 8, cellSize: 2,
    rows: ['#D######', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
    connections: [{ id: 'north', label: 'North', x: 1, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [],
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], maxStepHeight: .4,
  } };
  for (const [role, letter] of [['floor', 'a'], ['wall', 'b'], ['door', 'c']] as const) {
    const prefabPath = `Assets/${role}.prefab`, guid = letter.repeat(32);
    await writeFile(path.join(root, prefabPath), 'prefab fixture');
    await writeFile(path.join(root, `${prefabPath}.meta`), `guid: ${guid}\n`);
    input.bindings.push({ id: role, label: role, role, prefabGuid: guid, prefabPath, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 });
  }
  const scan = await scanUnityProject(root);
  const fake = new FakeUnity(root);
  const create = () => {
    const service = new UnityBridgeService({ dataDirectory, resourceDirectory: path.resolve('unity-importer'), pollIntervalMs: 1, compilationTimeoutMs: 1000,
      connect: async endpoint => { fake.connects.push(endpoint); return fake; } });
    services.push(service);
    return service;
  };
  return { root, dataDirectory, input, scan, fake, create, service: create() };
}
async function finished(service: UnityBridgeService, requestId: string): Promise<UnityBuildStatus> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = await service.getBuild(requestId);
    if (status.state !== 'running') return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture build did not finish');
}

function assetCatalog() {
  return { format: 'baekho-asset-catalog', version: 1, assets: [
    { guid: 'a'.repeat(32), path: 'Assets/floor.prefab', role: 'floor', size: { x: 2, y: .2, z: 2 }, bounds: { center: { x: 0, y: -.1, z: 0 }, size: { x: 2, y: .2, z: 2 } } },
    { guid: 'c'.repeat(32), path: 'Assets/door.prefab', role: 'door', size: { x: 1, y: 3, z: .2 }, bounds: { center: { x: 0, y: 1.5, z: 0 }, size: { x: 1, y: 3, z: .2 } }, label: 'Entrance' },
  ], skipped: [{ path: 'Assets/wall.prefab', reason: '종류를 지정해 주세요.' }] };
}

test('marked prefab catalog installs registration scripts and queries the selected project without Navigation', async t => {
  const { service, fake, root, scan } = await fixture(t);
  await writeFile(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
  fake.catalog = assetCatalog();
  const result = await service.importUnityAssetCatalog(scan);
  assert.equal(result.catalog.assets.length, 2);
  assert.deepEqual(result.catalog.skipped, assetCatalog().skipped);
  assert.equal(result.scan.assets.length, 3);
  assert.equal(result.scan.projectPath, await realpath(root));
  assert.deepEqual(scan.assets, result.scan.assets);
  assert.equal(fake.catalogCalls().length, 1);
  const call = fake.catalogCalls()[0];
  assert.equal((call.parameters.parameters as Record<string, unknown>).expectedProjectRoot, await realpath(root));
  assert.equal(call.timeout, 120_000);
  assert.equal(fake.buildCalls().length, 0);
  assert.ok(await readFile(path.join(root, 'Assets/Baekho/Runtime/BaekhoMapAsset.cs'), 'utf8'));
  assert.ok(await readFile(path.join(root, 'Assets/Baekho/Editor/BaekhoGetAssetCatalogTool.cs'), 'utf8'));
});

test('catalog import rescans moved prefabs and rejects stale GUID/path provenance atomically', async t => {
  const { service, fake, root, scan } = await fixture(t);
  const catalog = assetCatalog();
  await rename(path.join(root, 'Assets/floor.prefab'), path.join(root, 'Assets/moved-floor.prefab'));
  await rename(path.join(root, 'Assets/floor.prefab.meta'), path.join(root, 'Assets/moved-floor.prefab.meta'));
  catalog.assets[0].path = 'Assets/moved-floor.prefab';
  fake.catalog = catalog;
  const result = await service.importUnityAssetCatalog(scan);
  assert.equal(result.scan.assets.find(asset => asset.guid === 'a'.repeat(32))!.path, 'Assets/moved-floor.prefab');
  assert.equal(scan.assets.find(asset => asset.guid === 'a'.repeat(32))!.path, 'Assets/floor.prefab');
  await writeFile(path.join(root, 'Assets/moved-floor.prefab.meta'), `guid: ${'e'.repeat(32)}\n`);
  await assert.rejects(service.importUnityAssetCatalog(result.scan), /최신 프로젝트 스캔/);
  assert.equal(result.scan.assets.find(asset => asset.path === 'Assets/moved-floor.prefab')!.guid, 'a'.repeat(32));
});

test('wrong project, busy editor and missing connection cannot query or install a catalog', async t => {
  const { service, fake, root, scan } = await fixture(t);
  await assert.rejects(service.importUnityAssetCatalog(null), /프로젝트 폴더/);
  fake.roots.set('selected', path.dirname(root));
  await assert.rejects(service.importUnityAssetCatalog(scan), /일치하지 않습니다/);
  fake.roots.set('selected', root);
  fake.compiling = true;
  await assert.rejects(service.importUnityAssetCatalog(scan), /컴파일/);
  fake.compiling = false;
  fake.playing = true;
  await assert.rejects(service.importUnityAssetCatalog(scan), /Play Mode/);
  fake.playing = false;
  fake.consoleErrors = ['error CS1002: ; expected'];
  await assert.rejects(service.importUnityAssetCatalog(scan), /CS1002/);
  fake.consoleErrors = [];
  fake.roots.clear();
  await assert.rejects(service.importUnityAssetCatalog(scan), /Unity 인스턴스/);
  assert.equal(fake.catalogCalls().length, 0);
  await assert.rejects(readFile(path.join(root, 'Assets/Baekho/Runtime/BaekhoMapAsset.cs')), { code: 'ENOENT' });
});

test('catalog response loss and invalid schema never return or mutate a partial scan/catalog', async t => {
  const { service, fake, scan } = await fixture(t);
  const before = structuredClone(scan);
  fake.dropCatalog = true;
  await assert.rejects(service.importUnityAssetCatalog(scan), /등록은 변경하지 않았습니다/);
  assert.equal(fake.catalogCalls().length, 1);
  assert.deepEqual(scan, before);
  fake.dropCatalog = false;
  fake.catalog = { ...assetCatalog(), version: 99 };
  await assert.rejects(service.importUnityAssetCatalog(scan));
  assert.deepEqual(scan, before);
  fake.catalog = { ...assetCatalog(), assets: [...assetCatalog().assets, { ...assetCatalog().assets[0], size: { x: 0, y: 1, z: 1 } }] };
  await assert.rejects(service.importUnityAssetCatalog(scan));
  assert.deepEqual(scan, before);
  assert.equal(fake.buildCalls().length, 0);
});

test('catalog installation preserves customized registration scripts and reports their paths', async t => {
  const { service, fake, root, scan } = await fixture(t);
  const runtime = path.join(root, 'Assets/Baekho/Runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'BaekhoMapAsset.cs'), '// customized catalog metadata');
  await writeFile(path.join(runtime, 'BaekhoMapAsset.cs.meta'), 'guid: existing-registration');
  fake.catalog = assetCatalog();
  const result = await service.importUnityAssetCatalog(scan);
  assert.ok(result.warnings.some(warning => warning.includes('BaekhoMapAsset.cs')));
  assert.equal(await readFile(path.join(runtime, 'BaekhoMapAsset.cs'), 'utf8'), '// customized catalog metadata');
  assert.equal(await readFile(path.join(runtime, 'BaekhoMapAsset.cs.meta'), 'utf8'), 'guid: existing-registration');
});

test('catalog import reconnects after compilation and never bypasses an unresolved build', async t => {
  const { service, fake, scan, input } = await fixture(t);
  fake.failInfoAfterRefresh = true;
  fake.catalog = assetCatalog();
  assert.equal((await service.importUnityAssetCatalog(scan)).catalog.assets.length, 2);
  assert.ok(fake.connects.length >= 3);
  fake.dropBuild = true;
  fake.recoveryState = 'unknown';
  const started = await service.startBuild(input, scan);
  assert.equal((await finished(service, started.requestId)).state, 'unknown');
  const before = fake.catalogCalls().length;
  await assert.rejects(service.importUnityAssetCatalog(scan), /이전 생성 요청/);
  assert.equal(fake.catalogCalls().length, before);
  assert.equal(fake.buildCalls().length, 1);
});

test('Unity endpoint accepts only local unauthenticated HTTP and settings survive service restart', async t => {
  assert.equal(validatedUnityEndpoint(), DEFAULT_UNITY_ENDPOINT);
  for (const invalid of ['https://127.0.0.1:8080/mcp', 'http://remote.example/mcp', 'http://localhost.evil/mcp', 'http://u:p@localhost/mcp', 'http://localhost/mcp?token=secret', 'file:///tmp/socket'])
    assert.throws(() => validatedUnityEndpoint(invalid));
  const { service, fake, create } = await fixture(t);
  const first = await service.getStatus(null, 'http://localhost:9090/mcp');
  assert.equal(first.state, 'no-project');
  assert.equal(fake.connects.length, 0);
  assert.equal((await create().getStatus(null)).endpoint, 'http://localhost:9090/mcp');
});

test('project mismatch aborts setup and build before writing anything to Unity', async t => {
  const { service, fake, root, scan, input } = await fixture(t);
  fake.roots.set('selected', path.dirname(root));
  assert.equal((await service.getStatus(scan)).state, 'mismatch');
  assert.equal((await service.prepare(scan)).state, 'mismatch');
  const started = await service.startBuild(input, scan);
  assert.equal((await finished(service, started.requestId)).state, 'failed');
  await assert.rejects(readFile(path.join(root, 'Assets/Baekho/Editor/BaekhoMapImporter.cs')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'Library/BaekhoMapForge/integration.json')), { code: 'ENOENT' });
  assert.equal(fake.buildCalls().length, 0);
});

test('Play Mode and compile errors prevent setup writes; AI Navigation is required only for a build', async t => {
  const { service, fake, root, scan, input } = await fixture(t);
  fake.playing = true;
  assert.match((await service.prepare(scan)).message, /Play Mode/);
  fake.playing = false;
  fake.consoleErrors = ['Assets/Broken.cs(1,3): error CS1002: ; expected'];
  assert.match((await service.prepare(scan)).message, /CS1002/);
  fake.consoleErrors = [];
  fake.compiling = true;
  assert.equal((await service.prepare(scan)).state, 'busy');
  fake.compiling = false;
  await assert.rejects(readFile(path.join(root, 'Assets/Baekho/Editor/BaekhoMapImporter.cs')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
  assert.match((await service.getStatus(scan)).message, /AI Navigation/);
  const build = await service.startBuild(input, scan);
  assert.match((await finished(service, build.requestId)).message, /AI Navigation/);
  await assert.rejects(readFile(path.join(root, 'Assets/Baekho/Editor/BaekhoMapImporter.cs')), { code: 'ENOENT' });
  assert.equal((await service.prepare(scan)).state, 'ready');
  assert.ok(await readFile(path.join(root, 'Assets/Baekho/Runtime/BaekhoMapAsset.cs'), 'utf8'));
});

test('standalone start selects authoritative project, prepares integration and builds with a 15 minute deadline', async t => {
  const { service, fake, root, scan, input } = await fixture(t);
  fake.roots = new Map([['wrong', path.dirname(root)], ['selected', root]]);
  assert.equal((await service.getStatus(scan)).state, 'needs-setup');
  const started = await service.startBuild(input, scan);
  assert.equal(started.state, 'running');
  const done = await finished(service, started.requestId);
  assert.equal(done.state, 'completed');
  assert.match(done.prefabPath!, /\.prefab$/);
  assert.equal(fake.buildCalls().length, 1);
  const call = fake.buildCalls()[0], params = call.parameters.parameters as Record<string, unknown>;
  assert.equal(call.timeout, 900_000);
  assert.equal(params.timeout_seconds, 900);
  assert.equal(params.expectedProjectRoot, await realpath(root));
  assert.equal(params.manifestPath, 'Assets/Baekho/Generated/Test dungeon/Map.baekhomap.json');
  const bytes = await readFile(path.join(root, String(params.manifestPath)));
  assert.equal(params.inputHash, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(fake.calls.some(call => call.name === 'refresh_unity'));
  assert.equal((await service.getStatus(scan)).state, 'ready');
});

test('simultaneous starts dispatch only one build and do not reroute an active request', async t => {
  const { service, fake, scan, input } = await fixture(t);
  const results = await Promise.allSettled([service.startBuild(input, scan), service.startBuild(input, scan)]);
  const succeeded = results.filter(result => result.status === 'fulfilled');
  assert.equal(succeeded.length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const started = (succeeded[0] as PromiseFulfilledResult<UnityBuildStatus>).value;
  const status = await service.getStatus(scan, 'http://localhost:9999/mcp');
  assert.equal(status.state, 'busy');
  assert.equal(status.requestId, started.requestId);
  assert.equal((await finished(service, started.requestId)).state, 'completed');
  assert.ok(fake.connects.every(endpoint => endpoint === DEFAULT_UNITY_ENDPOINT));
  assert.equal(fake.buildCalls().length, 1);
});

test('GUID provenance is checked before opening MCP or writing integration files', async t => {
  const { service, fake, root, scan, input } = await fixture(t);
  await writeFile(path.join(root, 'Assets/floor.prefab.meta'), `guid: ${'f'.repeat(32)}\n`);
  await assert.rejects(service.startBuild(input, scan), /다시 스캔/);
  assert.equal(fake.connects.length, 0);
  await assert.rejects(readFile(path.join(root, 'Library/BaekhoMapForge/integration.json')), { code: 'ENOENT' });
});

test('setup preserves existing user scripts and meta while surfacing installation warnings', async t => {
  const { service, root, scan } = await fixture(t);
  const folder = path.join(root, 'Assets/Baekho/Runtime');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'BaekhoMapConnection.cs'), '// Custom door metadata');
  await writeFile(path.join(folder, 'BaekhoMapConnection.cs.meta'), 'guid: custom-guid');
  const prepared = await service.prepare(scan);
  assert.equal(prepared.state, 'ready');
  assert.ok(prepared.warnings?.some(warning => warning.includes('BaekhoMapConnection.cs')));
  assert.equal(await readFile(path.join(folder, 'BaekhoMapConnection.cs'), 'utf8'), '// Custom door metadata');
  assert.equal(await readFile(path.join(folder, 'BaekhoMapConnection.cs.meta'), 'utf8'), 'guid: custom-guid');
});

test('lost build response recovers the same persisted ID after restart using status only', async t => {
  const { service, fake, scan, input, create } = await fixture(t);
  fake.dropBuild = true;
  fake.recoveryState = 'unknown';
  const started = await service.startBuild(input, scan);
  const uncertain = await finished(service, started.requestId);
  assert.equal(uncertain.state, 'unknown');
  assert.equal(fake.buildCalls().length, 1);
  assert.equal((await service.startBuild(input, scan)).requestId, started.requestId);
  await service.close();
  const restarted = create();
  const connection = await restarted.getStatus(scan);
  assert.equal(connection.state, 'busy');
  assert.equal(connection.requestId, started.requestId);
  fake.recoveryState = 'completed';
  const done = await restarted.getBuild(started.requestId);
  assert.equal(done.state, 'completed');
  assert.equal(done.requestId, started.requestId);
  assert.equal(fake.buildCalls().length, 1);
  assert.ok(fake.statusCalls().length >= 1);
  assert.equal(await restarted.getBuild(started.requestId).then(status => status.state), 'completed');
});

test('recovery revalidates the recorded project before asking Unity for status', async t => {
  const { service, fake, scan, input, root } = await fixture(t);
  fake.dropBuild = true;
  fake.recoveryState = 'unknown';
  const started = await service.startBuild(input, scan);
  await finished(service, started.requestId);
  const before = fake.statusCalls().length;
  fake.roots.set('selected', path.dirname(root));
  assert.equal((await service.getBuild(started.requestId)).state, 'unknown');
  assert.equal(fake.statusCalls().length, before);
  assert.equal(fake.buildCalls().length, 1);
  assert.equal((await service.startBuild(input, scan)).requestId, started.requestId);
});

test('unreadable request journal fails closed instead of risking duplicate builds', async t => {
  const { dataDirectory, create, scan, input, fake } = await fixture(t);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path.join(dataDirectory, 'unity-builds.json'), '{broken');
  const service = create();
  await assert.rejects(service.startBuild(input, scan), /중복 생성/);
  assert.equal(fake.buildCalls().length, 0);
});

test('a syntactically valid journal with invalid unresolved records also fails closed', async t => {
  const { dataDirectory, create, scan, input, fake } = await fixture(t);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path.join(dataDirectory, 'unity-builds.json'), JSON.stringify([{ requestId: 'broken', state: 'unknown', submitted: true }]));
  const service = create();
  await assert.rejects(service.startBuild(input, scan), /중복 생성/);
  assert.equal(fake.buildCalls().length, 0);
});

test('a domain reload that temporarily hides project info is retried during preparation', async t => {
  const { service, fake, scan, input } = await fixture(t);
  fake.failInfoAfterRefresh = true;
  const started = await service.startBuild(input, scan);
  assert.equal((await finished(service, started.requestId)).state, 'completed');
  assert.ok(fake.connects.length >= 3);
  assert.equal(fake.buildCalls().length, 1);
});

test('a failed Unity receipt with null output paths is terminal and permits a fresh request', async t => {
  const { service, fake, scan, input } = await fixture(t);
  fake.buildState = 'failed';
  const first = await service.startBuild(input, scan);
  const failed = await finished(service, first.requestId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.prefabPath, undefined);
  fake.buildState = 'completed';
  const second = await service.startBuild(input, scan);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal((await finished(service, second.requestId)).state, 'completed');
  assert.equal(fake.buildCalls().length, 2);
});

test('valid consecutive dots in a map basename are accepted as a completed output', async t => {
  const { service, fake, scan, input } = await fixture(t);
  input.map.name = 'Dungeon..v2';
  fake.output = { prefabPath: 'Assets/Baekho/Generated/Dungeon--v2/Dungeon..v2.prefab', navMeshPath: 'Assets/Baekho/Generated/Dungeon--v2/Dungeon..v2.NavMesh.asset' };
  const started = await service.startBuild(input, scan);
  const done = await finished(service, started.requestId);
  assert.equal(done.state, 'completed');
  assert.equal(done.prefabPath, fake.output.prefabPath);
  assert.equal(done.navMeshPath, fake.output.navMeshPath);
});

test('traversal segments, wrong output roots and wrong extensions remain protected as unknown', async t => {
  const invalid = [
    { prefabPath: 'Assets/Baekho/Generated/Test dungeon/../outside.prefab' },
    { prefabPath: 'Assets/Baekho/Generated/Test dungeon/./output.prefab' },
    { prefabPath: 'Assets/Other/output.prefab' },
    { prefabPath: 'Assets/Baekho/Generated/Test dungeon/output.asset' },
    { navMeshPath: 'Assets/Baekho/Generated/Test dungeon/output.prefab' },
  ];
  for (const paths of invalid) await t.test(JSON.stringify(paths), async child => {
    const { service, fake, scan, input } = await fixture(child);
    Object.assign(fake.output, paths);
    const started = await service.startBuild(input, scan);
    const uncertain = await finished(service, started.requestId);
    assert.equal(uncertain.state, 'unknown');
    assert.match(uncertain.error!, /생성 폴더 밖/);
    assert.equal((await service.startBuild(input, scan)).requestId, started.requestId);
    assert.equal(fake.buildCalls().length, 1);
  });
});

test('the SDK transport decodes resources and never replays a tool request after a dropped response', async t => {
  let builds = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { id?: number; method: string };
    if (rpc.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (rpc.method === 'tools/call') { builds++; request.socket.destroy(); return; }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { resources: {}, tools: {} }, serverInfo: { name: 'unity-test', version: '1' } }
      : { contents: [{ uri: 'mcpforunity://instances', mimeType: 'application/json', text: JSON.stringify({ success: true, instances: [{ id: 'fixture' }] }) }] };
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'unity-test' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const client = await connectUnityMcp(`http://127.0.0.1:${port}/mcp`);
  t.after(() => client.close());
  assert.deepEqual(await client.readResource('mcpforunity://instances'), { success: true, instances: [{ id: 'fixture' }] });
  await assert.rejects(client.callTool('execute_custom_tool', { tool_name: 'baekho_build_map', parameters: { action: 'build' } }, 1000));
  assert.equal(builds, 1);
});
