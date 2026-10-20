// Real Electron dialogs and renderer: a bounds import registers eleven prefabs in one undoable edit.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-prop-catalog.mjs [path/to/Baekho Map Forge.exe]');
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const { DEFAULT_SETTINGS, MAX_BINDINGS, createDemoMap, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const output = resolve('.local/prop-catalog-smoke');
const userData = resolve(output, `user-${Date.now()}`);
const unityProject = resolve(output, 'SelectionUnityProject');
const guid = index => (0xa0 + index).toString(16).padStart(32, '0');
const prefabs = Array.from({ length: 11 }, (_, index) => ({
  name: `Crate-${String(index + 1).padStart(2, '0')}`, guid: guid(index),
  size: { x: (index + 1) / 4, y: (index + 2) / 2, z: (index + 3) / 4 },
}));
const unmeasured = { name: 'Unmeasured', guid: guid(20) };
const unrelatedPrefabs = Array.from({ length: 60 }, (_, index) => ({
  name: `Unselected-${String(index + 1).padStart(2, '0')}`, guid: guid(100 + index),
}));
const projectPrefabs = [...prefabs, unmeasured, ...unrelatedPrefabs];
const foreign = guid(30), changedSize = { x: 2.25, y: 3.5, z: 4.75 };
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets'), { recursive: true }),
  mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
for (const asset of projectPrefabs) {
  const path = resolve(unityProject, 'Assets', `${asset.name}.prefab`);
  await writeFile(path, `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${asset.name}\n`);
  await writeFile(`${path}.meta`, `fileFormatVersion: 2\nguid: ${asset.guid}\n`);
}
const fixture = parseProjectFile({ formatVersion: 1, map: createDemoMap(), settings: DEFAULT_SETTINGS, bindings: [] });
const fixturePath = resolve(output, 'empty.baekho.json');
const catalogPath = resolve(output, 'eleven-bounds.json');
const partialPath = resolve(output, 'partial-bounds.json');
const emptyPath = resolve(output, 'empty-bounds.json');
const invalidPath = resolve(output, 'invalid-bounds.json');
const unmatchedPath = resolve(output, 'unmatched-bounds.json');
const vegetationPath = resolve(output, 'vegetation-bounds.json');
const wallPath = resolve(output, 'wall-mounted-v2-bounds.json');
const wallEntry = {
  guid: unrelatedPrefabs[0].guid,
  size: { x: .6, y: .4, z: .2 },
  bounds: { center: { x: 0, y: 0, z: .1 }, size: { x: .6, y: .4, z: .2 } },
  wallMount: { kind: 'single', family: '', sites: ['wall', 'doorTop'], heightMode: 'center', height: 0,
    spacing: 3, probability: 100, doorSide: 'both',
    mounts: [{ position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }], sockets: [], collisionBoxes: [] },
};
await Promise.all([
  writeFile(fixturePath, JSON.stringify(fixture)),
  writeFile(catalogPath, '\uFEFF' + JSON.stringify({ version: 1, assets: prefabs.map(({ guid, size }) => ({ guid: guid.toUpperCase(), size })) })),
  writeFile(partialPath, JSON.stringify({ version: 1, assets: [
    { guid: prefabs[0].guid, size: changedSize }, { guid: foreign, size: { x: 9, y: 9, z: 9 } },
  ] })),
  writeFile(emptyPath, JSON.stringify({ version: 1, assets: [] })),
  writeFile(invalidPath, JSON.stringify({ version: 1, assets: [{ guid: prefabs[0].guid, size: { x: 0, y: 3, z: 4 } }] })),
  writeFile(unmatchedPath, JSON.stringify({ version: 1, assets: [{ guid: foreign, size: { x: 9, y: 9, z: 9 } }] })),
  writeFile(vegetationPath, JSON.stringify({ version: 1, assets: [{ guid: unmeasured.guid, size: { x: .5, y: 2, z: .75 } }] })),
  writeFile(wallPath, JSON.stringify({ version: 2, assets: [wallEntry] })),
]);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const userDataArg = `--user-data-dir=${userData}`;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
  args: executablePath ? [userDataArg] : ['.', userDataArg], env });
const errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); BrowserWindow.getAllWindows()[0].setBounds({ width: 1480, height: 1000 });
    dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local prop catalog regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = name => page.locator(`[data-action="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const dialogs = responses => app.evaluate(({ dialog }, values) => {
    globalThis.catalogSmokeDialogs = { remaining: values, calls: [] };
    dialog.showOpenDialog = async (...args) => {
      const state = globalThis.catalogSmokeDialogs; state.calls.push(args.at(-1));
      if (!state.remaining.length) throw new Error('Unexpected native open dialog');
      const path = state.remaining.shift();
      return path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] };
    };
  }, responses);
  const dialogCalls = () => app.evaluate(() => globalThis.catalogSmokeDialogs.calls);
  const open = async path => {
    await dialogs([path]); await action('open').click();
    if (await page.locator('#discard-dialog[open]').count()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
    await page.locator('[data-right-tab="assets"]').click();
  };
  let serial = 0;
  const save = async label => {
    const path = resolve(output, `${String(++serial).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await action('save').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/, label);
    return { path, project: parseProjectFile(JSON.parse(await readFile(path, 'utf8'))) };
  };
  const importCatalog = async responses => {
    const queue = Array.isArray(responses) ? responses : [responses,
      ...((await page.locator('.asset-project').innerText()).includes('아직 연결된 프로젝트') ? [unityProject] : [])];
    await dialogs(queue);
    await action('import-prop-catalog').click(); await idle();
    return page.locator('#status').innerText();
  };
  const retainedCount = async () => Number(await page.locator('[data-prop-catalog-count]').getAttribute('data-prop-catalog-count'));
  const assertUnchanged = async (label, before) => assert.deepEqual((await save(label)).project, before, label);

  await open(fixturePath);
  assert.equal(await page.locator('#propCatalogRole').inputValue(), 'prop', 'bulk registration defaults to props independently of the manual asset adder');
  await page.locator('#newAssetRole').selectOption('wall');
  await importCatalog([null]);
  assert.equal((await dialogCalls()).length, 1, 'canceling JSON selection does not request a project folder');
  assert.equal(await retainedCount(), 0);
  assert.equal(await action('undo').isDisabled(), true);
  await importCatalog([invalidPath]);
  assert.equal((await dialogCalls()).length, 1, 'invalid JSON is rejected before asking for a Unity project');
  assert.equal(await page.locator('.footer.error').count(), 1);
  await importCatalog([catalogPath, null]);
  assert.equal((await dialogCalls()).length, 2, 'an unconnected catalog import requests its Unity project');
  assert.equal(await page.locator('[data-asset-card]').count(), 0, 'canceling project selection adds no bindings');
  assert.equal(await retainedCount(), 0, 'canceling project selection retains no catalog');
  assert.equal(await action('undo').isDisabled(), true);
  await assertUnchanged('canceled-before-connect', fixture);

  const initialStatus = await importCatalog([catalogPath, unityProject]);
  const calls = await dialogCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].properties?.includes('openDirectory'), 'the second native dialog selects the Unity project folder');
  assert.equal(await page.locator('.footer.error').count(), 0, initialStatus);
  assert.match(initialStatus, /신규 등록 11개/);
  assert.equal(await page.locator('#newAssetGuid option[value]:not([value=""])').count(), projectPrefabs.length,
    'the connected project really scans all 72 prefab assets for the manual picker');
  assert.equal(await page.locator('[data-project-prefab-count]').getAttribute('data-project-prefab-count'), '72',
    'the UI labels all project prefabs as the selection list');
  assert.equal(await page.locator('[data-registered-asset-count]').getAttribute('data-registered-asset-count'), '11',
    'the UI reports eleven registered assets independently of the 72-prefab selection list');
  assert.equal(await retainedCount(), 11);
  assert.equal(await page.locator('[data-asset-card]').count(), 11, 'one JSON import registers all eleven previously unregistered prefabs');
  assert.equal(await page.locator('[data-prop-size-state="measured"]').count(), 11);
  const added = await save('eleven-added');
  assert.equal(projectPrefabs.length, 72, 'the scanned project includes many prefabs outside the selected eleven');
  assert.deepEqual(added.project.bindings.map(binding => binding.prefabGuid).sort(), prefabs.map(asset => asset.guid).sort(),
    'the imported GUID catalog defines registration: only its eleven prefabs become bindings from the 72-prefab project');
  assert.ok(unrelatedPrefabs.every(asset => !added.project.bindings.some(binding => binding.prefabGuid === asset.guid)),
    'none of the sixty unselected project prefabs are registered');
  assert.ok(!added.project.bindings.some(binding => binding.prefabGuid === unmeasured.guid), 'an unmeasured scanned prefab stays unregistered');
  assert.deepEqual(added.project.map, fixture.map, 'registration preserves the existing map');
  for (const asset of prefabs) {
    const matches = added.project.bindings.filter(binding => binding.prefabGuid === asset.guid);
    assert.equal(matches.length, 1); const [binding] = matches;
    assert.equal(binding.role, 'prop'); assert.equal(binding.label, asset.name);
    assert.equal(binding.prefabPath, `Assets/${asset.name}.prefab`);
    assert.deepEqual(binding.prop.size, asset.size, 'GUID matching ignores letter case');
    assert.deepEqual(binding.scale, { x: 1, y: 1, z: 1 }, 'measured prefabs keep native scale independently of map cell size');
    assert.deepEqual(binding.offset, { x: 0, y: 0, z: 0 }); assert.equal(binding.rotationY, 0);
    assert.equal(binding.prop.blocksMovement, true);
  }
  await page.screenshot({ path: resolve(output, 'eleven-registered.png') });
  await action('undo').click(); await assertUnchanged('bulk-undo', fixture);
  assert.equal(await action('undo').isDisabled(), true, 'the entire import uses one history entry');
  await action('redo').click(); await assertUnchanged('bulk-redo', added.project);

  const customized = structuredClone(added.project);
  const first = customized.bindings[0]; first.label = '수동 조정 보존'; first.role = 'decoration';
  first.scale = { x: 2, y: 1.5, z: .5 }; first.offset = { x: .2, y: .3, z: .4 }; first.rotationY = 90;
  Object.assign(first.prop, { category: '사용자 종류', tags: ['보존', '공장'], blocksMovement: false, placement: 'wall', roomTypes: ['shop'], weight: 3.25 });
  customized.bindings.push({ ...structuredClone(first), id: 'duplicate_native_guid', label: '같은 프리팹 식생 등록', role: 'vegetation' });
  const customizedProject = parseProjectFile(customized), customizedPath = resolve(output, 'customized.baekho.json');
  await writeFile(customizedPath, JSON.stringify(customizedProject)); await open(customizedPath);
  assert.equal(await retainedCount(), 0, 'opening a map clears the transient catalog while saving its applied sizes');
  await page.locator('#propCatalogRole').selectOption('vegetation');
  await importCatalog(catalogPath); await assertUnchanged('repeat-preserves-customization', customizedProject);
  assert.equal(await action('undo').isDisabled(), true, 'identical reimport does not add history or change existing roles');
  const partialStatus = await importCatalog(partialPath);
  assert.match(partialStatus, /신규 등록 0개/); assert.match(partialStatus, /1개/);
  const changed = await save('partial-update');
  const expected = structuredClone(customizedProject);
  for (const binding of expected.bindings) if (binding.prefabGuid === prefabs[0].guid) binding.prop.size = changedSize;
  assert.deepEqual(changed.project, expected, 'partial import updates both existing roles with the same GUID and preserves all customization');
  assert.equal(changed.project.bindings.length, 12, 'foreign GUIDs are omitted instead of creating disconnected bindings');
  await importCatalog(partialPath); await assertUnchanged('partial-repeat', changed.project);
  for (const [label, path] of [['empty', emptyPath], ['invalid', invalidPath], ['unmatched', unmatchedPath]]) {
    await importCatalog(path); await assertUnchanged(`${label}-preserves-map`, changed.project);
  }
  await importCatalog([null]); await assertUnchanged('cancel-preserves-map', changed.project);
  await action('undo').click(); await assertUnchanged('partial-undo', customizedProject);
  assert.equal(await action('undo').isDisabled(), true, 'no-change, invalid, unmatched and canceled imports do not add history');
  await action('redo').click(); await assertUnchanged('partial-redo', changed.project);
  await open(changed.path); await assertUnchanged('reopened', changed.project);

  await page.locator('#propCatalogRole').selectOption('vegetation');
  await importCatalog(vegetationPath);
  const vegetation = await save('vegetation-role');
  const plant = vegetation.project.bindings.find(binding => binding.prefabGuid === unmeasured.guid);
  assert.equal(plant.role, 'vegetation'); assert.equal(plant.prop.blocksMovement, false);
  assert.deepEqual(plant.prop.size, { x: .5, y: 2, z: .75 });
  assert.deepEqual(plant.scale, { x: 1, y: 1, z: 1 });
  await page.locator('#propCatalogRole').selectOption('decoration');
  await importCatalog(vegetationPath); await assertUnchanged('role-reimport-preserved', vegetation.project);

  await open(fixturePath);
  await page.locator('#propCatalogRole').selectOption('prop');
  const wallRejected = await importCatalog(wallPath);
  assert.equal(await page.locator('.footer.error').count(), 1, wallRejected);
  assert.match(wallRejected, /벽 부착 정보.*소품으로 등록할 수 없습니다/);
  assert.match(wallRejected, /장식 또는 조명/);
  assert.equal(await retainedCount(), 0, 'rejecting a wall catalog under the default prop role retains no catalog');
  assert.equal(await page.locator('[data-asset-card]').count(), 0, 'wall role rejection creates no partial bindings');
  assert.equal(await action('undo').isDisabled(), true, 'wall role rejection creates no history entry');
  await assertUnchanged('wall-default-prop-rejected', fixture);

  await page.locator('#propCatalogRole').selectOption('decoration');
  const wallImported = await importCatalog(wallPath);
  assert.equal(await page.locator('.footer.error').count(), 0, wallImported);
  assert.match(wallImported, /신규 등록 1개/);
  const wallAdded = await save('wall-decoration-imported');
  assert.equal(wallAdded.project.bindings.length, 1);
  const wallBinding = wallAdded.project.bindings[0];
  assert.equal(wallBinding.role, 'decoration');
  assert.equal(wallBinding.prefabGuid, wallEntry.guid);
  assert.deepEqual(wallBinding.bounds, wallEntry.bounds, 'v2 import retains measured pivot-local bounds');
  assert.deepEqual(wallBinding.wallMount, wallEntry.wallMount, 'choosing decoration retains all v2 wall mounting metadata');
  assert.ok((await page.locator('[data-wall-readiness]').allTextContents()).some(text => /벽용 등록 1개 · 크기 확인 1개/.test(text)),
    'the renderer counts the imported wall asset as configured and measured');
  await page.screenshot({ path: resolve(output, 'wall-catalog-readiness.png') });
  await action('undo').click(); await assertUnchanged('wall-import-undo', fixture);
  await action('redo').click(); await assertUnchanged('wall-import-redo', wallAdded.project);

  const capacityProject = parseProjectFile({ ...fixture, bindings: Array.from({ length: MAX_BINDINGS - 5 }, (_, index) => ({
    id: `floor_${index}`, label: `기존 바닥 ${index}`, role: 'floor', prefabGuid: unmeasured.guid,
    prefabPath: 'Assets/Unmeasured.prefab', scale: { x: 2, y: 1, z: 2 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  })) });
  const capacityPath = resolve(output, 'capacity.baekho.json');
  await writeFile(capacityPath, JSON.stringify(capacityProject)); await open(capacityPath);
  const capacityStatus = await importCatalog(catalogPath);
  assert.equal(await page.locator('.footer.error').count(), 1, capacityStatus);
  assert.match(capacityStatus, /256|최대|한도/);
  await assertUnchanged('capacity-atomic', capacityProject);
  assert.equal(await retainedCount(), 0, 'capacity rejection does not replace the session catalog');
  assert.equal(await action('undo').isDisabled(), true, 'capacity rejection leaves no partial registration or history');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', registeredInOneImport: 11,
    scannedProjectPrefabs: projectPrefabs.length, unrelatedProjectPrefabs: unrelatedPrefabs.length, unrelatedPrefabsRegistered: 0,
    noProjectFolderPrompt: true, atomicUndoRedo: true, duplicateFreeReimport: true, customizationPreserved: true,
    capacityAtomic: true, wallDefaultPropRejectedAtomically: true, wallDecorationMetadataRetained: true,
    wallReadinessVisible: true, screenshot: resolve(output, 'eleven-registered.png'), wallScreenshot: resolve(output, 'wall-catalog-readiness.png') }, null, 2));
  console.log(`PASS bulk prop catalog: one import registers only eleven selected prefabs from a 72-prefab project, native folder prompt and cancellation, correct GUID/native scale/role, duplicate-free updates, existing customization, partial/unmatched/invalid preservation, atomic capacity rejection, v2 wall default-prop rejection and decoration reimport with visible readiness, Undo/Redo and save/reopen. ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
