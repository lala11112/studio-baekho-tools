import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const output = resolve('.local/variants-smoke');
const userData = resolve('.local/variants-smoke-user', `run-${Date.now()}`);
await mkdir(output, { recursive: true }); await mkdir(userData, { recursive: true });
const original = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER } },
  bindings: [{ id: 'floor', label: '바닥', role: 'floor', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Floor.prefab', scale: { x: 2, y: .6, z: 2 }, offset: { x: .1, y: .2, z: 0 }, rotationY: 90 },
    { id: 'light', label: '천장 형광등', role: 'light', lightAnchor: 'ceiling', prefabGuid: '2'.repeat(32), prefabPath: 'Assets/Light.prefab', scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: -.1, z: 0 }, rotationY: 0 }] });
const maps = Array.from({ length: 3 }, (_, index) => {
  const map = createDemoMap(), x = 2 + index;
  map.rows[5] = `${map.rows[5].slice(0, x)}#${map.rows[5].slice(x + 1)}`;
  map.name = `구조 ${index + 1}`;
  assert.deepEqual(validateMap(map).filter(issue => issue.severity === 'error'), []);
  return map;
});
const originalPath = resolve(output, 'original.baekho.json'); await writeFile(originalPath, JSON.stringify(original));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, fixture) => {
    app.setPath('userData', fixture.userData);
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1400, height: 1000 });
    globalThis.variantsSmoke = { maps: fixture.maps, png: fixture.png, mode: 'success', index: -1, calls: [], prompts: [] };
    for (const channel of ['codex-status', 'generate-image', 'extract-layout', 'cancel-generation']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no paid AI calls', models: [] }));
    ipcMain.handle('baekho:generate-image', async (_event, settings) => {
      const state = globalThis.variantsSmoke, index = ++state.index;
      state.calls.push(`image${index}`); state.prompts.push(settings.prompt);
      await new Promise(done => setTimeout(done, index === 1 && state.mode !== 'duplicate-failure' ? 1400 : 50));
      return state.png;
    });
    ipcMain.handle('baekho:extract-layout', async (_event, _settings, image) => {
      const state = globalThis.variantsSmoke, index = state.index; state.calls.push(`extract${index}`);
      if (image !== state.png) throw new Error('Wrong blueprint passed to extraction');
      await new Promise(done => setTimeout(done, 30));
      if (state.mode === 'duplicate-failure' && index === 2) throw new Error('SMOKE candidate extraction failure');
      return state.maps[state.mode === 'duplicate-failure' && index === 1 ? 0 : index % state.maps.length];
    });
    ipcMain.handle('baekho:cancel-generation', () => { globalThis.variantsSmoke.calls.push('cancel'); });
    dialog.showMessageBoxSync = () => 1;
  }, { userData, maps, png: PNG });
  await page.reload(); await page.locator('#preview canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-action="codex"]')?.textContent?.includes('연결됨'));
  const idle = async () => page.waitForFunction(() => !document.querySelector('[data-action="generate-variants"]')?.disabled);
  const callList = () => app.evaluate(() => globalThis.variantsSmoke.calls);
  const configure = mode => app.evaluate((_electron, mode) => Object.assign(globalThis.variantsSmoke, { mode, index: -1, calls: [], prompts: [] }), mode);
  const cards = () => page.locator('[data-variant-card]');
  const select = index => cards().nth(index).locator('[data-v-action="select"]');
  const vAction = name => page.locator(`[data-v-action="${name}"]`);
  const open = async path => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, path);
    await page.locator('[data-action="open"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
  };
  let saveIndex = 0;
  const saveCurrent = async label => {
    const path = resolve(output, `${++saveIndex}-${label}.baekho.json`);
    await page.locator('[data-view="3d"]').click();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await page.locator('[data-action="save"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return JSON.parse(await readFile(path, 'utf8'));
  };
  const saveSelected = async name => {
    const path = resolve(output, `${name}.zip`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await vAction('save').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /후보 저장 완료/);
    return unzipSync(await readFile(path));
  };
  await open(originalPath); await page.locator('[data-view="variants"]').click();
  assert.match(await page.locator('.variant-gallery-empty').innerText(), /여러 후보 생성/);

  console.log('variants smoke: three distinct candidates and nonblocking gallery selection');
  await configure('success'); await page.locator('#variantCount').selectOption('3');
  await page.locator('[data-action="generate-variants"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.variant-status.status-ready').length >= 1);
  assert.equal(await select(0).isChecked(), false); assert.equal(await select(1).isDisabled(), true);
  await select(0).check();
  assert.equal(await page.locator('[data-variant-selected-count]').innerText(), '1개 선택');
  assert.equal(await vAction('save').isDisabled(), true); assert.equal(await vAction('apply').isDisabled(), true);
  await cards().nth(0).locator('[data-v-view="image"]').click(); await page.locator('.variant-detail-image').waitFor();
  await idle();
  assert.equal(await cards().count(), 3); assert.equal(await page.locator('.variant-card .status-ready').count(), 3);
  assert.equal(await select(0).isChecked(), true); assert.equal(await select(1).isChecked(), false); assert.equal(await select(2).isChecked(), false);
  assert.deepEqual(await callList(), ['image0', 'extract0', 'image1', 'extract1', 'image2', 'extract2']);
  assert.equal(await app.evaluate(() => new Set(globalThis.variantsSmoke.prompts).size), 3);
  assert.equal(new Set(await page.locator('.variant-floorplan').evaluateAll(items => items.map(item => item.outerHTML))).size, 3);
  assert.deepEqual(await saveCurrent('original-after-generation'), original, 'Generating and previewing candidates must leave the editable project unchanged');
  await page.locator('[data-view="variants"]').click(); await select(2).check();
  assert.equal(await page.locator('[data-variant-selected-count]').innerText(), '2개 선택');
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await vAction('save').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /저장을 취소/);
  assert.equal(await select(0).isChecked(), true); assert.equal(await select(2).isChecked(), true);
  const zip = await saveSelected('chosen-only');
  const entries = Object.keys(zip).filter(name => name.endsWith('.baekho.json'));
  assert.equal(entries.length, 2); assert.ok(zip['README.txt']);
  const chosen = entries.map(name => parseProjectFile(JSON.parse(strFromU8(zip[name]))));
  assert.deepEqual(chosen.map(project => project.map.name), ['1번 후보 - 구조 1', '3번 후보 - 구조 3']);
  for (const project of chosen) { assert.deepEqual(project.bindings, original.bindings); assert.deepEqual(project.settings, original.settings); assert.equal(project.blueprintDataUrl, PNG); }

  console.log('variants smoke: detail controls, apply/Undo and native reopening');
  await cards().nth(2).locator('[data-v-view="3d"]').click();
  assert.equal(await page.locator('[data-variant-preview] canvas').count(), 1);
  assert.match(await page.locator('[data-variant-preview] .preview-connection-key').innerText(), /외부 연결 4개/);
  await vAction('ceilings').click(); assert.equal(await vAction('ceilings').getAttribute('aria-pressed'), 'true');
  await cards().nth(0).locator('[data-v-view="3d"]').click(); assert.equal(await vAction('ceilings').getAttribute('aria-pressed'), 'false');
  await cards().nth(2).locator('[data-v-view="3d"]').click(); assert.equal(await vAction('ceilings').getAttribute('aria-pressed'), 'true');
  assert.equal(await cards().evaluateAll(items => items.every(item => item.querySelector('.variant-card-actions').getBoundingClientRect().bottom <= item.getBoundingClientRect().bottom + 1)), true, 'Card actions must not be clipped');
  await page.locator('.variant-cards').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, 'gallery-1400.png') });
  const visibleBounds = await page.locator('.variant-gallery').boundingBox();
  assert.ok(visibleBounds.width > 800 && visibleBounds.height > 400);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1200, height: 900 }));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator('.variant-gallery').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await page.screenshot({ path: resolve(output, 'gallery-1200.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1400, height: 1000 }));
  await vAction('apply').click();
  assert.deepEqual(await saveCurrent('applied'), chosen[1]);
  await page.locator('[data-action="undo"]').click(); assert.deepEqual(await saveCurrent('undo-applied'), original);
  const reopenedPath = resolve(output, entries[0]); await writeFile(reopenedPath, zip[entries[0]]);
  await open(reopenedPath); assert.deepEqual(await saveCurrent('reopened'), chosen[0]);
  await open(originalPath); await page.locator('[data-view="variants"]').click();

  console.log('variants smoke: unsaved replacement guard and mid-batch cancellation');
  const oldIds = await cards().evaluateAll(items => items.map(item => item.dataset.variantCard));
  const beforeReplaceCalls = await callList();
  await page.locator('[data-action="generate-variants"]').click(); await page.locator('#replace-variants-dialog[open]').waitFor();
  await page.locator('#replace-variants-dialog button[value="cancel"]').click();
  assert.deepEqual(await callList(), beforeReplaceCalls);
  assert.deepEqual(await cards().evaluateAll(items => items.map(item => item.dataset.variantCard)), oldIds);
  await configure('cancel'); await page.locator('[data-action="generate-variants"]').click();
  await page.locator('#replace-variants-dialog button[value="replace"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.variant-card .status-ready').length === 1);
  assert.equal(await select(0).isChecked(), false, 'New batches must start with unchecked choices');
  await select(0).check(); await page.locator('[data-action="cancel"]').click(); await idle();
  assert.deepEqual(await callList(), ['image0', 'extract0', 'image1', 'cancel']);
  assert.equal(await page.locator('.variant-card .status-ready').count(), 1);
  assert.equal(await page.locator('.variant-card .status-cancelled').count(), 2);
  assert.equal(await select(0).isChecked(), true); assert.equal(await select(1).isDisabled(), true);
  assert.equal(Object.keys(await saveSelected('completed-before-cancel')).filter(name => name.endsWith('.baekho.json')).length, 1);

  console.log('variants smoke: duplicate geography and failed candidates stay unselectable');
  await configure('duplicate-failure'); await page.locator('[data-action="generate-variants"]').click(); await idle();
  assert.equal(await page.locator('.variant-card .status-ready').count(), 1); assert.equal(await page.locator('.variant-card .status-error').count(), 2);
  assert.equal(await select(0).isChecked(), false); assert.equal(await select(1).isDisabled(), true); assert.equal(await select(2).isDisabled(), true);
  assert.match(await cards().nth(1).innerText(), /중복 후보/); assert.match(await cards().nth(2).innerText(), /SMOKE candidate extraction failure/);
  await vAction('select-all').click(); assert.equal(await page.locator('[data-variant-selected-count]').innerText(), '1개 선택');
  await cards().nth(2).locator('.variant-cover').click(); assert.equal(await vAction('apply').isDisabled(), true);
  assert.deepEqual(await callList(), ['image0', 'extract0', 'image1', 'extract1', 'image2', 'extract2']);
  assert.deepEqual(await saveCurrent('original-after-cancel-and-failure'), original);
  assert.deepEqual(errors, []);
  console.log(`variants smoke passed: selected-only native ZIP, project isolation, apply/Undo, cancellation, duplicate/failure exclusion. ${output}`);
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
