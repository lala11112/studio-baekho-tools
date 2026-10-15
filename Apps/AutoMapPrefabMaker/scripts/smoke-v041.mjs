import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, validateMap, connectionPose } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER } = await tsImport('../src/shared/features.ts', import.meta.url);
const { TILE_ASSET_ROLES } = await tsImport('../src/shared/asset-scaling.ts', import.meta.url);
const output = resolve('.local/v041-smoke');
const userData = resolve('.local/v041-smoke-user', `run-${Date.now()}`);
await mkdir(output, { recursive: true }); await mkdir(userData, { recursive: true });
const fixture = resolve(output, 'TestUnity');
await mkdir(resolve(fixture, 'Assets/Modules'), { recursive: true });
await mkdir(resolve(fixture, 'ProjectSettings'), { recursive: true });
const assets = ['floor', 'wall', 'door', 'prop', 'stair', 'ceiling', 'light', 'wallLight', 'cliff', 'deadzone'];
const guid = index => (index + 1).toString(16).padStart(32, '0');
for (const [index, name] of assets.entries()) {
  await writeFile(resolve(fixture, `Assets/Modules/${name}.prefab`), '%YAML 1.1\n');
  await writeFile(resolve(fixture, `Assets/Modules/${name}.prefab.meta`), `fileFormatVersion: 2\nguid: ${guid(index)}\n`);
}
const map = createDemoMap(); map.version = 4; map.name = '041 조명과 넓은 문';
map.rows[5] = `${map.rows[5].slice(0, 3)}_${map.rows[5].slice(4)}`;
map.ceilings = map.rows.flatMap((row, rowIndex) => [...row].flatMap((tile, x) => '.DPRB'.includes(tile) ? [{ x, row: rowIndex, undersideY: 6 }] : []));
const initial = parseProjectFile({ formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, ceilings: true, fixtureDensity: 8 } },
  bindings: assets.map((name, index) => ({ id: name, label: name, role: name === 'wallLight' ? 'light' : name,
    prefabGuid: guid(index), prefabPath: `Assets/Modules/${name}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 })) });
assert.deepEqual(validateMap(initial.map).filter(issue => issue.severity === 'error'), []);
const initialPath = resolve(output, 'initial.baekho.json'); await writeFile(initialPath, JSON.stringify(initial));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env });
const errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, directory) => {
    app.setPath('userData', directory);
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Smoke mock: no AI calls', models: [] }));
    dialog.showMessageBoxSync = () => 1;
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const idle = async () => page.waitForFunction(() => !document.querySelector('[data-action="generate"]')?.disabled);
  const expandAll = async () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const action = name => page.locator(`[data-d-action="${name}"]`);
  const control = name => page.locator(`[data-d-control="${name}"]`);
  const design = async () => { await page.locator('[data-right-tab="design"]').click(); await expandAll(); };
  const openPath = async path => {
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, path);
    await page.locator('[data-action="open"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /프로젝트를 열었습니다/);
  };
  let saveIndex = 0;
  const save = async label => {
    const path = resolve(output, `${String(++saveIndex).padStart(2, '0')}-${label}.baekho.json`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await page.locator('[data-action="save"]').click(); await idle();
    assert.match(await page.locator('#status').innerText(), /저장 완료/);
    return { path, project: JSON.parse(await readFile(path, 'utf8')) };
  };
  const choose = async (x, row) => {
    await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate((svg, cell) => {
      const p = new DOMPoint(cell.x + .5, cell.row + .5).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
    }, { x, row });
    await page.mouse.click(point.x, point.y);
  };
  const scan = async () => {
    await page.locator('[data-right-tab="assets"]').click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixture);
    await page.locator('[data-action="scan"]').click(); await idle();
    assert.match(await page.locator('.asset-project').innerText(), /프리팹 10개/);
  };
  await openPath(initialPath); await scan();

  console.log('v041 smoke: tile defaults, batch sizing, Undo and typed lights');
  await page.locator('#newAssetRole').selectOption('floor'); await page.locator('#newAssetGuid').selectOption(guid(0));
  await page.locator('[data-action="add-binding"]').click();
  let saved = await save('new-floor');
  const newFloor = saved.project.bindings.find(binding => binding.id.startsWith('asset_'));
  assert.deepEqual(newFloor.scale, { x: 2, y: 1, z: 2 });
  await page.locator('#bulkScaleScope').selectOption('tiles'); await page.locator('[data-action="fit-cell-scale"]').click();
  const fitted = (await save('fit-cell')).project;
  for (const binding of fitted.bindings) assert.deepEqual(binding.scale, TILE_ASSET_ROLES.includes(binding.role) ? { x: 2, y: 1, z: 2 } : { x: 1, y: 1, z: 1 });
  await page.locator('#bulkScaleScope').selectOption('floor'); await page.locator('#bulkScaleMode').selectOption('set');
  await page.locator('[data-bulk-axis="x"]').fill('3.5'); await page.locator('[data-bulk-axis="z"]').fill('4');
  await page.locator('[data-action="bulk-scale"]').click();
  const scaled = (await save('set-scale')).project;
  for (const binding of scaled.bindings) assert.deepEqual(binding.scale, binding.role === 'floor' ? { x: 3.5, y: 1, z: 4 } : fitted.bindings.find(item => item.id === binding.id).scale);
  await page.locator('[data-action="undo"]').click(); assert.deepEqual((await save('undo-scale')).project.bindings, fitted.bindings);
  await page.locator('[data-light-anchor="light"]').selectOption('ceiling');
  assert.equal(await page.locator('[data-light-anchor="light"]').inputValue(), 'ceiling', await page.locator('#status').innerText());
  await page.locator('[data-light-anchor="wallLight"]').selectOption('wall');
  assert.equal(await page.locator('[data-light-anchor="wallLight"]').inputValue(), 'wall', await page.locator('#status').innerText());
  const typed = (await save('typed-lights')).project;
  assert.equal(typed.bindings.find(binding => binding.id === 'light').lightAnchor, 'ceiling');
  assert.equal(typed.bindings.find(binding => binding.id === 'wallLight').lightAnchor, 'wall');

  console.log('v041 smoke: wide doorway, pit roof and ceiling/wall lighting');
  await page.locator('[data-right-tab="connections"]').click();
  await page.locator('[data-action="select-connection"][data-id="north"]').click();
  await page.locator('[data-connection="width"]').fill('4'); await page.locator('[data-connection="width"]').press('Tab');
  saved = await save('wide-door');
  assert.equal(saved.project.map.connections.find(connection => connection.id === 'north').width, 4);
  assert.equal(saved.project.map.rows[1].slice(4, 6), 'DD');
  await choose(5, 1); assert.equal(await page.locator('[data-connection="width"]').inputValue(), '4');
  await design(); await action('fill-pit-ceilings').click();
  saved = await save('pit-roof');
  assert.equal(saved.project.map.version, 5, 'Explicit pit roof repair adopts the v5 structural model');
  assert.equal(saved.project.map.rows[5][3], '_', 'Roof fill must keep the pit open');
  assert.equal(saved.project.map.ceilings.find(ceiling => ceiling.x === 3 && ceiling.row === 5).undersideY, 6);
  assert.equal(saved.project.map.ceilings.some(ceiling => ceiling.x === 0 && ceiling.row === 0), false);
  assert.equal(saved.project.map.ceilings.find(ceiling => ceiling.x === 3 && ceiling.row === 5).heightMode, 'auto');
  assert.ok(saved.project.map.pitBottoms.some(bottom => bottom.x === 3 && bottom.row === 5 && bottom.kind === 'deadzone'));
  assert.ok(saved.project.map.structureFills.some(fill => fill.purpose === 'pitSide'));
  assert.ok(saved.project.map.structureFills.some(fill => fill.purpose === 'doorTop'));
  await control('light-placement').selectOption('both'); await design(); await action('regenerate-lights').click();
  saved = await save('mixed-lights');
  const lights = saved.project.map.fixtures.filter(fixture => fixture.role === 'light');
  assert.ok(lights.length >= 4); assert.deepEqual(new Set(lights.map(light => light.anchor)), new Set(['ceiling', 'wall']));
  assert.ok(Math.max(...lights.map(light => light.x)) - Math.min(...lights.map(light => light.x)) >= 8, 'Lights must spread across room width');
  assert.ok(Math.max(...lights.map(light => light.row)) - Math.min(...lights.map(light => light.row)) >= 8, 'Lights must spread across room depth');
  assert.deepEqual(validateMap(saved.project.map).filter(issue => issue.severity === 'error'), []);
  assert.equal(saved.project.settings.designer.lightPlacement, 'both');
  assert.equal(saved.project.bindings.find(binding => binding.id === 'light').lightAnchor, 'ceiling');
  assert.equal(saved.project.bindings.find(binding => binding.id === 'wallLight').lightAnchor, 'wall');
  await page.locator('[data-view="3d"]').click();
  if (await action('view-ceiling').getAttribute('aria-pressed') === 'true') await action('view-ceiling').click();
  const canvas = await page.locator('#preview canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -100);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: resolve(output, 'lighting-and-wide-door.png') });
  await action('view-ceiling').click(); await page.screenshot({ path: resolve(output, 'pit-roof.png') });

  console.log('v041 smoke: native project roundtrip and Unity export');
  const beforeRoundtrip = saved.project;
  await openPath(saved.path); assert.deepEqual((await save('roundtrip')).project, beforeRoundtrip);
  await scan();
  const zipPath = resolve(output, 'bundle.zip');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
  assert.equal(await page.locator('[data-action="export"]').isEnabled(), true);
  await page.locator('[data-action="export"]').click(); await idle();
  assert.match(await page.locator('#status').innerText(), /내보내기 완료/);
  const manifest = JSON.parse(strFromU8(unzipSync(await readFile(zipPath))['Map.baekhomap.json']));
  assert.equal(manifest.schemaVersion, 5);
  assert.ok(manifest.placements.some(placement => placement.role === 'deadzone' && placement.fitSize.y === 1));
  assert.ok(manifest.placements.some(placement => placement.role === 'cliff' && placement.fitSize));
  const north = beforeRoundtrip.map.connections.find(connection => connection.id === 'north');
  assert.deepEqual(manifest.connections.find(connection => connection.id === 'north').position, connectionPose(beforeRoundtrip.map, north).position);
  const door = manifest.placements.find(placement => placement.id === 'door-4-1');
  assert.equal(door.fitWidth, 4); assert.deepEqual(door.position, connectionPose(beforeRoundtrip.map, north).position);
  assert.equal(manifest.placements.some(placement => placement.id === 'door-5-1'), false);
  assert.ok(manifest.placements.some(placement => placement.id === 'floor-5-1'));
  assert.ok(manifest.placements.some(placement => placement.id === 'ceiling-3-5'));
  assert.equal(manifest.placements.some(placement => placement.id === 'floor-3-5'), false);
  for (const light of lights) {
    const placement = manifest.placements.find(placement => placement.id === `fixture-${light.id}`);
    assert.equal(placement.prefabGuid, light.anchor === 'ceiling' ? guid(6) : guid(7));
    assert.equal(placement.surface, 'pivot'); assert.equal(placement.rotation.y, light.direction);
  }
  assert.deepEqual(errors, []);
  console.log(`v041 smoke passed: ${lights.length} distributed lights, roof over pit, 4m door, batch sizing and native export. ${output}`);
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await app.close();
}
