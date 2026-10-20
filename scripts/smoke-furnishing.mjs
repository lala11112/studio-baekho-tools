// Real Electron UI, native asset registration and local furnishing. AI IPC is trapped; Unity is not launched.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { strFromU8, unzipSync } from 'fflate';
import { tsImport } from 'tsx/esm/api';

if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-furnishing.mjs [path/to/Baekho Map Forge.exe]');
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const { DEFAULT_SETTINGS, parseProjectFile, validateMap } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { propValidationIssues, propWorldSize } = await tsImport('../src/shared/props.ts', import.meta.url);
const { analyzeLevelDesign } = await tsImport('../src/shared/level-design.ts', import.meta.url);
const output = resolve('.local/furnishing-smoke');
const userData = resolve(output, `user-${Date.now()}`);
const unityProject = resolve(output, 'UnityProject');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(resolve(unityProject, 'Assets/Modules'), { recursive: true }), mkdir(resolve(unityProject, 'ProjectSettings'), { recursive: true })]);
const guid = index => (index + 1).toString(16).padStart(32, '0');
const structures = ['floor', 'wall', 'door', 'stair'].map((role, index) => ({ name: role, role, guid: guid(index) }));
const furnishing = [
  ['crate-small', 'prop', 1.2, 1, 1.2], ['barrel-small', 'prop', 1.4, 1.7, 1.4],
  ['table-medium', 'prop', 2.8, 1.3, 1.6], ['rock-medium', 'prop', 3.2, 1.8, 2],
  ['bench-large', 'prop', 4.5, 1.4, 2], ['cabinet-large', 'prop', 4.2, 1.8, 2.8],
  ['debris-shard', 'decoration', .6, .3, .8], ['debris-panel', 'decoration', 1.2, .2, .8],
  ['ornament-low', 'decoration', .8, .6, .8], ['ornament-tall', 'decoration', .7, 1.4, .7],
  ['ornament-wide', 'decoration', 1.5, .5, 1.2],
].map(([name, role, x, y, z], index) => ({ name, role, guid: guid(index + structures.length), size: { x, y, z } }));
for (const asset of [...structures, ...furnishing]) {
  const prefab = resolve(unityProject, `Assets/Modules/${asset.name}.prefab`);
  await writeFile(prefab, `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: ${asset.name}\n`);
  await writeFile(`${prefab}.meta`, `fileFormatVersion: 2\nguid: ${asset.guid}\n`);
}
const map = { version: 5, name: '기존 지형 소품 배치 검증', width: 24, height: 20, cellSize: 2, maxStepHeight: .4,
  rows: ['########D###############', ...Array(18).fill('#......................#'), '########################'],
  elevations: Array.from({ length: 20 }, () => Array(24).fill(0)),
  ramps: [{ x: 16, row: 6, direction: 90, rise: 2, kind: 'stair' }], assetOverrides: [],
  connections: [{ id: 'north', label: '북쪽 문', x: 8, row: 0, direction: 0, width: 2, height: 3, kind: 'door' },
    { id: 'west', label: '서쪽 문', x: 0, row: 12, direction: 270, width: 2, height: 3, kind: 'door' }],
  lockedCells: [{ x: 3, row: 15 }, { x: 4, row: 15 }],
};
const setTile = (x, row, value) => { map.rows[row] = map.rows[row].slice(0, x) + value + map.rows[row].slice(x + 1); };
setTile(0, 12, 'D'); setTile(16, 6, 'R');
for (let row = 4; row <= 8; row++) for (let x = 17; x <= 21; x++) map.elevations[row][x] = 2;
const fixture = parseProjectFile({ formatVersion: 1, map,
  settings: { ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: '기존 방의 지형과 이동 조건을 유지한다.', width: 24, height: 20, connectionCount: 2, seed: 237,
    levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 },
    designer: { ...DEFAULT_DESIGNER, preset: 'battle', elevation: true, props: false, decorations: false, vegetation: false,
      propLayout: 'balanced', propCoverage: 12, decorationDensity: 5, enemies: false, rewards: false, ceilings: false } },
  bindings: structures.map(asset => ({ id: asset.name, label: asset.name, role: asset.role, prefabGuid: asset.guid,
    prefabPath: `Assets/Modules/${asset.name}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    ...(asset.role === 'stair' ? { stairNativeRise: 1 } : {}) })) });
assert.deepEqual(validateMap(fixture.map).filter(issue => issue.severity === 'error'), []);
assert.deepEqual(analyzeLevelDesign(fixture.map, fixture.settings).issues.filter(issue => issue.severity === 'error'), []);
const fixturePath = resolve(output, 'empty-room.baekho.json');
const catalogPaths = Object.fromEntries(['prop', 'decoration'].map(role => [role, resolve(output, `${role}-native-bounds.json`)]));
await Promise.all([writeFile(fixturePath, JSON.stringify(fixture)), ...Object.entries(catalogPaths).map(([role, path]) =>
  writeFile(path, JSON.stringify({ version: 1, assets: furnishing.filter(asset => asset.role === role).map(({ guid, size }) => ({ guid, size })) })))]);

// A P cell is a furnishing occupancy layer; its underlying floor must stay the same.
const geography = value => ({ width: value.width, height: value.height, cellSize: value.cellSize, maxStepHeight: value.maxStepHeight,
  rows: value.rows.map(row => row.replaceAll('P', '.')), elevations: value.elevations, ramps: value.ramps,
  bridges: value.bridges ?? [], connections: value.connections, lockedCells: value.lockedCells ?? [],
  ceilings: value.ceilings ?? [], wallHeights: value.wallHeights ?? [], cliffs: value.cliffs ?? [],
  structureFills: value.structureFills ?? [], pitBottoms: value.pitBottoms ?? [], zones: value.zones ?? [] });
const placed = project => project.map.propInstances ?? [];
const role = instance => instance.role ?? (instance.blocksMovement ? 'prop' : 'decoration');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
const errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory); BrowserWindow.getAllWindows()[0].setBounds({ width: 1480, height: 1000 });
    globalThis.furnishingSmoke = { calls: [] };
    for (const channel of ['codex-status', 'generate-concept', 'generate-image', 'extract-layout']) ipcMain.removeHandler(`baekho:${channel}`);
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Furnishing regression: no AI calls', models: [] }));
    for (const channel of ['generate-concept', 'generate-image', 'extract-layout']) ipcMain.handle(`baekho:${channel}`, () => {
      globalThis.furnishingSmoke.calls.push(channel); throw new Error(`Local furnishing must not call AI: ${channel}`);
    });
    dialog.showMessageBoxSync = () => 1;
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const action = name => page.locator(`[data-action="${name}"]`);
  const choice = name => page.locator(`[data-furnish-control="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const assetsTab = async () => { await page.locator('[data-right-tab="assets"]').click(); await expand(); };
  const chooseFile = filePath => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, filePath);
  const open = async path => {
    await chooseFile(path); await action('open').click();
    if (await page.locator('#discard-dialog[open]').isVisible()) await page.locator('#discard-dialog button[value="discard"]').click();
    await idle(); await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
    await assetsTab();
  };
  let saveIndex = 0;
  const save = async label => {
    const path = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await action('save').click(); await idle(); assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return { path, project: parseProjectFile(JSON.parse(await readFile(path, 'utf8'))) };
  };
  const furnish = async () => {
    await assetsTab(); await action('furnish-map').click(); await idle();
    assert.equal(await page.locator('.footer.error').count(), 0, await page.locator('#status').innerText());
    const result = page.locator('[data-furnish-result]'); await result.waitFor();
    assert.match(await result.innerText(), /소품|장식|추가 배치 없음/); assert.match(await result.innerText(), /\d/);
    return result.innerText();
  };
  await open(fixturePath);
  assert.equal(placed((await save('empty')).project).length, 0);
  if (await action('furnish-map').isEnabled()) {
    await action('furnish-map').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /등록|측정|크기|배치할/);
    assert.equal(placed((await save('no-assets')).project).length, 0);
  }
  await chooseFile(unityProject); await action('scan').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /프리팹 15개/);
  for (const role of ['prop', 'decoration']) {
    await page.locator('#propCatalogRole').selectOption(role);
    await chooseFile(catalogPaths[role]); await action('import-prop-catalog').click(); await idle(); await expand();
    assert.equal(await page.locator('.footer.error').count(), 0, await page.locator('#status').innerText());
    assert.match(await page.locator('#status').innerText(), new RegExp(`신규 등록 ${furnishing.filter(asset => asset.role === role).length}개`));
  }
  assert.equal(await page.locator('[data-asset-card]').count(), structures.length + furnishing.length, 'two role-specific catalogs bulk-register six props and five decorations');
  assert.equal(await page.locator('[data-prop-field="size"]').count(), 11);
  assert.equal(await page.locator('[data-prop-size-state="measured"]').count(), 11);
  const registered = await save('registered');
  assert.equal(registered.project.bindings.filter(binding => binding.role === 'prop').length, 6);
  assert.equal(registered.project.bindings.filter(binding => binding.role === 'decoration').length, 5);
  for (const asset of furnishing) {
    const binding = registered.project.bindings.find(binding => binding.prefabGuid === asset.guid);
    assert.equal(binding.role, asset.role); assert.deepEqual(binding.prop.size, asset.size);
    assert.deepEqual(binding.scale, { x: 1, y: 1, z: 1 });
  }
  assert.deepEqual(registered.project.map, fixture.map, 'registration and bounds import do not populate the map');
  await choice('props').check(); await choice('decorations').check();
  assert.equal(await choice('coverage').getAttribute('min'), '1'); assert.equal(await choice('coverage').getAttribute('max'), '30');
  assert.equal(await choice('density').getAttribute('min'), '1'); assert.equal(await choice('density').getAttribute('max'), '100');
  assert.equal(await choice('coverage').inputValue(), String(registered.project.settings.designer.propCoverage));
  assert.equal(await choice('density').inputValue(), String(registered.project.settings.designer.decorationDensity));
  assert.match(await action('furnish-map').innerText(), /현재 맵에 소품·장식 자동 배치/);
  assert.equal(await action('furnish-map').isEnabled(), true);
  const summary = await furnish();
  const populated = await save('furnished');
  const props = placed(populated.project).filter(instance => role(instance) === 'prop');
  const decorations = placed(populated.project).filter(instance => role(instance) === 'decoration');
  assert.ok(props.length > 0, 'local action creates measured blocking props without AI P hints');
  assert.ok(decorations.length > 0, 'local action creates measured decorations');
  assert.ok(new Set(props.map(instance => instance.bindingId)).size >= 2, 'multiple compatible prop kinds appear');
  assert.ok(new Set(decorations.map(instance => instance.bindingId)).size >= 2, 'multiple compatible decoration kinds appear');
  assert.deepEqual(geography(populated.project.map), geography(fixture.map), 'terrain, doors, elevations, stairs and locks are preserved');
  assert.deepEqual(populated.project.settings, registered.project.settings, 'local furnishing leaves future AI generation toggles unchanged');
  assert.equal(populated.project.settings.designer.props, false); assert.equal(populated.project.settings.designer.decorations, false);
  assert.deepEqual(populated.project.bindings, registered.project.bindings, 'automatic fitting preserves native measurements and asset scale');
  assert.deepEqual(propValidationIssues(populated.project.map, populated.project.bindings).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(validateMap(populated.project.map).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(analyzeLevelDesign(populated.project.map, populated.project.settings).issues.filter(issue => issue.severity === 'error'), []);
  for (const instance of placed(populated.project)) assert.deepEqual(instance.size, propWorldSize(populated.project.bindings.find(binding => binding.id === instance.bindingId), instance.direction));
  await page.locator('[data-view="3d"]').click(); await page.locator('#preview canvas').waitFor();
  await page.locator('[data-furnish-result]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'furnished-preview.png') });
  await action('undo').click();
  assert.deepEqual((await save('undo')).project, registered.project, 'one Undo restores the empty room and its registered library');
  await action('redo').click();
  assert.deepEqual((await save('redo')).project, populated.project, 'Redo restores exact furnishing and bindings');
  const counts = project => ({ props: placed(project).filter(instance => role(instance) === 'prop').length, decorations: placed(project).filter(instance => role(instance) === 'decoration').length });
  for (let repeat = 0; repeat < 2; repeat++) {
    await furnish(); const repeated = await save(`repeat-${repeat + 1}`);
    assert.deepEqual(counts(repeated.project), counts(populated.project), 'repeating the same fill does not accumulate more objects');
    assert.deepEqual(geography(repeated.project.map), geography(fixture.map));
  }
  const zipPath = resolve(output, 'furnished-unity.zip');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
  assert.equal(await action('export').isEnabled(), true); await action('export').click(); await idle();
  assert.equal(await page.locator('.footer.error').count(), 0, await page.locator('#status').innerText());
  const zip = unzipSync(await readFile(zipPath)); const manifest = JSON.parse(strFromU8(zip['Map.baekhomap.json']));
  assert.equal(manifest.placements.filter(placement => placement.role === 'prop').length, props.length);
  assert.equal(manifest.placements.filter(placement => placement.role === 'decoration').length, decorations.length);
  for (const placement of manifest.placements.filter(placement => placement.role === 'prop' || placement.role === 'decoration')) {
    assert.equal(placement.centerXZ, true); assert.deepEqual(placement.scale, { x: 1, y: 1, z: 1 });
  }
  await open(populated.path); assert.deepEqual((await save('reopened')).project, populated.project);
  assert.deepEqual(await app.evaluate(() => globalThis.furnishingSmoke.calls), [], 'the entire workflow makes zero concept/image/extraction calls');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', registeredFurnishingAssets: furnishing.length, props: props.length, decorations: decorations.length, summary, aiCalls: 0, screenshot: resolve(output, 'furnished-preview.png'), export: zipPath }, null, 2));
  console.log(`PASS local furnishing UI: bulk import of six props and five decorations, props/decor generation OFF, fixed terrain/doors/heights/stairs, measured diversity, Undo/Redo, repeat stability, native save/reopen/export and zero AI calls. ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
