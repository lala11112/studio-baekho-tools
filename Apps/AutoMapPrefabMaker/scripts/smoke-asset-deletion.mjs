// Exercise bulk deletion in the real Electron UI with isolated map files and native dialogs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-asset-deletion.mjs [path/to/Baekho Map Forge.exe]');
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const { DEFAULT_SETTINGS, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const { ASSET_ROLES } = await tsImport('../src/shared/features.ts', import.meta.url);
const output = resolve('.local/asset-deletion-smoke');
const userData = resolve(output, `user-${Date.now()}`);
const unityProject = resolve(output, 'UnityProject');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets'), { recursive: true }),
  mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
const asset = (role, index, suffix = '') => ({ id: `${role}${suffix}`, label: `${role}${suffix}`,
  role, prefabGuid: (index + 1).toString(16).padStart(32, '0'), prefabPath: `Assets/${role}${suffix}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  ...(['prop', 'decoration', 'vegetation'].includes(role) ? { prop: { category: role, tags: ['삭제 검증'],
    size: { x: 1, y: 1, z: 1 }, blocksMovement: role === 'prop', placement: 'floor', roomTypes: ['battle'], weight: 1 } } : {}) });
const bindings = ['floor', 'wall', 'door', 'prop', 'decoration', 'vegetation', 'light'].map((role, index) => asset(role, index));
bindings.push(asset('prop', 7, '_spare'));
for (const binding of [...bindings, asset('decoration', 20, '_unregistered')]) {
  const path = resolve(unityProject, binding.prefabPath);
  await writeFile(path, `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${binding.id}\n`);
  await writeFile(`${path}.meta`, `fileFormatVersion: 2\nguid: ${binding.prefabGuid}\n`);
}
const instance = (role, x, row) => ({ id: `${role}_instance`, bindingId: role, role, x, row, direction: 0,
  offset: { x: 0, y: 0, z: 0 }, cells: [{ x, row }], size: { x: 1, y: 1, z: 1 }, blocksMovement: role === 'prop',
  category: role, anchor: 'floor', authored: true });
const fixture = (role, x, row) => ({ id: `${role}_fixture`, role, x, row, direction: 0,
  offset: { x: 0, y: 0, z: 0 }, bindingId: role });
const width = 12, height = 10;
const draftImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const settings = { ...DEFAULT_SETTINGS, conceptMode: 'manual', width, height, seed: 20261018, prompt: '일괄 삭제는 방의 지형과 목표를 유지한다.' };
const rows = ['#####D######', ...Array(height - 2).fill('#..........#'), '############'];
rows[2] = '#.P.P......#';
const initial = parseProjectFile({ formatVersion: 1, bindings,
  settings,
  generationDraft: { imageDataUrl: draftImage, settings, catalog: bindings.filter(binding => binding.prop) },
  concept: { source: 'manual', text: '전투 중 소품을 사이에 두고 진입과 우회 경로를 선택한다.' },
  map: { version: 5, name: '일괄 삭제 검증', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [],
    connections: [{ id: 'north', label: '입구', x: 5, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }],
    assetOverrides: [{ x: 1, row: 1, role: 'floor', bindingId: 'floor' }, { x: 4, row: 2, role: 'prop', bindingId: 'prop' }],
    propInstances: [instance('prop', 2, 2), instance('decoration', 6, 2), instance('vegetation', 2, 5)],
    fixtures: [fixture('decoration', 8, 2), fixture('vegetation', 6, 5), fixture('light', 8, 5)],
    markers: [{ id: 'reward', label: '보상', kind: 'reward', contentKey: 'reward', x: 9, row: 7, direction: 0, offset: { x: 0, y: 0, z: 0 } }],
    zones: [{ x: 9, row: 7, kind: 'reward' }], ceilings: [{ x: 8, row: 5, undersideY: 4 }],
  } });
const initialPath = resolve(output, 'initial.baekho.json');
const locked = parseProjectFile({ ...initial, map: { ...initial.map, lockedCells: [{ x: 2, row: 2 }] } });
const lockedPath = resolve(output, 'locked.baekho.json');
const catalogPath = resolve(output, 'prop-bounds.json');
await Promise.all([writeFile(initialPath, JSON.stringify(initial)), writeFile(lockedPath, JSON.stringify(locked)),
  writeFile(catalogPath, JSON.stringify({ version: 1, assets: bindings.filter(binding => binding.prop).map(binding => ({
    guid: binding.prefabGuid, size: binding.prop.size,
  })) }))]);
const geography = map => {
  const { assetOverrides: _overrides, propInstances: _props, fixtures: _fixtures, ...terrain } = map;
  return { ...terrain, rows: terrain.rows.map(row => row.replaceAll('P', '.')) };
};
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
const errors = [], observations = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); BrowserWindow.getAllWindows()[0].setBounds({ width: 1480, height: 1000 });
    dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Isolated asset deletion regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const version = await app.evaluate(({ app }) => app.getVersion());
  const action = name => page.locator(`[data-action="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const choose = path => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const assetsTab = async () => {
    await page.locator('[data-right-tab="assets"]').click();
    await page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  };
  const open = async path => {
    await choose(path); await action('open').click();
    if (await page.locator('#discard-dialog[open]').count()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
    await assetsTab();
  };
  let serial = 0;
  const save = async label => {
    const path = resolve(output, `${String(++serial).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await action('save').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/, label);
    return { path, project: parseProjectFile(JSON.parse(await readFile(path, 'utf8'))) };
  };
  const assertSaved = async (label, expected) => assert.deepEqual((await save(label)).project, expected, label);
  const dialog = page.locator('#asset-delete-dialog');
  const startDelete = async scope => {
    await assetsTab(); await page.locator('#bulkDeleteScope').selectOption(scope); await action('bulk-delete-bindings').click();
    await page.locator('#asset-delete-dialog[open]').waitFor();
  };
  const confirm = async () => {
    await dialog.locator('button[value="delete"]').click();
    await page.waitForFunction(() => !document.querySelector('#asset-delete-dialog')?.open); await idle();
  };
  const scan = async () => {
    await choose(unityProject); await action('scan').click(); await idle();
    assert.equal(await page.locator('#newAssetGuid option[value]:not([value=""])').count(), 9);
  };
  await open(initialPath);
  assert.equal(await page.locator('#bulkDeleteScope').inputValue(), 'prop');
  const scopes = await page.locator('#bulkDeleteScope option').evaluateAll(options => options.map(option => option.value));
  assert.ok(['all', 'props', ...ASSET_ROLES].every(scope => scopes.includes(scope)), 'all asset roles and the prop group can be selected');
  assert.equal(await action('undo').isDisabled(), true);
  await startDelete('prop');
  const confirmation = await dialog.innerText(); assert.match(confirmation, /2/); assert.match(confirmation, /소품|에셋/);
  await page.screenshot({ path: resolve(output, 'prop-confirmation.png') });
  await dialog.locator('button[value="cancel"]').click();
  assert.equal(await action('undo').isDisabled(), true, 'cancel does not create history');
  await assertSaved('cancel-unchanged', initial);
  await startDelete('prop'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#asset-delete-dialog[open]').count(), 0, 'Escape cancels deletion');
  assert.equal(await action('undo').isDisabled(), true);
  await assertSaved('escape-unchanged', initial);
  await scan();
  await choose(catalogPath); await action('import-prop-catalog').click(); await idle();
  assert.equal(await page.locator('[data-prop-catalog-count]').getAttribute('data-prop-catalog-count'), '4');
  await assertSaved('measured-before-delete', initial);
  assert.equal(await action('undo').isDisabled(), true, 'identical measurements leave history empty');

  await startDelete('prop'); await confirm();
  const propDeleted = (await save('prop-deleted')).project;
  assert.deepEqual(propDeleted.bindings, initial.bindings.filter(binding => binding.role !== 'prop'));
  assert.deepEqual(propDeleted.map.propInstances, initial.map.propInstances.filter(prop => prop.role !== 'prop'));
  assert.deepEqual(propDeleted.map.assetOverrides, initial.map.assetOverrides.filter(override => override.role !== 'prop'));
  assert.deepEqual(propDeleted.map.fixtures, initial.map.fixtures);
  assert.deepEqual(geography(propDeleted.map), geography(initial.map), 'prop deletion preserves geography, locks, metadata and gameplay markers');
  assert.deepEqual(propDeleted.settings, initial.settings); assert.deepEqual(propDeleted.concept, initial.concept);
  assert.deepEqual(propDeleted.generationDraft, { ...initial.generationDraft,
    catalog: initial.generationDraft.catalog.filter(binding => binding.role !== 'prop') },
    'the saved extraction draft cannot restore deleted prop registrations');
  assert.equal(propDeleted.map.rows[2][2], '.', 'the deleted prop occupancy is restored to floor');
  assert.equal(propDeleted.map.rows[2][4], 'P', 'an authored legacy prop location is retained independently of registrations');
  assert.equal(await page.locator('[data-asset-card]').count(), 6);
  assert.equal(await action('bulk-delete-bindings').isDisabled(), true, 'empty exact-prop scope cannot be deleted again');
  await page.screenshot({ path: resolve(output, 'prop-deleted.png') });
  await scan(); await assertSaved('scan-after-prop-delete', propDeleted);
  assert.equal(await action('redo').isDisabled(), true);
  await action('undo').click(); await assertSaved('prop-delete-undo', initial);
  assert.equal(await action('undo').isDisabled(), true, 'bulk deletion is one history entry');
  assert.equal(await action('redo').isDisabled(), false);
  await startDelete('prop'); await dialog.locator('button[value="cancel"]').click();
  assert.equal(await action('redo').isDisabled(), false, 'canceling a second deletion preserves the existing redo entry');
  await assertSaved('cancel-preserves-redo', initial);
  await action('redo').click(); await assertSaved('prop-delete-redo', propDeleted);
  observations.push({ label: 'exact-prop', removedBindings: 2, removedInstances: 1, terrainPreserved: true, atomicUndoRedo: true });

  await startDelete('decoration'); await confirm();
  const decorationDeleted = (await save('decoration-deleted')).project;
  assert.deepEqual(decorationDeleted.bindings, propDeleted.bindings.filter(binding => binding.role !== 'decoration'));
  assert.deepEqual(decorationDeleted.map.propInstances, propDeleted.map.propInstances.filter(prop => prop.role !== 'decoration'));
  assert.equal(decorationDeleted.map.fixtures.find(fixture => fixture.id === 'decoration_fixture')?.bindingId, undefined,
    'deleting a registration clears its fixture reference while retaining the fixture intent');
  assert.deepEqual(geography(decorationDeleted.map), geography(initial.map));
  await action('undo').click(); await assertSaved('decoration-delete-undo', propDeleted);
  await action('redo').click(); await assertSaved('decoration-delete-redo', decorationDeleted);
  observations.push({ label: 'decoration', removedBindings: 1, removedInstances: 1, fixtureReferenceCleared: true });

  await open(initialPath); await startDelete('props'); await confirm();
  const groupDeleted = (await save('all-prop-roles-deleted')).project;
  assert.ok(groupDeleted.bindings.every(binding => !['prop', 'decoration', 'vegetation'].includes(binding.role)));
  assert.deepEqual(groupDeleted.map.propInstances, []);
  assert.deepEqual(geography(groupDeleted.map), geography(initial.map));
  await action('undo').click(); await assertSaved('prop-group-undo', initial);
  await action('redo').click(); await assertSaved('prop-group-redo', groupDeleted);
  observations.push({ label: 'prop-group', removedBindings: 4, removedInstances: 3 });

  await open(initialPath); await startDelete('all'); await confirm();
  const allDeleted = await save('all-deleted');
  assert.deepEqual(allDeleted.project.bindings, []); assert.deepEqual(allDeleted.project.map.propInstances, []);
  assert.deepEqual(allDeleted.project.generationDraft, { ...initial.generationDraft, catalog: [] });
  assert.deepEqual(allDeleted.project.map.assetOverrides, []);
  assert.ok(allDeleted.project.map.fixtures.every(fixture => fixture.bindingId === undefined));
  assert.equal(allDeleted.project.map.fixtures.length, initial.map.fixtures.length);
  assert.deepEqual(geography(allDeleted.project.map), geography(initial.map));
  assert.equal(await page.locator('[data-asset-card]').count(), 0);
  assert.equal(await action('bulk-delete-bindings').isDisabled(), true);
  await page.screenshot({ path: resolve(output, 'all-deleted.png') });
  await action('undo').click(); await assertSaved('all-delete-undo', initial);
  await action('redo').click(); await assertSaved('all-delete-redo', allDeleted.project);
  await open(allDeleted.path); await assertSaved('all-delete-reopened', allDeleted.project);
  await scan(); await assertSaved('all-delete-reconnected', allDeleted.project);
  assert.equal(await page.locator('[data-asset-card]').count(), 0, 'a scan cannot resurrect removed registrations');
  assert.equal(await action('bulk-delete-bindings').isDisabled(), true);
  observations.push({ label: 'all', removedBindings: 8, removedInstances: 3, saveReopen: true, scanDoesNotResurrect: true });

  await open(lockedPath);
  await page.locator('#bulkDeleteScope').selectOption('prop');
  await action('bulk-delete-bindings').click();
  if (await page.locator('#asset-delete-dialog[open]').count()) await confirm();
  assert.match(await page.locator('#status').innerText(), /잠긴|잠금|보호/);
  assert.equal(await action('undo').isDisabled(), true, 'locked rejection is atomic and adds no history');
  await assertSaved('locked-rejected', locked);
  observations.push({ label: 'locked-prop', atomicRejection: true });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', version, executablePath, observations, errors }, null, 2));
  console.log(`PASS bulk asset deletion ${version}: cancellation/Escape, exact role and prop group, instances and references, terrain preservation, one-step Undo/Redo, all/save/reopen/rescan, zero-count controls and locked rejection. ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
