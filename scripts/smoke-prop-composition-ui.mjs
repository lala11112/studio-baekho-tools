// Real Electron settings, measured bounds and placeholder preview regression. No AI or Unity launch.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { DEFAULT_SETTINGS, parseProjectFile } = await tsImport('../src/shared/map.ts', import.meta.url);
const { DEFAULT_DESIGNER, applyGeneratedFeatures } = await tsImport('../src/shared/features.ts', import.meta.url);
const { getPropCoverageReport, insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
const output = resolve('.local/prop-composition-ui-smoke');
const userData = resolve(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const designer = { ...DEFAULT_DESIGNER, elevation: false, props: true, decorations: true, vegetation: true };
delete designer.propLayout; delete designer.propCoverage;
const settings = { ...DEFAULT_SETTINGS, width: 12, height: 12, connectionCount: 1, conceptMode: 'manual',
  prompt: 'Prop composition UI regression', designer };
const bindings = ['floor', 'wall', 'door', 'measured', 'unmeasured'].map((name, index) => ({
  id: name, role: ['measured', 'unmeasured'].includes(name) ? 'prop' : name,
  label: name === 'measured' ? '긴 작업대' : name === 'unmeasured' ? '미측정 상자' : name,
  prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${name}.prefab`,
  scale: name === 'measured' ? { x: 1.5, y: 2, z: .5 } : { x: 1, y: 1, z: 1 },
  rotationY: name === 'measured' ? 90 : 0, offset: { x: 0, y: 0, z: 0 },
  ...(name === 'measured' ? { prop: { category: '작업대', tags: [], blocksMovement: true,
    size: { x: 3, y: 1.25, z: 2 }, placement: 'floor', roomTypes: ['battle', 'boss'], weight: 1 } } : {}),
}));
let map = { version: 5, name: '크기와 배치 설정 검증', width: 12, height: 12, cellSize: 2,
  rows: ['######D#####', ...Array(10).fill('#..........#'), '############'],
  elevations: Array.from({ length: 12 }, () => Array(12).fill(0)), ramps: [], assetOverrides: [], maxStepHeight: .4,
  connections: [{ id: 'entry', label: '입구', x: 6, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
map = insertPropInstance(map, { x: 2, row: 3 }, 'measured', settings, bindings);
map.rows[8] = '#......P...#';
map.assetOverrides.push({ x: 7, row: 8, role: 'prop', bindingId: 'unmeasured' });
map = parseProjectFile({ formatVersion: 1, map, settings, bindings }).map;
const input = resolve(output, 'legacy.baekho.json');
await writeFile(input, JSON.stringify({ formatVersion: 1, map, settings, bindings }));
const generatedSettings = { ...DEFAULT_SETTINGS, width: 18, height: 16, connectionCount: 1, conceptMode: 'manual', seed: 237,
  prompt: 'Balanced measured prop composition',
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: true, propLayout: 'balanced', propCoverage: 12 },
  levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } };
const generatedBindings = [...bindings.filter(binding => ['floor', 'wall', 'door'].includes(binding.role)),
  ...[['small', '작은 상자', 1.2, .8, 1.2], ['medium', '중형 작업대', 2.6, 1.6, 1.8], ['large', '대형 장비', 4.2, 3, 2.4]].map(([id, label, x, y, z], index) => ({
    id, label, role: 'prop', prefabGuid: String(index + 6).repeat(32), prefabPath: `Assets/${id}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: label, tags: [], blocksMovement: true, size: { x, y, z }, placement: 'floor', roomTypes: ['battle'], weight: 1 },
  }))];
const generatedSource = { version: 5, name: '크기별 균형 배치 검증', width: 18, height: 16, cellSize: 2, maxStepHeight: .4,
  rows: ['#########D########', ...Array(14).fill('#................#'), '##################'],
  elevations: Array.from({ length: 16 }, () => Array(18).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'entry', label: '입구', x: 9, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
const generated = applyGeneratedFeatures(generatedSource, generatedSettings, undefined, generatedBindings);
const generatedReport = getPropCoverageReport(generated, generatedSettings, generatedBindings);
assert.ok(generated.propInstances.length > 3);
assert.equal(generatedReport.unmeasuredCount, 0);
assert.ok(new Set(generated.propInstances.map(prop => prop.bindingId)).size >= 2);
const generatedInput = resolve(output, 'balanced-generated.baekho.json');
await writeFile(generatedInput, JSON.stringify({ formatVersion: 1, map: generated, settings: generatedSettings, bindings: generatedBindings }));
await writeFile(resolve(output, 'balanced-generated-coverage.json'), JSON.stringify(generatedReport, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.BAEKHO_DEV_URL; delete env.OPENAI_API_KEY;
const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, ipcMain, dialog }, path) => {
    app.setPath('userData', path); dialog.showMessageBoxSync = () => 1;
    ipcMain.removeHandler('baekho:codex-status');
    ipcMain.handle('baekho:codex-status', () => ({ state: 'ready', message: 'Local regression', models: [] }));
  }, userData);
  await page.reload(); await page.locator('#preview canvas').waitFor();
  const expand = () => page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const control = name => page.locator(`[data-d-control="${name}"]`);
  const open = async path => {
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, path);
    await page.locator('[data-action="open"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('프로젝트를 열었습니다'));
    await expand();
  };
  const save = async name => {
    const target = resolve(output, `${name}.baekho.json`);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, target);
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장 완료'));
    return { path: target, project: JSON.parse(await readFile(target, 'utf8')) };
  };
  const choose = async (x, row) => {
    await page.locator('[data-view="grid"]').click(); await page.locator('[data-edit-mode="select"]').click();
    const point = await page.locator('#map-svg').evaluate((svg, cell) => {
      const point = new DOMPoint(cell.x + .5, cell.row + .5).matrixTransform(svg.getScreenCTM()); return { x: point.x, y: point.y };
    }, { x, row });
    await page.mouse.click(point.x, point.y); await expand();
    await page.locator('[data-view="3d"]').click(); await page.locator('#preview canvas').waitFor();
  };
  await expand();
  assert.equal(await control('prop-layout').inputValue(), 'grouped', 'new projects use grouped composition');
  assert.equal(await control('setting:propCoverage').inputValue(), '12');
  await open(input);
  assert.equal(await control('prop-layout').inputValue(), 'legacy', 'missing saved field retains legacy composition');
  assert.equal(await control('setting:propCoverage').count(), 0);
  assert.match(await page.locator('[data-preview-prop-unmeasured="1"]').innerText(), /크기 미확정 · 임시 표시 1개/);
  await control('prop-layout').selectOption('balanced'); await expand();
  const coverage = control('setting:propCoverage');
  assert.equal(await coverage.getAttribute('min'), '1'); assert.equal(await coverage.getAttribute('max'), '30');
  await coverage.fill('18'); await coverage.press('Tab'); await expand();
  await control('preset').selectOption('boss'); await expand();
  assert.equal(await control('prop-layout').inputValue(), 'balanced');
  assert.equal(await control('setting:propCoverage').inputValue(), '18', 'purpose presets retain chosen layout and coverage');
  const configured = await save('configured');
  assert.equal(configured.project.settings.designer.propLayout, 'balanced');
  assert.equal(configured.project.settings.designer.propCoverage, 18);
  assert.deepEqual(configured.project.map, map, 'editing generation settings leaves authored map unchanged');
  await open(configured.path);
  assert.equal(await control('setting:propCoverage').inputValue(), '18');
  await control('prop-layout').selectOption('legacy'); await expand();
  assert.equal(await control('setting:propCoverage').count(), 0);
  await page.locator('[data-action="undo"]').click(); await expand();
  assert.equal(await control('prop-layout').inputValue(), 'balanced');
  assert.equal(await control('setting:propCoverage').inputValue(), '18');
  await choose(2, 3);
  const measured = page.locator('[data-preview-prop-selection="measured"]');
  assert.match(await measured.innerText(), /긴 작업대/);
  assert.match(await measured.innerText(), /X 1 × Y 2\.5 × Z 4\.5 m/, 'preview uses measured dimensions, scale and rotation');
  await page.screenshot({ path: resolve(output, 'measured-preview.png') });
  await choose(7, 8);
  const placeholder = page.locator('[data-preview-prop-selection="unmeasured"]');
  assert.match(await placeholder.innerText(), /미측정 상자/);
  assert.match(await placeholder.innerText(), /크기 미확정 · 임시 표시/);
  assert.doesNotMatch(await placeholder.innerText(), /X \d|×|\d\s*m\b/, 'placeholder dimensions are never presented as measured');
  await page.screenshot({ path: resolve(output, 'unmeasured-preview.png') });
  await page.locator('[data-right-tab="assets"]').click(); await expand();
  assert.match(await page.locator('[data-prop-binding="measured"][data-prop-field="size"]').inputValue(), /3, 1\.25, 2/);
  assert.match(await page.locator('[data-prop-size-state="measured"]').innerText(), /X 1 × Y 2\.5 × Z 4\.5m · 대형/);
  assert.match(await page.locator('[data-prop-size-state="unmeasured"]').innerText(), /크기 미확정 · 임시 표시/);
  assert.deepEqual((await save('preview-preserved')).project.map, map, 'selection and preview preserve original measured objects and placeholders');
  const field = name => page.locator(`[data-prop-binding="measured"][data-prop-field="${name}"]`);
  await field('behavior').selectOption('floorEquipment'); await expand();
  await field('frontYaw').fill('180'); await field('frontYaw').press('Tab'); await expand();
  const profiled = await save('functional-front');
  assert.equal(profiled.project.bindings.find(b => b.id === 'measured').prop.frontYaw, 180);
  assert.equal(profiled.project.bindings.find(b => b.id === 'measured').prop.behavior, 'floorEquipment');
  assert.deepEqual(profiled.project.map, map, 'asset functional edits never rearrange stored placements');
  await open(profiled.path); await page.locator('[data-right-tab="cell"]').click(); await choose(2, 3);
  const yaw = page.locator('[data-prop-instance-yaw]');
  assert.equal(await yaw.inputValue(), '0');
  await yaw.fill('6'); await yaw.press('Tab'); await expand();
  const rotated = await save('rotated');
  const changed = rotated.project.map.propInstances.find(p => p.bindingId === 'measured');
  assert.equal(changed.direction + changed.yawOffset, 6);
  assert.equal(changed.provenance, 'manual');
  assert.ok(changed.size.x > map.propInstances[0].size.x, 'rotation recomputes conservative occupancy bounds');
  assert.match(await page.locator('[data-preview-prop-selection="measured"]').innerText(), /정면 276°/);
  await page.screenshot({ path: resolve(output, 'rotated-front-preview.png') });
  await page.locator('[data-action="undo"]').click(); await expand();
  assert.deepEqual((await save('rotation-undone')).project.map, map);
  await page.locator('[data-action="redo"]').click(); await expand();
  assert.deepEqual((await save('rotation-redone')).project.map, rotated.project.map);
  await open(rotated.path);
  assert.deepEqual((await save('rotation-reopened')).project.map, rotated.project.map);
  await open(generatedInput);
  await page.locator('[data-view="3d"]').click(); await page.locator('#preview canvas').waitFor();
  const report = page.locator('[data-prop-coverage]');
  assert.match(await report.innerText(), new RegExp(`현재 맵 소품 점유율 ${generatedReport.actualPercent.toFixed(1).replace('.', '\\.')}% · 목표 12%`));
  assert.match(await report.innerText(), new RegExp(`소품 ${generatedReport.occupiedArea.toFixed(1).replace('.', '\\.')}m² / 바닥 ${generatedReport.floorArea.toFixed(1).replace('.', '\\.')}m²`));
  assert.equal(await page.locator('[data-preview-prop-unmeasured]').count(), 0, 'generated measured library produces no placeholders');
  if (generatedReport.unmet) assert.match(await report.innerText(), /목표 점유율에 미달/);
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'balanced-generated-preview.png') });
  assert.deepEqual((await save('balanced-generated-preserved')).project.map.propInstances, generated.propInstances);
  assert.deepEqual(errors, []);
  console.log(`PASS prop composition UI: new/legacy defaults, conditional coverage, preset retention, save/reopen, Undo, real scaled/rotated dimensions, explicit placeholders and generated measured coverage. ${output}`);
} finally {
  await app.close();
}
