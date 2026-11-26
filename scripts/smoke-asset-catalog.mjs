// Real Electron/preload/renderer, with controlled Unity responses and native file dialogs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { DEFAULT_SETTINGS, createDemoMap, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const { ASSET_ROLES } = await tsImport('../src/shared/features.ts', import.meta.url);
const { insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
const output = resolve('.local/asset-catalog-smoke'), userData = resolve(output, `user-${Date.now()}`);
const unityProject = resolve(output, 'UnityProject');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets'), { recursive: true }),
  mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
const assets = ASSET_ROLES.map((role, index) => ({ name: `Marked-${role}`, path: `Assets/Marked-${role}.prefab`, guid: (index + 1).toString(16).padStart(32, '0') }));
const size = { x: .5, y: .5, z: .5 }, bounds = { center: { x: 0, y: .25, z: 0 }, size };
const catalog = { format: 'baekho-asset-catalog', version: 1,
  assets: assets.map((asset, index) => ({ guid: asset.guid, path: asset.path, role: ASSET_ROLES[index], size: { ...size }, bounds: structuredClone(bounds) })),
  skipped: [{ path: 'Assets/Unspecified.prefab', reason: '종류를 지정해 주세요.' },
    { path: 'Assets/Excluded.prefab', reason: '등록 제외 <img src=x onerror=alert(1)>' }],
};
for (const asset of assets) {
  await writeFile(resolve(unityProject, asset.path), `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${asset.name}\n`);
  await writeFile(resolve(unityProject, `${asset.path}.meta`), `fileFormatVersion: 2\nguid: ${asset.guid}\n`);
}
const fixture = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings: [] });
const input = resolve(output, 'empty.baekho.json');
await writeFile(input, JSON.stringify(fixture));
const response = { catalog, scan: { projectPath: unityProject, assets, warnings: [] }, warnings: [] };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
const errors = [], observations = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, { userData, response }) => {
    app.setPath('userData', userData); BrowserWindow.getAllWindows()[0].setBounds({ width: 1480, height: 1000 });
    dialog.showMessageBoxSync = () => 1;
    globalThis.assetCatalogSmoke = { response, calls: 0, failure: '' };
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Isolated asset catalog test', models: [] }));
    ipcMain.removeHandler('baekho:import-unity-asset-catalog');
    ipcMain.handle('baekho:import-unity-asset-catalog', () => {
      const state = globalThis.assetCatalogSmoke; state.calls++;
      if (state.failure) throw new Error(state.failure);
      return state.response;
    });
  }, { userData, response });
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = name => page.locator(`[data-action="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const choose = path => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const setResponse = response => app.evaluate((_electron, response) => {
    globalThis.assetCatalogSmoke.response = response; globalThis.assetCatalogSmoke.failure = '';
  }, response);
  const open = async path => {
    await choose(path); await action('open').click();
    if (await page.locator('#discard-dialog[open]').count()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); await page.locator('[data-right-tab="assets"]').click();
  };
  const connect = async () => { await choose(unityProject); await action('scan').click(); await idle(); };
  const importAssets = async () => { await action('import-unity-asset-catalog').click(); await idle(); };
  let serial = 0;
  const save = async label => {
    const path = resolve(output, `${++serial}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, path);
    await action('save').click(); await idle();
    return parseProjectFile(JSON.parse(await readFile(path, 'utf8')));
  };
  await open(input);
  assert.equal(await page.evaluate(() => typeof window.baekho.importUnityAssetCatalog), 'function');
  assert.equal(await action('import-unity-asset-catalog').isDisabled(), true);
  await connect(); assert.equal(await action('import-unity-asset-catalog').isDisabled(), false);
  await importAssets();
  assert.match(await page.locator('#status').innerText(), new RegExp(`신규 등록 ${assets.length}개`));
  assert.equal(await page.locator('[data-unity-catalog-result] img').count(), 0, 'diagnostics are escaped');
  const initial = await save('all-roles');
  assert.equal(initial.bindings.length, ASSET_ROLES.length);
  assert.deepEqual(initial.map, fixture.map, 'registration does not rearrange map');
  assert.deepEqual(new Set(initial.bindings.map(binding => binding.role)), new Set(ASSET_ROLES));
  assert.equal(initial.bindings.find(binding => binding.role === 'floor').scale.x, fixture.map.cellSize);
  assert.equal(initial.bindings.find(binding => binding.role === 'prop').scale.x, 1);
  assert.deepEqual(initial.bindings.find(binding => binding.role === 'door').scale, { x: 1, y: 1, z: 1 }, 'authored doorway starts at native scale');
  await page.locator('[data-unity-catalog-result] summary').filter({ hasText: '종류별 등록 결과' }).click();
  assert.match(await page.locator('.catalog-counts tbody tr').first().innerText(), /바닥\s+1\s+0/);
  await page.locator('[data-unity-catalog-result] summary').filter({ hasText: '종류별 등록 결과' }).click();
  await page.locator('[data-unity-catalog-result]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'all-roles.png') });
  observations.push('all roles in one click, skipped details, original map unchanged');
  const bundlePath = resolve(output, 'asset-catalog-export.zip');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, bundlePath);
  await action('export').click(); await idle();
  const bundle = unzipSync(await readFile(bundlePath));
  for (const file of ['Runtime/BaekhoMapAsset.cs', 'Editor/BaekhoMapAssetEditor.cs', 'Editor/BaekhoAssetCatalog.cs', 'Runtime/BaekhoPropSet.cs', 'Editor/BaekhoPropSetEditor.cs']) {
    assert.equal(strFromU8(bundle[`Unity/${file}`]), await readFile(resolve('unity-importer', file), 'utf8'), `ZIP ships complete ${file}`);
  }
  assert.ok(!Object.keys(bundle).some(name => /GetAssetCatalogTool|BuildMapTool/.test(name)));
  observations.push('real export includes matching metadata scripts and remains independent of MCP');
  await importAssets(); assert.deepEqual(await save('repeat'), initial);
  await action('undo').click(); assert.deepEqual((await save('undo')).bindings, []);
  await action('redo').click(); assert.deepEqual(await save('redo'), initial);
  observations.push('repeat import has no duplicate or redundant history; one Undo/Redo');

  const custom = structuredClone(initial), floor = custom.bindings.find(binding => binding.role === 'floor');
  floor.label = '내 바닥'; floor.scale.x = 3; floor.offset.y = .15; floor.rotationY = 90;
  const prop = custom.bindings.find(binding => binding.role === 'prop');
  prop.prop.category = '사용자 소품'; prop.prop.weight = 7;
  const customPath = resolve(output, 'custom.baekho.json'); await writeFile(customPath, JSON.stringify(custom));
  await open(customPath); await connect();
  const moved = structuredClone(response), sourceFloor = moved.catalog.assets.find(entry => entry.role === 'floor');
  sourceFloor.path = 'Assets/Moved-floor.prefab'; sourceFloor.label = 'Unity rename'; sourceFloor.scale = { x: 9, y: 9, z: 9 };
  sourceFloor.size = { x: 2, y: 1, z: 2 }; sourceFloor.bounds.size = { ...sourceFloor.size };
  moved.scan.assets.find(asset => asset.guid === sourceFloor.guid).path = sourceFloor.path;
  await setResponse(moved); await importAssets();
  const refreshed = await save('moved-and-measured');
  const actualFloor = refreshed.bindings.find(binding => binding.id === floor.id);
  assert.deepEqual(actualFloor, { ...floor, prefabPath: sourceFloor.path, bounds: sourceFloor.bounds });
  assert.deepEqual(refreshed.bindings.find(binding => binding.id === prop.id), prop);
  observations.push('moved path and bounds update while app label/scale/offset/rotation/prop settings persist');

  await setResponse({ ...moved, catalog: { ...moved.catalog, assets: [] } }); await importAssets();
  assert.deepEqual(await save('absent-retained'), refreshed);
  await app.evaluate(() => { globalThis.assetCatalogSmoke.failure = 'Unity MCP 연결이 끊어졌습니다.'; });
  await importAssets(); assert.match(await page.locator('#status').innerText(), /연결이 끊어/);
  assert.deepEqual(await save('disconnected'), refreshed);
  const invalid = structuredClone(moved); invalid.catalog.assets[0].size.x = -1;
  await setResponse(invalid); await importAssets();
  assert.equal(await page.locator('.footer.error').count(), 1); assert.deepEqual(await save('malformed'), refreshed);
  observations.push('absent entries are retained; disconnect and malformed response do not partially apply');

  const placed = structuredClone(initial);
  let inserted = false;
  for (let row = 1; row < placed.map.height - 1 && !inserted; row++) for (let x = 1; x < placed.map.width - 1 && !inserted; x++) {
    try { placed.map = insertPropInstance(placed.map, { x, row }, prop.id, placed.settings, placed.bindings); inserted = true; } catch { /* find a valid free cell */ }
  }
  assert.ok(inserted);
  const placedPath = resolve(output, 'placed.baekho.json'); await writeFile(placedPath, JSON.stringify(placed));
  await open(placedPath); await connect();
  const resized = structuredClone(response), sourceProp = resized.catalog.assets.find(entry => entry.role === 'prop');
  sourceProp.size = { x: 3, y: 3, z: 3 }; sourceProp.bounds.size = { ...sourceProp.size };
  await setResponse(resized); await importAssets();
  assert.equal(await page.locator('.footer.error').count(), 1);
  assert.deepEqual(await save('occupied-size-rejected'), placed);
  observations.push('changed measurement that invalidates an existing placement rolls back entire import');

  await open(input); await connect();
  const withSets = structuredClone(response);
  const memberGuids = withSets.catalog.assets.filter(entry => ['prop', 'decoration', 'vegetation'].includes(entry.role)).map(entry => entry.guid);
  withSets.catalog.propSets = [{ guid: 'a'.repeat(32), path: 'Assets/WorkArea.asset', label: '작업 구역 <img src=x>', usage: 'equipment', arrangement: 'either', prefabGuids: memberGuids }];
  await setResponse(withSets); await importAssets();
  assert.match(await page.locator('[data-unity-catalog-result]').innerText(), /Unity 세트 1개 · 소속 프리팹 3종/);
  const setsImported = await save('sets-imported'), member = setsImported.bindings.find(binding => binding.role === 'prop');
  assert.equal(member.prop.unitySets[0].guid, 'a'.repeat(32));
  assert.deepEqual(setsImported.map, fixture.map);
  const card = page.locator(`[data-asset-card="${member.id}"]`);
  const expandLibrary = async () => { if (!await card.locator('.prop-library').evaluate(element => element.open)) await card.locator('.prop-library > summary').click(); };
  await expandLibrary();
  assert.equal(await card.locator('[data-prop-composition-state="unity"]').count(), 1);
  assert.equal(await card.locator('[data-prop-field="composition.family"]').count(), 0);
  assert.equal(await card.locator('[data-unity-prop-sets] img').count(), 0);
  await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'unity-prop-set.png') });
  await card.locator('[data-prop-field="composition.mode"]').selectOption('manual'); await idle(); await expandLibrary();
  await card.locator('[data-prop-field="composition.usage"]').selectOption('excluded'); await idle();
  const overridden = await save('set-manual-override');
  const renamed = structuredClone(withSets); renamed.catalog.propSets[0].label = '이름 변경';
  await setResponse(renamed); await importAssets();
  const renameSaved = await save('set-renamed');
  assert.equal(renameSaved.bindings.find(binding => binding.id === member.id).prop.unitySets[0].label, '이름 변경');
  assert.deepEqual(renameSaved.bindings.find(binding => binding.id === member.id).prop.composition, overridden.bindings.find(binding => binding.id === member.id).prop.composition);
  await expandLibrary(); await card.locator('[data-prop-field="composition.mode"]').selectOption('automatic'); await idle();
  assert.equal((await save('set-automatic')).bindings.find(binding => binding.id === member.id).prop.composition, undefined);
  await setResponse({ ...renamed, catalog: { ...renamed.catalog, propSets: [] } }); await importAssets();
  assert.equal((await save('sets-removed')).bindings.find(binding => binding.id === member.id).prop.unitySets, undefined);
  await action('undo').click();
  assert.equal((await save('sets-removal-undone')).bindings.find(binding => binding.id === member.id).prop.unitySets[0].label, '이름 변경');
  await card.locator(`[data-binding="${member.id}"]`).selectOption(assets[0].guid); await idle();
  assert.equal((await save('set-member-reassigned')).bindings.find(binding => binding.id === member.id).prop.unitySets, undefined, 'changing prefab identity clears source set membership');
  observations.push('Unity list import, simplified escaped UI, source refresh, manual override, return to sets, removal, Undo and identity reassignment');
  assert.deepEqual(errors, []);
  const result = { result: 'PASS', roles: ASSET_ROLES.length, observations, errors };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
