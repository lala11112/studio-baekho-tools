// Real Electron: semantic catalog edits, grouped rearrangement, Undo, save/reopen. No AI or Unity launch.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
const output = resolve('.local/grouped-furnishing-smoke'), userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, width: 24, height: 20, connectionCount: 1, conceptMode: 'manual', seed: 237,
  prompt: 'Grouped furnishing UI regression', levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 },
  designer: { ...DEFAULT_DESIGNER, props: true, decorations: false, vegetation: false, elevation: false,
    ceilings: false, enemies: false, rewards: false, propLayout: 'balanced', propCoverage: 8 } };
const bindings = [['console', '제어 콘솔'], ['generator', '발전기'], ['crate', '적재 상자'], ['panel', '바닥 패널']].map(([id, label], index) => ({
  id, role: 'prop', label, prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: label, tags: [], size: { x: 1.2, y: id === 'panel' ? .1 : 1.4, z: 1.2 }, placement: 'floor', blocksMovement: true, roomTypes: ['battle'], weight: 1 },
}));
let map = { version: 5, name: '흩어진 소품 재정리', width: 24, height: 20, cellSize: 2, maxStepHeight: .4,
  rows: ['############D###########', ...Array(18).fill('#......................#'), '########################'],
  elevations: Array.from({ length: 20 }, () => Array(24).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'entry', label: '입구', x: 12, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
for (const [x, row, id] of [[3, 4, 'console'], [7, 5, 'generator'], [17, 4, 'crate'], [20, 8, 'crate'], [4, 14, 'console'], [17, 15, 'generator'], [6, 10, 'crate'], [20, 14, 'crate'], [2, 17, 'crate']]) {
  map = insertPropInstance(map, { x, row }, id, settings, bindings);
}
for (let index = 0; index < map.propInstances.length; index++) {
  const instance = map.propInstances[index]; instance.id = `scattered-${index}`;
  instance.authored = index === 6;
  if (index < 6 || index === 7) instance.provenance = 'generated';
  else if (index === 6) instance.provenance = 'manual';
  else delete instance.provenance;
}
map.lockedCells = [{ x: 20, row: 14 }];
const fixture = parseProjectFile({ formatVersion: 1, settings, bindings, map });
const input = resolve(output, 'scattered.baekho.json'); await writeFile(input, JSON.stringify(fixture));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1000 });
    globalThis.groupedSmokeCalls = [];
    for (const channel of ['codex-status', 'generate-concept', 'generate-image', 'extract-layout']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local grouped regression', models: [] }));
    for (const channel of ['generate-concept', 'generate-image', 'extract-layout']) ipcMain.handle(`baekho:${channel}`, () => { globalThis.groupedSmokeCalls.push(channel); throw new Error('Unexpected AI call'); });
    dialog.showMessageBoxSync = () => 1;
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = name => page.locator(`[data-action="${name}"]`);
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const assetsTab = async () => { await page.locator('[data-right-tab="assets"]').click(); await expand(); };
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const open = async path => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, path);
    await action('open').click();
    if (await page.locator('#discard-dialog[open]').isVisible()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다')); await assetsTab();
  };
  const save = async label => {
    const path = resolve(output, `${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await action('save').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return { path, project: parseProjectFile(JSON.parse(await readFile(path, 'utf8'))) };
  };
  const field = (id, name) => page.locator(`[data-prop-binding="${id}"][data-prop-field="composition.${name}"]`);
  await open(input);
  assert.equal(await field('console', 'usage').inputValue(), 'equipment');
  assert.equal(await field('crate', 'usage').inputValue(), 'storage');
  assert.equal(await field('panel', 'usage').inputValue(), 'floorDetail');
  assert.equal(await field('console', 'mode').inputValue(), 'automatic');
  await field('console', 'family').fill('machinery'); await field('console', 'family').press('Tab'); await expand();
  await field('generator', 'family').fill('machinery'); await field('generator', 'family').press('Tab'); await expand();
  assert.equal(await field('console', 'mode').inputValue(), 'manual');
  await field('console', 'arrangement').selectOption('wall'); await expand();
  const configured = await save('configured');
  assert.equal(configured.project.bindings.find(binding => binding.id === 'console').prop.composition.family, 'machinery');
  await field('console', 'family').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'composition-catalog.png') });
  assert.equal(await page.locator('[data-furnish-control="includeUnknown"]').isChecked(), false);
  assert.equal(await page.locator('[data-furnish-control="layout"]').inputValue(), 'balanced');
  await action('rearrange-props').click(); await idle(); await expand();
  assert.equal(await page.locator('.footer.error').count(), 0, await page.locator('#status').innerText());
  const report = await page.locator('[data-furnish-result]').innerText();
  assert.match(report, /묶음 \d+개 · 이동 \d+개 · 보존 \d+개 · 추가 \d+개 · 제외 \d+개/);
  assert.match(report, /생성 출처가 없는 기존 소품 1개/, 'unknown-provenance content is reported as preserved until explicitly included');
  const rearranged = await save('rearranged');
  assert.notDeepEqual(rearranged.project.map, configured.project.map);
  assert.deepEqual(rearranged.project.settings, configured.project.settings, 'one-time rearrangement preserves future generation settings');
  const groups = new Set(rearranged.project.map.propInstances.map(instance => instance.groupId).filter(Boolean));
  assert.ok(groups.size > 0, 'rearrangement creates semantic group metadata');
  assert.ok(groups.size > 5, 'small measured props continue toward the coverage target beyond the former five-group room limit');
  for (const groupId of groups) {
    const members = rearranged.project.map.propInstances.filter(instance => instance.groupId === groupId);
    assert.ok(members.length >= 2 && members.length <= 4, 'additional groups keep the compact two-to-four member composition');
  }
  for (const index of [6, 7, 8]) assert.deepEqual(rearranged.project.map.propInstances.find(instance => instance.id === `scattered-${index}`), configured.project.map.propInstances.find(instance => instance.id === `scattered-${index}`), 'manual, locked and unknown placements survive');
  await page.locator('[data-furnish-result]').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'rearranged-preview.png') });
  await action('undo').click(); assert.deepEqual((await save('undo')).project, configured.project, 'one Undo restores all placements and groups');
  await action('redo').click(); assert.deepEqual((await save('redo')).project, rearranged.project);
  await open(rearranged.path);
  assert.equal(await field('console', 'mode').inputValue(), 'manual');
  assert.equal(await field('console', 'family').inputValue(), 'machinery');
  assert.deepEqual((await save('reopened')).project, rearranged.project, 'save/reopen retains grouped provenance and explicit asset metadata');
  await field('console', 'mode').selectOption('automatic'); await expand();
  assert.equal(await field('console', 'family').inputValue(), 'control-station');
  assert.equal((await save('automatic')).project.bindings.find(binding => binding.id === 'console').prop.composition, undefined);
  await action('undo').click(); await expand(); assert.equal(await field('console', 'family').inputValue(), 'machinery');
  await page.locator('[data-furnish-control="includeUnknown"]').check(); await expand();
  assert.equal(await page.locator('[data-furnish-control="includeUnknown"]').isChecked(), true);
  await action('rearrange-props').click(); await idle(); await expand();
  const included = await save('include-unknown');
  for (const index of [6, 7]) assert.deepEqual(included.project.map.propInstances.find(instance => instance.id === `scattered-${index}`), configured.project.map.propInstances.find(instance => instance.id === `scattered-${index}`), 'include unknown never overrides manual placements or locks');
  await page.locator('[data-furnish-result]').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'grouped-preview.png') });
  assert.deepEqual(await app.evaluate(() => globalThis.groupedSmokeCalls), []);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', groups: groups.size, report, aiCalls: 0 }, null, 2));
  console.log(`PASS grouped catalog edits, rearrangement, protected content, Undo/Redo, save/reopen, zero AI calls: ${output}`);
} finally { await app.close(); }
