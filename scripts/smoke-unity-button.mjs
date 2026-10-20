// Runs the real sandboxed renderer and preload, optionally from the packaged EXE.
// Only Unity IPC responses are scripted; project open/scan/save remain real.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-unity-button.mjs [path/to/Baekho Map Forge.exe]');
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, buildManifest } = await tsImport('../src/shared/map.ts', import.meta.url);
const output = resolve('.local/unity-button-smoke');
const userData = resolve(output, `user-${Date.now()}`), unityProject = resolve(output, 'UnityProject');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets'), { recursive: true }), mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
const roles = ['floor', 'wall', 'door', 'prop', 'stair'];
const bindings = roles.map((role, index) => ({ id: role, role, label: role, prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));
for (const binding of bindings) {
  await writeFile(resolve(unityProject, binding.prefabPath), `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${binding.role}\n`);
  await writeFile(resolve(unityProject, `${binding.prefabPath}.meta`), `fileFormatVersion: 2\nguid: ${binding.prefabGuid}\n`);
}
const fixture = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings });
buildManifest(fixture.map, fixture.bindings);
const input = resolve(output, 'fixture.baekho.json');
await writeFile(input, JSON.stringify(fixture));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
const errors = [], observations = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, { userData, unityProject }) => {
    app.setPath('userData', userData); BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1050 });
    dialog.showMessageBoxSync = () => 1;
    const state = globalThis.unitySmoke = { starts: [], polls: [], prepares: [], mode: 'complete', stage: 0, interrupted: false };
    for (const channel of ['baekho:codex-status', 'baekho:unity-status', 'baekho:unity-prepare', 'baekho:unity-build-start', 'baekho:unity-build-status']) ipcMain.removeHandler(channel);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Isolated Unity button smoke', models: [] }));
    ipcMain.handle('baekho:unity-status', (_event, endpoint) => ({ state: state.mode === 'mismatch' ? 'mismatch' : state.mode === 'resume' ? 'busy' : 'ready', endpoint, projectPath: unityProject, message: state.mode === 'mismatch' ? '연결한 Unity 프로젝트와 실행 중인 프로젝트가 다릅니다.' : 'Unity 연결 확인 완료', ...(state.mode === 'resume' ? { requestId: `unity-smoke-${state.starts.length}` } : {}) }));
    ipcMain.handle('baekho:unity-prepare', (_event, endpoint) => { state.prepares.push(endpoint); return { state: 'ready', endpoint, projectPath: unityProject, message: 'Unity 스크립트 준비와 컴파일 완료' }; });
    ipcMain.handle('baekho:unity-build-start', (_event, project, endpoint) => {
      state.starts.push({ project, endpoint }); state.stage = 0; state.interrupted = false;
      return { requestId: `unity-smoke-${state.starts.length}`, state: 'running', stage: 'preparing', projectPath: unityProject, message: '임포터 스크립트를 준비합니다.' };
    });
    ipcMain.handle('baekho:unity-build-status', (_event, requestId) => {
      state.polls.push(requestId);
      if (state.mode === 'disconnect' && !state.interrupted) { state.interrupted = true; throw new Error('Scripted Unity connection lost'); }
      const stage = ['compiling', 'building', 'completed'][Math.min(state.stage++, 2)];
      return { requestId, state: stage === 'completed' ? 'completed' : 'running', stage, projectPath: unityProject, message: `${stage} · Unity 프리팹 생성`, ...(stage === 'completed' ? { prefabPath: `Assets/Baekho/Generated/Smoke/Map_${state.starts.length}.prefab`, navMeshPath: `Assets/Baekho/Generated/Smoke/Map_${state.starts.length}_NavMesh.asset` } : {}) };
    });
  }, { userData, unityProject });
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = value => page.locator(`[data-action="${value}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const choose = path => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const state = () => app.evaluate(() => globalThis.unitySmoke);
  const setMode = mode => app.evaluate((_electron, mode) => { globalThis.unitySmoke.mode = mode; }, mode);
  const waitStage = stage => page.locator(`[data-unity-stage="${stage}"]`).waitFor();
  const isPackaged = await app.evaluate(({ app }) => app.isPackaged);
  assert.equal(isPackaged, !!executablePath);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.baekho?.startUnityPrefabBuild), 'function');
  assert.equal(await action('unity-build').isDisabled(), true, 'A Unity project must be connected first.');
  assert.equal(await action('export').innerText(), 'ZIP으로 내보내기');
  await choose(input); await action('open').click(); await idle();
  await page.locator('[data-right-tab="assets"]').click(); await choose(unityProject); await action('scan').click(); await idle();
  assert.equal(await action('unity-build').isDisabled(), false);
  await page.locator('.unity-settings summary').click();
  const endpoint = 'http://127.0.0.1:8099/mcp';
  await page.locator('#unityEndpoint').fill(endpoint); await page.locator('#unityEndpoint').press('Tab');
  await action('unity-check').click(); await idle(); assert.match(await page.locator('[data-unity-message]').innerText(), /연결 확인 완료/);
  await action('unity-prepare').click(); await idle(); assert.deepEqual((await state()).prepares, [endpoint]);
  await page.locator('#mapName').fill('저장하지 않은 Unity 자동 생성 맵'); await page.locator('#mapName').press('Tab');
  await action('unity-build').click(); await waitStage('preparing');
  assert.equal(await action('unity-build').isDisabled(), true); assert.equal(await action('open').isDisabled(), true); assert.equal(await action('scan').isDisabled(), true);
  assert.equal(await action('cancel').count(), 0, 'Unity jobs must not expose AI cancellation.');
  await waitStage('compiling'); await waitStage('building'); await waitStage('completed'); await idle();
  assert.equal((await state()).starts.length, 1);
  assert.equal((await state()).starts[0].endpoint, endpoint);
  assert.equal((await state()).starts[0].project.map.name, '저장하지 않은 Unity 자동 생성 맵');
  assert.match(await page.locator('[data-unity-prefab-path]').innerText(), /Map_1\.prefab$/);
  assert.match(await page.locator('[data-unity-navmesh-path]').innerText(), /Map_1_NavMesh\.asset$/);
  assert.match(await action('save').innerText(), /●/, 'Unity creation preserves the unsaved state.');
  assert.ok(await page.locator('.right-panel').evaluate(panel => panel.scrollTop > 0), 'Progress rerenders preserve the export panel scroll position.');
  await page.locator('.unity-progress').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'completed.png') }); observations.push('automatic preparation, compilation, NavMesh build and result paths');
  const saved = resolve(output, 'after-unity.baekho.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await action('save').click(); await idle();
  assert.deepEqual(parseProjectFile(JSON.parse(await readFile(saved, 'utf8'))), { ...fixture, map: { ...fixture.map, name: '저장하지 않은 Unity 자동 생성 맵' } });
  observations.push('unsaved map, bindings and settings preserved');
  await setMode('disconnect'); await action('unity-build').click(); await waitStage('unknown'); await idle();
  assert.equal(await action('unity-build').isDisabled(), true); assert.equal(await page.locator('#unityEndpoint').isDisabled(), true);
  assert.equal(await page.locator('[data-unity-request-id]').innerText(), 'unity-smoke-2');
  await page.screenshot({ path: resolve(output, 'connection-lost.png') });
  await action('unity-build-status').click(); await waitStage('completed'); await idle();
  const afterRecovery = await state();
  assert.equal(afterRecovery.starts.length, 2, 'Checking an unknown result must not start another build.');
  assert.ok(afterRecovery.polls.slice(3).every(requestId => requestId === 'unity-smoke-2'));
  observations.push('connection loss retains request ID and recovers without duplicate creation');
  await setMode('resume');
  await app.evaluate(() => { globalThis.unitySmoke.stage = 0; });
  await action('unity-check').click(); await waitStage('compiling'); await waitStage('completed'); await idle();
  assert.equal((await state()).starts.length, 2, 'Connection discovery resumes an earlier request without starting a build.');
  assert.equal(await page.locator('[data-unity-request-id]').innerText(), 'unity-smoke-2');
  observations.push('connection status discovers and resumes persisted requests');
  await setMode('mismatch'); await action('unity-check').click(); await idle();
  assert.match(await page.locator('[data-unity-message]').innerText(), /프로젝트가 다릅니다/);
  assert.equal((await state()).starts.length, 2);
  await choose(unityProject); await action('scan').click(); await idle();
  assert.equal(await page.locator('.unity-progress').getAttribute('data-unity-state'), 'unchecked', 'Rescanning clears stale project/result connection UI.');
  await page.reload(); await page.locator('#preview canvas').waitFor();
  assert.equal(await page.locator('#unityEndpoint').inputValue(), endpoint, 'Endpoint preference survives reload.');
  assert.deepEqual(errors, []);
  const result = { result: 'PASS', isPackaged, executablePath, observations, starts: (await state()).starts.length, errors };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
