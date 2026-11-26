import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { strFromU8, unzipSync } from 'fflate';

const { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const output = resolve('.local/concepts-smoke');
const userData = resolve('.local/concepts-smoke-user', `run-${Date.now()}`);
await mkdir(output, { recursive: true }); await mkdir(userData, { recursive: true });
const fixture = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, connectionWidth: 2, conceptMode: 'ai', prompt: '' }, bindings: [] });
fixture.map.name = '컨셉 검증 원본';
const fixturePath = resolve(output, 'original.baekho.json'); await writeFile(fixturePath, JSON.stringify(fixture));
const candidate = structuredClone(fixture.map); candidate.name = 'AI 컨셉 검증 맵';
const maps = [0, 1].map(index => {
  const map = structuredClone(candidate), x = 2 + index;
  map.rows[5] = `${map.rows[5].slice(0, x)}#${map.rows[5].slice(x + 1)}`;
  map.name = `컨셉 후보 ${index + 1}`;
  assert.deepEqual(validateMap(map).filter(issue => issue.severity === 'error'), []);
  return map;
});
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, data) => {
    app.setPath('userData', data.userData);
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1400, height: 1000 });
    const state = globalThis.conceptsSmoke = { ...data, mode: 'success', calls: [], waiters: [], held: '', gates: {}, sequence: 0 };
    state.record = (kind, payload = {}) => {
      state.calls.push({ kind, ...payload });
      for (const waiter of state.waiters.splice(0)) waiter();
    };
    state.gate = kind => state.held === kind ? new Promise(resolve => { state.gates[kind] = resolve; }) : Promise.resolve();
    for (const channel of ['codex-status', 'generate-concept', 'generate-image', 'extract-layout', 'cancel-generation']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no paid AI calls', models: [] }));
    ipcMain.handle('baekho:generate-concept', async (_event, settings, catalog, context) => {
      const text = `AI 컨셉 ${++state.sequence}: 적의 압박을 관찰하고 공격에 진입할 시점과 회피 후 다시 접근할 시점을 판단하는 전투방이다. 전투를 마친 뒤 보상을 회수하고 다음 행동을 준비한다.`;
      state.record('concept', { settings, catalog, context, text });
      await state.gate('concept');
      if (state.mode === 'concept-failure') throw new Error('SMOKE concept failure');
      if (state.mode === 'invalid-concept') return ' ';
      return text;
    });
    ipcMain.handle('baekho:generate-image', async (_event, settings, region, catalog) => {
      state.record('image', { settings, region, catalog }); await state.gate('image'); return state.png;
    });
    ipcMain.handle('baekho:extract-layout', async (_event, settings, image, region, catalog) => {
      state.record('extract', { settings, image, region, catalog }); await state.gate('extract');
      if (state.mode === 'extract-failure') throw new Error('SMOKE extraction failure');
      const conceptCall = state.calls.filter(call => call.kind === 'concept').length;
      return state.mode === 'variants' ? state.maps[(conceptCall - 1) % state.maps.length] : state.candidate;
    });
    ipcMain.handle('baekho:cancel-generation', () => state.record('cancel'));
    dialog.showMessageBoxSync = () => 1;
  }, { userData, png: PNG, candidate, maps });
  await page.reload(); await page.locator('#preview canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-action="codex"]')?.textContent?.includes('연결됨'));
  const action = name => page.locator(`[data-action="${name}"]`);
  const result = kind => page.locator(`[data-concept-result="${kind}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const configure = (mode = 'success', held = '') => app.evaluate((_electron, next) => Object.assign(globalThis.conceptsSmoke, next, { calls: [], waiters: [], gates: {} }), { mode, held });
  const calls = () => app.evaluate(() => globalThis.conceptsSmoke.calls);
  const kinds = async () => (await calls()).map(call => call.kind);
  const waitForCall = kind => app.evaluate(async (_electron, kind) => {
    const state = globalThis.conceptsSmoke;
    while (!state.calls.some(call => call.kind === kind)) await new Promise(resolve => state.waiters.push(resolve));
  }, kind);
  const release = kind => app.evaluate((_electron, kind) => {
    const state = globalThis.conceptsSmoke; state.held = ''; state.gates[kind]?.(); delete state.gates[kind];
  }, kind);
  let savedIndex = 0;
  const save = async label => {
    const filePath = resolve(output, `${String(++savedIndex).padStart(2, '0')}-${label}.baekho.json`);
    await page.locator('[data-view="3d"]').click();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
    await action('save').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return { filePath, project: JSON.parse(await readFile(filePath, 'utf8')) };
  };
  const open = async filePath => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, filePath);
    await action('open').click();
    if (await page.locator('#discard-dialog[open]').isVisible()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
  };
  const selectRegion = async () => {
    await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate(svg => {
      const p = new DOMPoint(5.5, 5.5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
    });
    await page.mouse.click(point.x, point.y); await page.locator('[data-right-tab="design"]').click(); await expand();
  };

  console.log('concept smoke: defaults, optional manual input and preserved text');
  assert.equal(await page.locator('#conceptMode').inputValue(), 'ai');
  assert.equal(await page.locator('#prompt').count(), 0);
  await page.locator('#conceptMode').selectOption('manual');
  assert.equal(await page.locator('#prompt').inputValue(), '');
  await configure(); await action('generate').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /직접 입력.*컨셉/);
  assert.deepEqual(await kinds(), []);
  assert.equal((await save('empty-manual')).project.settings.prompt, '');
  const manualText = '수동 컨셉 초안: 나무 뿌리가 감싼 천문대';
  await page.locator('#prompt').fill(manualText);
  await page.locator('#conceptMode').selectOption('ai'); assert.equal(await page.locator('#prompt').count(), 0);
  await page.locator('#conceptMode').selectOption('manual'); assert.equal(await page.locator('#prompt').inputValue(), manualText);
  await open(fixturePath);

  console.log('concept smoke: immediate result, shared request brief and map history');
  await page.locator('#conceptMode').selectOption('manual'); await page.locator('#prompt').fill(manualText);
  await configure(); await action('generate').click(); await idle();
  assert.deepEqual(await kinds(), ['image', 'extract']);
  const manual = (await save('manual-generated')).project;
  assert.deepEqual(manual.concept, { source: 'manual', text: manualText });
  await page.locator('#conceptMode').selectOption('ai');
  await configure('success', 'image'); await action('generate').click(); await waitForCall('image');
  const conceptText = (await calls()).find(call => call.kind === 'concept').text;
  assert.match(await result('attempt').innerText(), /AI 작성/);
  assert.ok((await result('attempt').innerText()).includes(conceptText));
  assert.equal((await calls()).find(call => call.kind === 'concept').settings.prompt, '');
  await release('image'); await idle();
  assert.deepEqual(await kinds(), ['concept', 'image', 'extract']);
  const pipeline = await calls();
  assert.equal(pipeline[1].settings.prompt, conceptText); assert.deepEqual(pipeline[1].settings, pipeline[2].settings);
  assert.equal(pipeline[2].image, PNG);
  const generated = await save('generated');
  assert.deepEqual(generated.project.concept, { source: 'ai', text: conceptText });
  assert.equal(generated.project.settings.prompt, manualText, 'AI request must preserve editable manual input');
  assert.equal(generated.project.settings.conceptMode, 'ai');
  assert.ok((await result('map').innerText()).includes(conceptText));
  await action('undo').click(); assert.deepEqual((await save('undo')).project.concept, manual.concept);
  await action('redo').click(); assert.deepEqual((await save('redo')).project.concept, generated.project.concept);
  await action('demo').click(); assert.equal((await save('sample')).project.concept, undefined); assert.equal(await result('map').count(), 0);
  await open(generated.filePath); assert.deepEqual((await save('reopened')).project, generated.project);

  console.log('concept smoke: image draft, failed extraction and stable retry after edits');
  await configure(); await expand(); await action('generate-image').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'image']);
  const draftSaved = await save('image-draft');
  const draft = draftSaved.project.generationDraft;
  assert.equal(draft.concept.source, 'ai'); assert.equal(draft.settings.prompt, draft.concept.text);
  assert.equal(draft.preferences.prompt, manualText);
  assert.ok((await result('draft').innerText()).includes(draft.concept.text));
  await page.locator('#conceptMode').selectOption('manual'); await page.locator('#prompt').fill('분석 재시도에 섞이면 안 되는 다음 생성 문구');
  await configure('extract-failure'); await expand(); await action('extract').click(); await idle();
  assert.deepEqual(await kinds(), ['extract']); assert.match(await page.locator('#status').innerText(), /SMOKE extraction failure/);
  assert.deepEqual((await calls())[0].settings, draft.settings);
  const failed = await save('failed-draft');
  assert.deepEqual(failed.project.map, generated.project.map); assert.deepEqual(failed.project.concept, generated.project.concept);
  assert.deepEqual(failed.project.generationDraft.concept, draft.concept);
  await configure(); await expand(); await action('extract').click(); await idle();
  assert.deepEqual(await kinds(), ['extract']); assert.deepEqual((await calls())[0].settings, draft.settings);
  const retried = await save('retried'); assert.equal(retried.project.generationDraft, undefined);
  assert.deepEqual(retried.project.concept, draft.concept);

  console.log('concept smoke: cancellation, late responses, invalid output and failure isolation');
  await page.locator('#conceptMode').selectOption('ai');
  const beforeCancelSaved = await save('before-cancel'), beforeCancel = beforeCancelSaved.project;
  await configure('success', 'concept'); await action('generate').click(); await waitForCall('concept');
  assert.match(await page.locator('#status').innerText(), /컨셉 작성/);
  await action('cancel').click(); await waitForCall('cancel'); await release('concept'); await idle();
  assert.deepEqual(await kinds(), ['concept', 'cancel']);
  assert.deepEqual((await save('cancelled')).project, beforeCancel);
  assert.equal(await result('attempt').count(), 0);
  for (const mode of ['concept-failure', 'invalid-concept']) {
    await configure(mode); await action('generate').click(); await idle();
    assert.deepEqual(await kinds(), ['concept']);
    assert.match(await page.locator('#status').innerText(), mode === 'concept-failure' ? /SMOKE concept failure/ : /AI 컨셉/);
    assert.deepEqual((await save(mode)).project, beforeCancel);
  }

  console.log('concept smoke: native autosave and recovery keep map concept separate from next input');
  const recoveryPrompt = '자동 복구에 보존할 다음 맵 컨셉 입력';
  const recoveryReady = new Promise((done, reject) => {
    const watcher = watch(userData, { recursive: true }, async (_event, name) => {
      if (!String(name).endsWith('latest.baekho.json')) return;
      const saved = await readFile(resolve(userData, 'recovery/latest.baekho.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (saved?.settings.prompt === recoveryPrompt && saved?.concept?.text === beforeCancel.concept.text) {
        watcher.close(); clearTimeout(timeout); done();
      }
    });
    const timeout = setTimeout(() => { watcher.close(); reject(new Error('Native concept recovery file was not committed')); }, 15000);
    watcher.on('error', error => { clearTimeout(timeout); watcher.close(); reject(error); });
  });
  await page.locator('#conceptMode').selectOption('manual'); await page.locator('#prompt').fill(recoveryPrompt);
  await page.locator('#conceptMode').selectOption('ai');
  await recoveryReady;
  assert.equal((await page.evaluate(() => window.baekho.loadRecovery())).settings.prompt, recoveryPrompt);
  await page.reload();
  await action('recover').waitFor(); await action('recover').click();
  const recovered = (await save('recovered')).project;
  assert.deepEqual(recovered.concept, beforeCancel.concept); assert.deepEqual(recovered.map, beforeCancel.map);
  assert.equal(recovered.settings.prompt, recoveryPrompt); assert.equal(recovered.settings.conceptMode, 'ai');
  await open(beforeCancelSaved.filePath);

  console.log('concept smoke: region reuses existing concept or creates one from current map context');
  await selectRegion(); await configure(); await page.locator('[data-d-action="regenerate"]').click(); await idle();
  assert.deepEqual(await kinds(), ['image', 'extract']);
  let regionCalls = await calls();
  assert.ok(regionCalls[0].settings.prompt.startsWith(beforeCancel.concept.text));
  assert.deepEqual(regionCalls[0].region, { x: 5, row: 5, width: 1, height: 1 });
  assert.deepEqual(regionCalls[0].settings, regionCalls[1].settings);
  assert.deepEqual((await save('region-reused-concept')).project.concept, beforeCancel.concept);
  await open(fixturePath); await selectRegion(); await configure(); await page.locator('[data-d-action="regenerate"]').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'image', 'extract']);
  regionCalls = await calls();
  assert.deepEqual(regionCalls[0].context.currentMap, fixture.map);
  assert.ok(regionCalls[1].settings.prompt.startsWith(regionCalls[0].text));
  assert.deepEqual((await save('region-new-concept')).project.concept, { source: 'ai', text: regionCalls[0].text });
  await open(beforeCancelSaved.filePath);

  console.log('concept smoke: candidate concepts, comparison and selected ZIP');
  await configure('variants'); await page.locator('#variantCount').selectOption('2'); await action('generate-variants').click(); await idle();
  assert.deepEqual(await kinds(), ['concept', 'image', 'extract', 'concept', 'image', 'extract']);
  const cards = page.locator('[data-variant-card]'); assert.equal(await page.locator('.variant-card .status-ready').count(), 2);
  assert.equal(await page.locator('.variant-card .variant-concept').count(), 2);
  const candidateCalls = (await calls()).filter(call => call.kind === 'concept');
  assert.deepEqual(candidateCalls[1].context.previousConcepts, [candidateCalls[0].text]);
  assert.notEqual(candidateCalls[0].text, candidateCalls[1].text);
  for (const index of [0, 1]) {
    assert.ok((await cards.nth(index).innerText()).includes(candidateCalls[index].text));
    await cards.nth(index).locator('[data-v-action="select"]').check();
  }
  const zipPath = resolve(output, 'candidate-concepts.zip');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
  await page.locator('[data-v-action="save"]').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /후보 저장 완료/);
  const zip = unzipSync(await readFile(zipPath));
  const savedCandidates = Object.keys(zip).filter(name => name.endsWith('.baekho.json')).map(name => JSON.parse(strFromU8(zip[name])));
  assert.deepEqual(savedCandidates.map(project => project.concept), candidateCalls.map(call => ({ source: 'ai', text: call.text })));
  assert.ok(savedCandidates.every(project => project.settings.prompt === manualText));
  await page.locator('[data-view="3d"]').click(); assert.deepEqual((await save('after-candidates')).project, beforeCancel);
  await page.screenshot({ path: resolve(output, 'concept-result.png') });
  const longProject = structuredClone(beforeCancel);
  longProject.concept.text = '오래된 수로를 따라 푸른 식물이 자라는 지하 정원. '.repeat(40) + 'LongUnbrokenConceptText'.repeat(20);
  const longPath = resolve(output, 'long-concept.baekho.json'); await writeFile(longPath, JSON.stringify(longProject));
  await open(longPath);
  for (const [width, height] of [[1200, 800], [1050, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds(size), { width, height });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await result('map').locator('p').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Long concepts must wrap without horizontal overflow');
    assert.ok(await result('map').locator('p').evaluate(element => element.scrollHeight > element.clientHeight), 'Long concepts must remain available through vertical scrolling');
    const reachability = await result('map').evaluate(element => {
      const workspace = element.closest('.workspace'), conceptBounds = element.getBoundingClientRect(), workspaceBounds = workspace.getBoundingClientRect();
      const overflowY = getComputedStyle(workspace).overflowY;
      return { conceptBottom: conceptBounds.bottom, workspaceBottom: workspaceBounds.bottom, overflowY,
        reachable: conceptBounds.bottom <= workspaceBounds.bottom + 1 || ['auto', 'scroll'].includes(overflowY) };
    });
    assert.ok(reachability.reachable, `Concept panel must be visible or reachable by scrolling at ${width}x${height}: ${JSON.stringify(reachability)}`);
    await result('map').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `concept-${width}x${height}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(`PASS concept smoke: AI/manual UI, immediate concepts, shared requests, save/open/history, draft retry, region reuse/context, late cancellation, failure isolation, candidate ZIP, small-window long concepts and zero renderer errors. No paid AI calls. ${output}`);
} finally {
  if (page) await page.screenshot({ path: resolve(output, 'last-state.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
  await app.close();
}
