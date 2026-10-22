import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createDemoMap, DEFAULT_SETTINGS } from '../Apps/AutoMapPrefabMaker/src/shared/map.ts';

// Local fixtures only. Never invoke generation, login, or a paid provider.
const root = process.cwd();
const runtime = path.resolve('artifacts/integration-runtime', `updates-${Date.now()}`);
const profile = path.join(runtime, 'profile');
fs.mkdirSync(path.join(profile, 'bgm/media'), { recursive: true });
const mp3 = Buffer.alloc(834);
mp3.set([0xff, 0xfb, 0x90, 0], 0); mp3.set([0xff, 0xfb, 0x90, 0], 417);
const candidate = { id: 'mock-audio', batchId: 'mock-batch', requestId: 'mock-request', index: 1, prompt: 'Synthetic export fixture; not generated music', status: 'ready', createdAt: new Date().toISOString(), estimatedCostUsd: .04, revision: 1 };
fs.writeFileSync(path.join(profile, 'bgm/media/mock-audio.mp3'), mp3);
fs.writeFileSync(path.join(profile, 'bgm/ledger.json'), JSON.stringify({ version: 1, candidates: [candidate], totalReservedUsd: .04 }));
const fixture = { formatVersion: 1, map: createDemoMap(), settings: structuredClone(DEFAULT_SETTINGS), bindings: [] };
fixture.map.name = 'Isolated integration fixture';
const env = { ...process.env, BAEKHO_DATA: profile, PARTSMITH_DATA: profile, FAL_KEY: '', OPENAI_API_KEY: '', TRIPO_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL;
const packagedIndex = process.argv.indexOf('--packaged');
const packaged = packagedIndex >= 0 ? path.resolve(process.argv[packagedIndex + 1]) : null;
const app = await electron.launch({ executablePath: packaged || electronPath, args: packaged ? [] : ['.'], env, timeout: 45000 });
const errors = [], network = [], checks = [];
let unityMock;
const unityRequests = [];
async function startUnityMock(projectRoot) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    unityRequests.push({ method: message.method, params: message.params });
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const resource = {
      'mcpforunity://instances': { instances: [{ id: 'integration-fixture' }] },
      'mcpforunity://project/info': { projectRoot },
      'mcpforunity://editor/state': { compilation: {}, editor: { play_mode: {} }, assets: {} },
    };
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { resources: {}, tools: {} }, serverInfo: { name: 'isolated-unity-fixture', version: '1' } };
    else if (message.method === 'resources/read' && resource[message.params.uri]) result = { contents: [{ uri: message.params.uri, mimeType: 'application/json', text: JSON.stringify(resource[message.params.uri]) }] };
    else if (message.method === 'tools/call' && message.params.name === 'set_active_instance') result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    else if (message.method === 'tools/call' && message.params.name === 'read_console') result = { content: [{ type: 'text', text: JSON.stringify({ data: [] }) }] };
    else if (message.method === 'ping') result = {};
    const payload = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture forbids unrecognized operations' } };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  unityMock = server;
  return `http://127.0.0.1:${server.address().port}/mcp`;
}
app.context().on('page', p => p.on('pageerror', e => errors.push(e.message)));
try {
  await app.evaluate(({ session }) => {
    for (const s of [session.defaultSession, session.fromPartition('map-forge')]) {
      s.webRequest.onBeforeRequest({ urls: ['https://*.fal.run/*', 'https://fal.media/*', 'https://*.fal.media/*'] }, (_details, callback) => callback({ cancel: true }));
    }
  });
  const shell = await app.firstWindow();
  for (const tool of ['map', 'modeling', 'four-tiger-items', 'bgm', 'combat', 'hit-timing']) await shell.getByTestId(`tool-${tool}`).waitFor();
  checks.push('all six tools remain reachable');
  await shell.getByTestId('tool-map').click();
  const map = await app.waitForEvent('window', { predicate: p => p !== shell, timeout: 10000 }).catch(() => app.context().pages().find(p => p !== shell && p.url().includes('AutoMapPrefabMaker')));
  assert.ok(map);
  await map.locator('#mapName').waitFor();
  assert.deepEqual(await map.evaluate(() => [typeof window.require, typeof window.studio, typeof window.desktop, typeof window.baekho?.saveProject]), ['undefined', 'undefined', 'undefined', 'function']);
  assert.equal(await shell.evaluate(() => typeof window.baekho), 'undefined');
  assert.deepEqual(await map.evaluate(() => ['generateConcept', 'getUnityStatus', 'prepareUnityIntegration', 'startUnityPrefabBuild', 'getUnityPrefabBuild', 'importUnityAssetCatalog'].map(key => typeof window.baekho[key])), Array(6).fill('function'));
  assert.equal((await map.evaluate(() => window.baekho.getUnityStatus())).state, 'no-project');
  assert.equal((await map.evaluate(() => window.baekho.prepareUnityIntegration())).state, 'no-project');
  assert.equal(fs.existsSync(path.join(profile, 'unity')), false, 'map Unity storage never escapes the map profile');
  checks.push('latest map Unity IPC is available and requires an explicit project before preparation');
  await map.locator('#mapName').fill('Unsent map draft');
  await map.locator('#mapName').press('Tab');
  await shell.getByTestId('tool-map').click();
  assert.equal(await map.locator('#mapName').inputValue(), 'Unsent map draft');
  assert.equal(app.context().pages().filter(p => p.url().includes('AutoMapPrefabMaker')).length, 1);
  checks.push('map window reused with unsaved draft and isolated bridges');

  const projectFile = path.join(runtime, 'saved-map.json');
  const bundleFile = path.join(runtime, 'map-export.zip');
  const bgmFile = path.join(runtime, 'audio-export.mp3');
  await app.evaluate(({ dialog }, paths) => {
    globalThis.__savePaths = paths;
    globalThis.__saveOriginal = dialog.showSaveDialog;
    globalThis.__openOriginal = dialog.showOpenDialog;
    globalThis.__messageOriginal = dialog.showMessageBoxSync;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.__savePaths.shift() });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[0]] });
    dialog.showMessageBoxSync = () => 0;
  }, [projectFile, bundleFile, bgmFile]);
  assert.equal(await map.evaluate(value => window.baekho.saveProject(value), fixture), projectFile);
  assert.equal(JSON.parse(fs.readFileSync(projectFile, 'utf8')).map.name, fixture.map.name);
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, projectFile);
  assert.equal(await map.evaluate(async () => (await window.baekho.openProject()).map.name), fixture.map.name);
  await map.evaluate(value => window.baekho.saveRecovery(value), fixture);
  assert.equal(await map.evaluate(async () => (await window.baekho.loadRecovery()).map.name), fixture.map.name);
  assert.ok(fs.existsSync(path.join(profile, 'map-forge/recovery/latest.baekho.json')));
  const unity = path.join(runtime, 'Unity');
  fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(unity, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.unity.ai.navigation': '1.1.0' } }));
  fs.writeFileSync(path.join(unity, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1\n');
  fixture.bindings = ['wall', 'floor', 'door', 'prop', 'stair'].map((role, index) => {
    const prefabGuid = String(index + 1).repeat(32), prefabPath = `Assets/${role}.prefab`;
    fs.writeFileSync(path.join(unity, prefabPath), '%YAML 1.1\n');
    fs.writeFileSync(path.join(unity, prefabPath + '.meta'), `fileFormatVersion: 2\nguid: ${prefabGuid}\n`);
    return { id: role, label: role, role, prefabGuid, prefabPath, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 };
  });
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, unity);
  await map.evaluate(() => window.baekho.scanProject());
  await map.evaluate(value => window.baekho.exportBundle(value), fixture);
  const zip = unzipSync(fs.readFileSync(bundleFile));
  for (const name of ['Map.baekhomap.json', 'Unity/Editor/BaekhoMapImporter.cs', 'Unity/Editor/BaekhoPropCatalog.cs', 'Unity/Runtime/BaekhoMapConnection.cs', 'Unity/Runtime/BaekhoGameplayMarker.cs', 'Unity/Runtime/BaekhoMapFixture.cs', 'Unity/Runtime/BaekhoWallModule.cs', 'Unity/Runtime/BaekhoMapAsset.cs', 'Unity/Editor/BaekhoMapAssetEditor.cs', 'Unity/Editor/BaekhoAssetCatalog.cs']) assert.ok(zip[name]?.length, name);
  checks.push('map save/open/recovery/export retain wall and asset catalog scripts');
  const endpoint = await startUnityMock(path.resolve(unity));
  const assetsBefore = fs.readdirSync(path.join(unity, 'Assets'));
  const unityStatus = await map.evaluate(address => window.baekho.getUnityStatus(address), endpoint);
  assert.equal(unityStatus.state, 'needs-setup', JSON.stringify(unityStatus));
  assert.equal(unityStatus.projectPath.toLowerCase(), path.resolve(unity).toLowerCase());
  assert.ok(unityRequests.some(request => request.method === 'initialize'));
  assert.ok(unityRequests.some(request => request.method === 'tools/call' && request.params.name === 'set_active_instance'));
  assert.deepEqual(fs.readdirSync(path.join(unity, 'Assets')), assetsBefore, 'connection status never installs scripts or generates a prefab');
  assert.ok(fs.existsSync(path.join(profile, 'map-forge/unity/unity-settings.json')));
  assert.ok(unityRequests.every(request => request.method !== 'tools/call' || ['set_active_instance', 'read_console'].includes(request.params.name)));
  checks.push('bundled MCP client completes loopback HTTP handshake and project routing without Unity writes');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('AutoMapPrefabMaker'))?.close());
  await new Promise(r => setTimeout(r, 200));
  assert.equal(map.isClosed(), false, 'cancel closing preserves dirty map');
  await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('AutoMapPrefabMaker'))?.close(); });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(map.isClosed(), true);
  checks.push('dirty map close can be cancelled before an explicit discard');
  const requestsBeforeReopen = unityRequests.length;
  await shell.getByTestId('tool-map').click();
  const reopenedMap = await app.waitForEvent('window', { predicate: p => p !== shell, timeout: 10000 }).catch(() => app.context().pages().find(p => p !== shell && p.url().includes('AutoMapPrefabMaker')));
  assert.ok(reopenedMap);
  await reopenedMap.locator('#mapName').waitFor();
  assert.equal((await reopenedMap.evaluate(() => window.baekho.getUnityStatus())).state, 'no-project');
  assert.equal(await reopenedMap.evaluate(async () => (await window.baekho.loadRecovery()).map.name), fixture.map.name);
  assert.equal(unityRequests.length, requestsBeforeReopen, 'reopening never automatically reconnects or replays Unity requests');
  checks.push('closing and reopening recreates the map Unity service and retains recovery without replay');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('AutoMapPrefabMaker'))?.close());

  await shell.getByTestId('tool-bgm').click();
  await shell.getByTestId('bgm-description').fill('Preserved BGM draft');
  const bgmState = await shell.evaluate(() => window.bgm.state());
  assert.equal(bgmState.configured, false);
  assert.equal(bgmState.candidates[0].status, 'ready');
  await shell.evaluate(() => window.bgm.select('mock-audio'));
  await shell.evaluate(() => window.bgm.export('mock-audio'));
  assert.deepEqual(fs.readFileSync(bgmFile), mp3);
  await shell.getByTestId('nav-home').click(); await shell.getByTestId('tool-bgm').click();
  assert.equal(await shell.getByTestId('bgm-description').inputValue(), 'Preserved BGM draft');
  assert.equal((await shell.evaluate(() => window.bgm.state())).totalReservedUsd, .04);
  checks.push('BGM selection/export preserve fixture bytes and ledger without generation');
  await shell.getByTestId('nav-home').click();
  await shell.getByTestId('tool-hit-timing').click();
  let hit;
  for (let n = 0; n < 100 && !hit; n++) {
    hit = app.context().pages().find(p => p.url().startsWith('aht://'));
    if (!hit) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(hit); await hit.locator('#search-mode').waitFor();
  assert.ok(await hit.locator('#search-mode option[value="semantic"]').count());
  checks.push('integrated animation search exposes semantic mode');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, runtime, generatedCount: 0, audio: 'synthetic export fixture; playback not certified' }, null, 2));
  fs.writeFileSync(path.join(runtime, 'result.json'), JSON.stringify({ ok: true, checks, errors, generatedCount: 0 }, null, 2));
} finally {
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBoxSync = () => 1;
    for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('AutoMapPrefabMaker')) win.close();
  }).catch(() => {});
  await app.close();
  if (unityMock) {
    unityMock.closeAllConnections();
    await new Promise(resolve => unityMock.close(resolve));
  }
}
