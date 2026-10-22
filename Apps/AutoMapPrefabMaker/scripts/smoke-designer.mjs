import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { createDemoMap, DEFAULT_SETTINGS, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const { applyGeneratedFeatures, DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const output = resolve('.local/designer-smoke');
const userData = resolve('.local/designer-smoke-user', `run-${Date.now()}`);
await mkdir(output, { recursive: true });
await mkdir(userData, { recursive: true });
const fixture = resolve(output, 'TestUnity');
await mkdir(resolve(fixture, 'Assets/Modules'), { recursive: true });
await mkdir(resolve(fixture, 'ProjectSettings'), { recursive: true });
const roles = ['floor', 'wall', 'door', 'prop', 'stair'];
for (const [index, role] of roles.entries()) {
  await writeFile(resolve(fixture, `Assets/Modules/${role}.prefab`), '%YAML 1.1\n');
  await writeFile(resolve(fixture, `Assets/Modules/${role}.prefab.meta`), `fileFormatVersion: 2\nguid: ${String(index + 1).repeat(32)}\n`);
}
const comparisonProject = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: 'Smoke designer regression room' }, bindings: roles.map((role, index) => ({
  id: role, label: role, role, prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/Modules/${role}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
})) };
const comparisonPath = resolve(output, 'comparison.baekho.json');
await writeFile(comparisonPath, JSON.stringify(comparisonProject));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app }, directory) => app.setPath('userData', directory), userData);
  await app.evaluate(({ ipcMain, dialog }, png) => {
    globalThis.designerSmoke = { png, candidate: null, mode: 'success', calls: [], lastSettings: null };
    for (const channel of ['codex-status', 'generate-image', 'extract-layout', 'cancel-generation']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no paid AI calls', models: [] }));
    ipcMain.handle('baekho:generate-image', async (_event, settings, region) => {
      const state = globalThis.designerSmoke; state.calls.push('image'); state.lastSettings = settings; state.imageRegion = region;
      await new Promise(done => setTimeout(done, state.mode === 'slow-image' ? 1000 : 30));
      return state.png;
    });
    ipcMain.handle('baekho:extract-layout', async (_event, settings, _image, region) => {
      const state = globalThis.designerSmoke; state.calls.push('extract'); state.lastSettings = settings; state.extractionRegion = region;
      await new Promise(done => setTimeout(done, state.mode === 'slow-extract' ? 1000 : 30));
      if (state.mode === 'failure') throw new Error('SMOKE extraction failure');
      return state.candidate;
    });
    ipcMain.handle('baekho:cancel-generation', () => { globalThis.designerSmoke.calls.push('cancel'); });
    dialog.showMessageBoxSync = () => 1;
  }, PNG);
  await page.reload();
  await page.locator('#preview canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-action="codex"]')?.textContent?.includes('연결됨'));
  // This regression fixture deliberately retains legacy generation settings. New preset sizing
  // and measured level-design generation are exercised separately by smoke-v5.mjs.
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, comparisonPath);
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
  const action = name => page.locator(`[data-d-action="${name}"]`);
  const control = name => page.locator(`[data-d-control="${name}"]`);
  const input = async (name, value) => { await expandAll(); await control(name).fill(String(value)); await control(name).press('Tab'); await expandAll(); };
  const expandAll = async () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const idle = async () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const configure = async (mode, candidate) => app.evaluate((_electron, next) => {
    Object.assign(globalThis.designerSmoke, next, { calls: [], lastSettings: null, imageRegion: null, extractionRegion: null });
  }, { mode, candidate });
  const calls = async () => app.evaluate(() => globalThis.designerSmoke.calls);
  let saveIndex = 0;
  const save = async label => {
    const path = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await page.locator('[data-action="save"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/, `${label}: save failed`);
    return { path, project: JSON.parse(await readFile(path, 'utf8')) };
  };
  const choose = async (x, row, shift = false) => {
    await page.locator('[data-view="grid"]').click();
    await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate((svg, { x, row }) => {
      const p = new DOMPoint(x + .5, row + .5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
    }, { x, row });
    await page.mouse.click(point.x, point.y, { modifiers: shift ? ['Shift'] : [] });
  };
  const design = async () => { await page.locator('[data-right-tab="design"]').click(); await expandAll(); };

  console.log('designer smoke: presets, toggles and manual editing');
  assert.deepEqual(await control('preset').locator('option').evaluateAll(items => items.map(item => item.value)), ['battle', 'boss', 'reward', 'start', 'shop']);
  await control('preset').selectOption('boss'); await expandAll();
  assert.equal(await page.locator('[data-d-feature="enemies"]').isChecked(), true);
  assert.equal(await control('setting:enemyCount').inputValue(), '1');
  await control('preset').selectOption('battle');
  for (const name of ['ceilings', 'bridges', 'cliffs', 'lights']) { await expandAll(); await page.locator(`[data-d-feature="${name}"]`).check(); }
  assert.equal(await page.locator('[data-d-feature*="corridor"]').count(), 0);
  await choose(2, 2);
  await input('ceiling-y', 6);
  await action('add-cell-ceiling').click();
  assert.equal(await control('ceiling-y').inputValue(), '6', 'Unbuilt ceiling height must survive blur before adding');
  await design();
  await control('fixture-anchor').selectOption('ceiling'); await action('add-fixture').click();
  await input('fixture:offset.y', -.4);
  const lightId = await page.locator('[data-d-action="select-fixture"].selected').getAttribute('data-id');
  await control('fixture-role').selectOption('switch'); await control('fixture-anchor').selectOption('floor');
  await action('add-fixture').click(); await control('fixture:linkedId').selectOption(lightId);
  await control('marker-kind').selectOption('event'); await action('add-marker').click();
  await input('marker:label', '문 열기'); await input('marker:contentKey', 'gate_A'); await input('marker:offset.x', .25);
  await input('area-width', 2); await input('area-height', 2); await action('copy').click();
  await action('lock').click(); await action('area-floor').click();
  assert.match(await page.locator('#status').innerText(), /잠겨/);
  await action('unlock').click();
  await input('template-name', 'Smoke 천장 방'); await action('save-template').click();
  await choose(5, 5); await design(); await action('paste').click();
  let saved = await save('manual');
  assert.equal(saved.project.map.ceilings.find(c => c.x === 5 && c.row === 5).undersideY, 6);
  assert.equal(saved.project.map.fixtures.length, 4); assert.equal(saved.project.map.markers.length, 2);
  assert.equal(saved.project.map.fixtures.find(f => f.id === lightId).offset.y, -.4);
  const pastedSwitch = saved.project.map.fixtures.find(f => f.x === 5 && f.row === 5 && f.role === 'switch');
  assert.notEqual(pastedSwitch.linkedId, lightId);
  assert.equal(saved.project.map.markers[1].offset.x, .25);
  await control('preset').selectOption('boss'); await design();
  await control('template-choice').selectOption('Smoke 천장 방'); await expandAll(); await action('load-template').click();
  assert.equal(await control('preset').inputValue(), 'battle');
  await action('view-ceiling').click(); await action('view-character').click();
  assert.equal(await action('view-ceiling').getAttribute('aria-pressed'), 'true');
  assert.equal(await action('view-character').getAttribute('aria-pressed'), 'true');
  saved = await save('templates');
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, saved.path);
  await page.locator('[data-action="open"]').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
  assert.deepEqual((await save('roundtrip')).project, saved.project);

  console.log('designer smoke: recovery and native comparison scan provenance');
  await page.locator('#prompt').fill('Smoke recovery prompt');
  let recovery = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    recovery = await page.evaluate(() => window.baekho.loadRecovery());
    if (recovery?.settings.prompt === 'Smoke recovery prompt') break;
    await page.waitForTimeout(200);
  }
  assert.equal(recovery?.settings.prompt, 'Smoke recovery prompt', 'Native autosave must finish before reloading');
  await page.reload(); await page.locator('[data-action="recover"]').waitFor(); await page.locator('[data-action="recover"]').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Smoke recovery prompt');
  const recovered = (await save('recovered')).project;
  assert.equal(recovered.map.fixtures.length, 4); assert.equal(recovered.map.markers.length, 2);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixture);
  await page.locator('[data-right-tab="assets"]').click(); await page.locator('[data-action="scan"]').click(); await idle();
  assert.match(await page.locator('.asset-project').innerText(), /프리팹 5개/);
  await design();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, comparisonPath);
  await action('compare-open').click(); await action('compare-close').waitFor();
  assert.equal(await control('port-a').locator('option').count(), 4);
  await page.locator('[data-right-tab="assets"]').click(); assert.match(await page.locator('.asset-project').innerText(), /프리팹 5개/);
  const zipPath = resolve(output, 'provenance-after-comparison.zip');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
  assert.equal(await page.evaluate(project => window.baekho.exportBundle(project), comparisonProject), zipPath);
  assert.equal(JSON.parse(strFromU8(unzipSync(await readFile(zipPath))['Map.baekhomap.json'])).schemaVersion, 4);
  await design(); await action('compare-close').click();

  console.log('designer smoke: one-click chain, draft recovery, cancellation and region retry');
  await control('preset').selectOption('battle');
  for (const name of ['ceilings', 'lights']) { await expandAll(); await page.locator(`[data-d-feature="${name}"]`).check(); }
  const generationSettings = (await save('generation-settings')).project.settings;
  const generated = applyGeneratedFeatures(createDemoMap(), generationSettings); generated.name = 'Smoke generated room';
  assert.deepEqual(validateMap(generated).filter(i => i.severity === 'error'), []);
  await configure('success', generated); await page.locator('[data-action="generate"]').click(); await idle();
  assert.deepEqual(await calls(), ['image', 'extract']);
  const generatedProject = (await save('generated')).project;
  assert.deepEqual(generatedProject.map, generated); assert.equal(generatedProject.blueprintDataUrl, PNG); assert.equal(generatedProject.generationDraft, undefined);
  await configure('failure', generated); await page.locator('[data-action="generate"]').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /SMOKE extraction failure/);
  let failed = (await save('failed-draft')).project;
  assert.deepEqual(failed.map, generatedProject.map); assert.equal(failed.generationDraft.imageDataUrl, PNG);
  await configure('success', generated); await expandAll(); await page.locator('[data-action="extract"]').click(); await idle();
  assert.deepEqual(await calls(), ['extract']); assert.equal((await save('retried')).project.generationDraft, undefined);
  for (const mode of ['slow-image', 'slow-extract']) {
    const cancelled = structuredClone(generated); cancelled.name = `Must not commit ${mode}`;
    await configure(mode, cancelled); await page.locator('[data-action="generate"]').click();
    if (mode === 'slow-extract') await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('2/3'));
    await page.locator('[data-action="cancel"]').click(); await idle();
    assert.ok((await calls()).includes('cancel'));
    assert.deepEqual((await save(`cancel-${mode}`)).project.map, generated);
  }
  for (const name of ['elevation', 'props', 'lights', 'enemies', 'rewards']) { await expandAll(); await page.locator(`[data-d-feature="${name}"]`).uncheck(); }
  await input('setting:ceilingHeight', 7);
  await choose(5, 5); await design();
  const regionCandidate = structuredClone(generated);
  regionCandidate.ceilings.find(c => c.x === 6 && c.row === 5).undersideY = 11;
  regionCandidate.name = 'Must not replace entire room';
  await configure('failure', regionCandidate); await action('regenerate').click(); await idle();
  failed = (await save('region-failed')).project;
  assert.deepEqual(failed.generationDraft.region, { x: 5, row: 5, width: 1, height: 1 });
  assert.deepEqual(await app.evaluate(() => globalThis.designerSmoke.imageRegion), failed.generationDraft.region);
  await configure('success', regionCandidate); await expandAll(); await page.locator('[data-action="extract"]').click(); await idle();
  const regionResult = (await save('region-retried')).project;
  assert.deepEqual(await app.evaluate(() => globalThis.designerSmoke.extractionRegion), failed.generationDraft.region);
  assert.equal(regionResult.map.name, generated.name);
  assert.equal(regionResult.map.ceilings.find(c => c.x === 5 && c.row === 5).undersideY, 9);
  assert.equal(regionResult.map.ceilings.find(c => c.x === 6 && c.row === 5).undersideY, generated.ceilings.find(c => c.x === 6 && c.row === 5).undersideY);
  assert.deepEqual(regionResult.map.connections, generated.connections); assert.equal(regionResult.generationDraft, undefined);
  await page.locator('[data-view="3d"]').click(); await design();
  await page.screenshot({ path: resolve(output, 'designer-final.png') });
  assert.deepEqual(errors, []);
  console.log('PASS designer smoke: presets/toggles, ceilings/fixtures/markers, offsets/links, region copy/locks, templates, save/open/recovery, comparison scan provenance, one-click generation, failure drafts, stale cancellation, region retry, zero renderer errors. No paid AI calls.');
} finally {
  await app.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
  await app.close();
}
