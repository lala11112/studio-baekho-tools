// Exercise real native project scanning separately from bounds import, with isolated app data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-project-connection.mjs [path/to/Baekho Map Forge.exe]');
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const { DEFAULT_SETTINGS, createDemoMap, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const output = resolve('.local/project-connection-smoke');
const userData = resolve(output, `user-${Date.now()}`);
const unityProject = resolve(output, 'UnityProject');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets'), { recursive: true }), mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
const assets = Array.from({ length: 72 }, (_, index) => ({
  name: `Prefab-${String(index + 1).padStart(2, '0')}`, guid: (index + 1).toString(16).padStart(32, '0'),
}));
for (const asset of assets) {
  const path = resolve(unityProject, 'Assets', `${asset.name}.prefab`);
  await writeFile(path, `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${asset.name}\n`);
  await writeFile(`${path}.meta`, `fileFormatVersion: 2\nguid: ${asset.guid}\n`);
}
const empty = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings: [] });
const existing = parseProjectFile({ ...empty, bindings: assets.slice(0, 2).map((asset, index) => ({
  id: `existing_${index}`, label: asset.name, role: index ? 'prop' : 'floor', prefabGuid: asset.guid,
  prefabPath: `Assets/${asset.name}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  ...(index ? { prop: { category: '기존 소품', tags: [], size: { x: 1, y: 1, z: 1 }, blocksMovement: true,
    placement: 'floor', roomTypes: ['battle', 'boss', 'reward', 'start', 'shop'], weight: 1 } } : {}),
})) });
const paths = { empty: resolve(output, 'empty.baekho.json'), existing: resolve(output, 'existing.baekho.json'), catalog: resolve(output, 'eleven-bounds.json') };
await Promise.all([writeFile(paths.empty, JSON.stringify(empty)), writeFile(paths.existing, JSON.stringify(existing)),
  writeFile(paths.catalog, JSON.stringify({ version: 1, assets: assets.slice(2, 13).map(({ guid }) => ({ guid, size: { x: .75, y: 1, z: .75 } })) }))]);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
const errors = [], observations = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); BrowserWindow.getAllWindows()[0].setBounds({ width: 1480, height: 1000 });
    dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Isolated project connection regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const version = await app.evaluate(({ app }) => app.getVersion());
  const action = name => page.locator(`[data-action="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const choose = path => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const open = async path => {
    await choose(path); await action('open').click();
    if (await page.locator('#discard-dialog[open]').count()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
    await page.locator('[data-right-tab="assets"]').click();
  };
  let serial = 0;
  const save = async label => {
    const path = resolve(output, `${String(++serial).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await action('save').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return parseProjectFile(JSON.parse(await readFile(path, 'utf8')));
  };
  const scanUnchanged = async (label, before) => {
    const undoDisabled = await action('undo').isDisabled(), redoDisabled = await action('redo').isDisabled();
    await choose(unityProject); await action('scan').click(); await idle();
    const status = await page.locator('#status').innerText();
    assert.equal(await page.locator('.footer.error').count(), 0, status);
    assert.equal(await page.locator('#newAssetGuid option[value]:not([value=""])').count(), 72, 'all project prefabs are in the picker');
    assert.equal(await page.locator('[data-asset-card]').count(), before.bindings.length, `${label}: only prior bindings are registered`);
    assert.equal(await action('undo').isDisabled(), undoDisabled, `${label}: no history is added`);
    assert.equal(await action('redo').isDisabled(), redoDisabled, `${label}: existing redo is preserved`);
    assert.deepEqual(await save(label), before, `${label}: scan changes no saved map, settings or bindings`);
    observations.push({ label, scanned: 72, registered: before.bindings.length, status });
    console.log(`PASS ${label}: picker 72, registered ${before.bindings.length}, map/bindings/history unchanged`);
  };

  await open(paths.empty);
  await scanUnchanged('empty-connect', empty);
  await page.screenshot({ path: resolve(output, 'empty-connect.png') });
  await scanUnchanged('empty-reconnect', empty);
  await open(paths.existing);
  await scanUnchanged('existing-connect', existing);
  await page.locator('#newAssetRole').selectOption('prop'); await page.locator('#newAssetGuid').selectOption(assets[20].guid);
  await action('add-binding').click(); const manual = await save('manually-added');
  assert.equal(manual.bindings.length, existing.bindings.length + 1);
  await scanUnchanged('history-connect', manual);
  await action('undo').click(); assert.deepEqual(await save('manual-undo'), existing);
  await scanUnchanged('redo-preserved-connect', existing);
  await action('redo').click(); assert.deepEqual(await save('manual-redo'), manual);
  await choose(paths.catalog); await action('import-prop-catalog').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /신규 등록 11개/);
  const imported = await save('eleven-imported'); assert.equal(imported.bindings.length, manual.bindings.length + 11);
  await scanUnchanged('cached-catalog-connect', imported);
  assert.equal(await page.locator('[data-prop-catalog-count]').getAttribute('data-prop-catalog-count'), '11');
  await scanUnchanged('cached-catalog-reconnect', imported);
  await page.screenshot({ path: resolve(output, 'cached-catalog-connect.png') });
  await action('undo').click(); assert.deepEqual(await save('import-undo-after-reconnect'), manual);
  await action('redo').click(); assert.deepEqual(await save('import-redo-after-reconnect'), imported);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', version, executablePath, observations, errors }, null, 2));
  console.log(`PASS actual project connection ${version}: no registration from scan, existing data/history preserved; ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
