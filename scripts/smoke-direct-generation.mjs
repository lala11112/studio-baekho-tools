import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const executableArgument = process.argv.find(argument => argument.startsWith('--executable='));
const executablePath = executableArgument?.slice('--executable='.length);
if (executableArgument) assert.ok(executablePath && isAbsolute(executablePath), '--executable must specify an absolute executable path');
const packaged = !!executablePath;
const output = resolve(packaged ? '.local/direct-generation-packaged-smoke' : '.local/direct-generation-smoke'), userData = resolve(output, `user-${Date.now()}`);
await mkdir(output, { recursive: true }); await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, generationMethod: 'image', conceptMode: 'manual', prompt: '문을 지나 적의 압박을 확인하고 회피하며 전투하는 오래된 관측소', connectionWidth: 2 };
const concept = { source: 'manual', text: settings.prompt };
const fixture = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings, bindings: [], blueprintDataUrl: PNG, concept,
  generationDraft: { imageDataUrl: PNG, settings, preferences: settings, concept, catalog: [] } });
fixture.map.name = '직접 생성 검증 원본';
const fixturePath = resolve(output, 'original.baekho.json'); await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
const candidate = structuredClone(fixture.map); candidate.name = '이미지 없이 직접 생성한 맵';
candidate.rows[5] = candidate.rows[5].slice(0, 3) + '#' + candidate.rows[5].slice(4);
const regionCandidate = structuredClone(fixture.map); regionCandidate.name = '선택 영역 밖은 유지';
regionCandidate.rows[5] = regionCandidate.rows[5].slice(0, 5) + 'P' + regionCandidate.rows[5].slice(6);
regionCandidate.rows[6] = regionCandidate.rows[6].slice(0, 3) + '#' + regionCandidate.rows[6].slice(4);
for (const map of [fixture.map, candidate, regionCandidate]) assert.deepEqual(validateMap(map).filter(issue => issue.severity === 'error'), []);

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${userData}`] } : { args: ['.', `--user-data-dir=${userData}`] }), env });
const errors = [], evidence = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged, 'Smoke must run the selected development or packaged application');
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, data) => {
    app.setPath('userData', data.userData);
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1450, height: 1050 });
    const state = globalThis.directGenerationSmoke = { ...data, mode: 'success', held: '', calls: [], waiters: [], gates: {}, sequence: 0 };
    state.codexStatus = { state: 'ready', message: 'Smoke mock: no paid AI calls', models: [] };
    state.record = (kind, payload = {}) => { state.calls.push({ kind, ...payload }); for (const done of state.waiters.splice(0)) done(); };
    state.gate = kind => state.held === kind ? new Promise(done => { state.gates[kind] = done; }) : Promise.resolve();
    state.progress = event => BrowserWindow.getAllWindows()[0]?.webContents.send('baekho:generation-progress', event);
    for (const channel of ['codex-status', 'generate-concept', 'generate-image', 'extract-layout', 'generate-layout', 'cancel-generation']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => state.codexStatus);
    ipcMain.handle('baekho:generate-concept', async (_event, request, catalog, context) => { state.record('concept', { settings: request, catalog, context }); return '선택한 공간의 입구와 시야를 살리는 관측소 전투방'; });
    ipcMain.handle('baekho:generate-image', async (_event, request, region, catalog, context) => {
      state.record('image', { settings: request, region, catalog, context }); await state.gate('image'); return state.png;
    });
    ipcMain.handle('baekho:extract-layout', async (_event, request, image, region, catalog) => {
      state.record('extract', { settings: request, image, region, catalog }); await state.gate('extract'); return state.candidate;
    });
    ipcMain.handle('baekho:generate-layout', async (_event, request, region, catalog, context) => {
      const jobId = `direct-smoke-${++state.sequence}`, base = { jobId, method: 'direct', stage: 'layout', id: `${jobId}-layout`, model: 'smoke-mock', reasoningEffort: 'low' };
      state.record('layout', { settings: request, region, catalog, context });
      state.progress({ ...base, state: 'running', elapsedMs: 0 });
      await state.gate('layout');
      if (state.mode === 'failure') {
        state.progress({ ...base, state: 'failed', elapsedMs: 1200 }); throw new Error('SMOKE direct generation failure');
      }
      state.progress({ ...base, state: 'completed', elapsedMs: 1200, tokenUsage: { inputTokens: 120, outputTokens: 240, reasoningOutputTokens: 20 } });
      state.progress({ ...base, id: `${jobId}-placement`, stage: 'placement', state: 'completed', elapsedMs: 40 });
      state.progress({ ...base, id: `${jobId}-validation`, stage: 'validation', state: 'completed', elapsedMs: 8 });
      return region ? state.regionCandidate : state.candidate;
    });
    ipcMain.handle('baekho:cancel-generation', () => state.record('cancel'));
    dialog.showMessageBoxSync = () => 1;
  }, { userData, png: PNG, candidate, regionCandidate });
  await page.reload(); await page.locator('#preview canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-action="codex"]')?.textContent?.includes('연결됨'));
  const action = name => page.locator(`[data-action="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const configure = (mode = 'success', held = '') => app.evaluate((_electron, next) => Object.assign(globalThis.directGenerationSmoke, next, { calls: [], waiters: [], gates: {} }), { mode, held });
  const calls = () => app.evaluate(() => globalThis.directGenerationSmoke.calls);
  const kinds = async () => (await calls()).map(call => call.kind);
  const waitForCall = kind => app.evaluate(async (_electron, kind) => {
    const state = globalThis.directGenerationSmoke;
    let timer;
    try {
      await Promise.race([
        (async () => { while (!state.calls.some(call => call.kind === kind)) await new Promise(done => state.waiters.push(done)); })(),
        new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${kind}`)), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  }, kind);
  const release = kind => app.evaluate((_electron, kind) => { const state = globalThis.directGenerationSmoke; state.held = ''; state.gates[kind]?.(); delete state.gates[kind]; }, kind);
  let saveIndex = 0;
  const save = async label => {
    const filePath = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await page.locator('[data-view="3d"]').click();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
    await action('save').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/, label);
    const raw = JSON.parse(await readFile(filePath, 'utf8')), project = parseProjectFile(raw);
    assert.deepEqual(validateMap(project.map, project.bindings).filter(issue => issue.severity === 'error'), []);
    return { filePath, raw, project };
  };
  const open = async filePath => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, filePath);
    await action('open').click();
    if (await page.locator('#discard-dialog[open]').isVisible()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
  };
  const refreshCodex = async status => {
    await app.evaluate((_electron, status) => { globalThis.directGenerationSmoke.codexStatus = status; }, status);
    await action('codex').click(); await action('codex-refresh').click();
    await page.waitForFunction(message => document.querySelector('#codex-status')?.textContent === message, status.message);
    await action('close-codex').click();
  };

  console.log('direct generation smoke: image default and compatible image pipeline');
  assert.equal(await page.locator('#generationMethod').inputValue(), 'image');
  await open(fixturePath); await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['image', 'extract']);
  const imageResult = await save('image-default');
  assert.equal(imageResult.project.settings.generationMethod, 'image'); assert.equal(imageResult.project.blueprintDataUrl, PNG);
  assert.equal(imageResult.project.generationDraft, undefined);
  evidence.push({ scenario: 'default-image', calls: await kinds() });

  console.log('direct generation smoke: direct success, saved metadata, progress and undo');
  await open(fixturePath); await page.locator('#generationMethod').selectOption('direct');
  const beforeDirect = (await save('before-direct')).project;
  await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['layout']);
  const directCall = (await calls())[0]; assert.equal(directCall.settings.generationMethod, 'direct'); assert.deepEqual(directCall.catalog, []);
  const generated = await save('direct-success');
  assert.deepEqual(generated.project.map, candidate); assert.equal(generated.project.settings.generationMethod, 'direct');
  assert.deepEqual(generated.project.concept, concept);
  assert.equal(Object.hasOwn(generated.raw, 'blueprintDataUrl'), false); assert.equal(Object.hasOwn(generated.raw, 'generationDraft'), false);
  const timings = page.locator('#generation-timings'); await timings.waitFor({ state: 'visible' });
  const timingText = await timings.innerText(); assert.match(timingText, /직접|구조/); assert.match(timingText, /배치|검증/);
  await page.screenshot({ path: resolve(output, 'direct-success.png') });
  evidence.push({ scenario: 'direct-success', calls: await kinds(), progressText: timingText, mockedTimings: true });
  await action('undo').click(); const undone = (await save('undo-restores-image')).project;
  assert.deepEqual(undone.map, beforeDirect.map); assert.equal(undone.blueprintDataUrl, beforeDirect.blueprintDataUrl);
  assert.deepEqual(undone.generationDraft, beforeDirect.generationDraft); assert.deepEqual(undone.concept, beforeDirect.concept);

  console.log('direct generation smoke: failure and cancellation preserve map and image drafts');
  await configure('failure'); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['layout']); assert.match(await page.locator('#status').innerText(), /SMOKE direct generation failure/);
  assert.deepEqual((await save('direct-failure')).project, undone);
  evidence.push({ scenario: 'direct-failure', calls: await kinds() });
  await configure('success', 'layout'); await action('generate').click(); await waitForCall('layout');
  await action('cancel').click(); await waitForCall('cancel'); await release('layout'); await idle();
  assert.deepEqual(await kinds(), ['layout', 'cancel']); assert.match(await page.locator('#status').innerText(), /취소/);
  assert.deepEqual((await save('direct-cancelled')).project, undone);
  evidence.push({ scenario: 'direct-cancelled', calls: await kinds() });

  console.log('direct generation smoke: explicit image drafts stay on their saved generation method');
  await open(fixturePath); await page.locator('#generationMethod').selectOption('direct');
  await configure(); await expand(); await action('generate-image').click(); await idle();
  assert.deepEqual(await kinds(), ['image']);
  const draft = (await save('image-draft-with-direct-picker')).project.generationDraft;
  assert.ok(draft); assert.equal(draft.settings.generationMethod, 'image');
  await page.locator('#generationMethod').selectOption('direct');
  await configure(); await expand(); await action('extract').click(); await idle();
  assert.deepEqual(await kinds(), ['extract']);
  assert.deepEqual((await calls())[0].settings, draft.settings); assert.equal((await calls())[0].settings.generationMethod, 'image');
  assert.equal((await save('image-draft-extracted')).project.generationDraft, undefined);
  evidence.push({ scenario: 'saved-image-draft-extraction', calls: await kinds(), requestMethod: (await calls())[0].settings.generationMethod });

  console.log('direct generation smoke: selected region preserves outside geometry and connections');
  await open(fixturePath); await page.locator('#generationMethod').selectOption('direct');
  await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
  const point = await page.locator('#map-svg').evaluate(svg => { const p = new DOMPoint(5.5, 5.5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y }; });
  await page.mouse.click(point.x, point.y); await page.locator('[data-right-tab="design"]').click(); await expand();
  await configure(); await page.locator('[data-d-action="regenerate"]').click(); await idle();
  assert.deepEqual(await kinds(), ['layout']); const regionCall = (await calls())[0];
  assert.deepEqual(regionCall.region, { x: 5, row: 5, width: 1, height: 1 }); assert.equal(regionCall.settings.generationMethod, 'direct');
  assert.match(regionCall.settings.prompt, /BAEKHO REGION CONTEXT/);
  const region = (await save('direct-region')).project;
  assert.equal(region.map.name, fixture.map.name); assert.equal(region.map.rows[5][5], 'P');
  for (let row = 0; row < fixture.map.height; row++) for (let x = 0; x < fixture.map.width; x++) if (x !== 5 || row !== 5) {
    assert.equal(region.map.rows[row][x], fixture.map.rows[row][x], `outside selection ${x},${row}`);
    assert.equal(region.map.elevations[row][x], fixture.map.elevations[row][x], `outside height ${x},${row}`);
  }
  assert.deepEqual(region.map.connections, fixture.map.connections);
  assert.equal(region.blueprintDataUrl, undefined); assert.equal(region.generationDraft, undefined);
  evidence.push({ scenario: 'direct-region', calls: await kinds(), region: regionCall.region });

  console.log('direct generation smoke: unavailable image generation rejects before AI calls and permits direct generation');
  await refreshCodex({ state: 'ready', message: 'SMOKE image tool unavailable', models: [], imageGeneration: false });
  await open(fixturePath); await page.locator('#conceptMode').selectOption('ai');
  await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), []); assert.match(await page.locator('#status').innerText(), /이미지 생성.*지원하지/);
  evidence.push({ scenario: 'image-tool-unavailable-preflight', calls: await kinds() });
  await page.locator('#generationMethod').selectOption('direct');
  await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'layout']);
  const noImageTool = (await save('direct-without-image-tool')).project;
  assert.deepEqual(noImageTool.map, candidate); assert.equal(noImageTool.settings.generationMethod, 'direct');
  assert.equal(noImageTool.blueprintDataUrl, undefined); assert.equal(noImageTool.generationDraft, undefined);
  evidence.push({ scenario: 'direct-without-image-tool', calls: await kinds() });

  console.log('direct generation smoke: explicit text-only model guards image input while allowing image creation and direct maps');
  const textModel = { id: 'smoke-text-only', name: 'Smoke text-only model', isDefault: false, inputModalities: ['text'] };
  await refreshCodex({ state: 'ready', message: 'SMOKE image tool available with text-only model', models: [textModel], imageGeneration: true });
  await open(fixturePath); await page.locator('#conceptMode').selectOption('ai');
  await expand(); await page.locator('#codexModel').fill(textModel.id); await page.locator('#codexModel').press('Tab');
  for (const name of ['generate', 'generate-variants']) {
    await configure(); await action(name).click(); await idle();
    assert.deepEqual(await kinds(), []); assert.match(await page.locator('#status').innerText(), /이미지 입력.*지원하지/);
    evidence.push({ scenario: `text-only-model-${name}-preflight`, calls: await kinds() });
  }
  await configure(); await expand(); await action('generate-image').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'image']);
  const textDraft = (await save('text-only-model-image-draft')).project.generationDraft;
  assert.ok(textDraft); assert.equal(textDraft.settings.codexModel, textModel.id); assert.equal(textDraft.settings.generationMethod, 'image');
  evidence.push({ scenario: 'text-only-model-generate-image', calls: await kinds() });
  await configure(); await expand(); await action('extract').click(); await idle();
  assert.deepEqual(await kinds(), []); assert.match(await page.locator('#status').innerText(), /이미지 입력.*지원하지/);
  evidence.push({ scenario: 'text-only-model-extract-preflight', calls: await kinds() });
  await page.locator('#generationMethod').selectOption('direct');
  await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'layout']);
  const textDirect = (await save('text-only-model-direct')).project;
  assert.deepEqual(textDirect.map, candidate); assert.equal(textDirect.settings.codexModel, textModel.id);
  assert.equal(textDirect.blueprintDataUrl, undefined); assert.equal(textDirect.generationDraft, undefined);
  await page.locator('[data-view="image"]').click();
  assert.equal(await page.locator('#viewport img.blueprint').count(), 0);
  const emptyImageCopy = await page.locator('#viewport .empty-image').innerText();
  await page.screenshot({ path: resolve(output, 'direct-no-image.png') });
  evidence.push({ scenario: 'text-only-model-direct', calls: await kinds(), emptyImageCopy });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'PASS', packaged, executablePath, appVersion: await app.evaluate(({ app }) => app.getVersion()), paidAiCalls: 0, rendererErrors: errors, evidence }, null, 2));
  console.log(`PASS direct generation smoke: image default, direct generation, progress UI, save/open/history, failure/cancellation isolation, image draft extraction, selected region, image tool and model capability preflight, direct empty image state and zero renderer errors. No paid AI calls. ${output}`);
} finally {
  if (page) await page.screenshot({ path: resolve(output, 'last-state.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
  await app.close();
}
