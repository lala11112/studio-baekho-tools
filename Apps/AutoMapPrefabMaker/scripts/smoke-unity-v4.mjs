// Real Editor regression and application ZIP -> Unity prefab verification.
// Run: npm run test:unity (installs AI Navigation in the test project first).
// Direct runs require AI Navigation already installed; optional UNITY_EDITOR absolute executable.
// Only the repository's ignored .local/unity-validation project is modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(root, '.local/unity-validation');
const local = resolve(root, '.local');
const versionFile = resolve(projectPath, 'ProjectSettings/ProjectVersion.txt');
const versionText = await readFile(versionFile, 'utf8').catch(() => '');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim() ?? '6000.3.10f1';
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor).catch(() => { throw new Error('Set UNITY_EDITOR to an installed Unity Editor executable.'); });
await mkdir(local, { recursive: true });

async function runEditor(method, logName, create = false) {
  const log = resolve(local, logName);
  const args = ['-batchmode', '-nographics', create ? '-createProject' : '-projectPath', projectPath,
    ...(method ? ['-executeMethod', method] : []), '-quit', '-logFile', log];
  await new Promise((done, fail) => {
    const child = spawn(editor, args, { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity verification timed out; see ${log}`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) done();
      else fail(new Error(`Unity verification exited ${code}; see ${log}`));
    });
  });
  const text = await readFile(log, 'utf8');
  if (method) assert.match(text, method.endsWith('.Run') ? /BAEKHO_SMOKE_PASS/ : /BAEKHO_APP_EXPORT_PASS/);
}

if (!versionText) await runEditor(null, 'unity-v4-create.log', true);
await mkdir(resolve(projectPath, 'Assets/Editor'), { recursive: true });
await mkdir(resolve(projectPath, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ['unity-importer/Editor/BaekhoMapImporter.cs', 'Assets/Editor/BaekhoMapImporter.cs'],
  ['unity-importer/Editor/BaekhoPropCatalog.cs', 'Assets/Editor/BaekhoPropCatalog.cs'],
  ['tests/unity/BaekhoImporterSmoke.cs', 'Assets/Editor/BaekhoImporterSmoke.cs'],
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture','BaekhoWallModule'].map(name =>
    [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
]) await copyFile(resolve(root, source), resolve(projectPath, destination));
if (!process.argv.includes('--export-only')) {
  await runEditor('BaekhoImporterSmoke.Run', 'unity-v4-validation.log');
  console.log(await readFile(resolve(local, 'unity-validation-result.txt'), 'utf8'));
}

const [{ createDemoMap, DEFAULT_SETTINGS, buildManifest, validateMap, updateConnectionGeometry }, { ASSET_ROLES, FIXTURE_ROLES, exposedCliffFaces },
  { scanUnityProject }, { createExportBundle }] = await Promise.all([
  tsImport('../src/shared/map.ts', import.meta.url), tsImport('../src/shared/features.ts', import.meta.url),
  tsImport('../electron/services/unity-project.ts', import.meta.url), tsImport('../electron/services/projects.ts', import.meta.url),
]);
const scan = await scanUnityProject(projectPath);
const requireAsset = name => {
  const asset = scan.assets.find(item => item.path === `Assets/BaekhoValidation/${name}.prefab`);
  assert.ok(asset, `Run full smoke first to create the ${name} fixture`);
  return asset;
};
const cube = requireAsset('Surface0'), stair = requireAsset('Stair'), light = requireAsset('LightOnly');
const bindings = ASSET_ROLES.map(role => {
  const asset = role === 'light' ? light : role === 'stair' || role === 'slope' ? stair : cube;
  return { id: role, label: role, role, prefabGuid: asset.guid, prefabPath: asset.path,
    scale: { x: 2, y: role === 'bridge' ? .35 : role === 'stair' || role === 'slope' ? 9 : 1, z: 2 },
    offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    ...(role === 'stair' || role === 'slope' ? { stairNativeRise: 1 } : {}),
  };
});
let map = createDemoMap();
map.version = 4;
map.name = 'Baekho V4 Integration';
const setTile = (x, row, tile) => { map.rows[row] = map.rows[row].slice(0, x) + tile + map.rows[row].slice(x + 1); };
setTile(4, 5, 'B'); setTile(4, 4, '_'); setTile(4, 6, '_');
map.bridges = [{ x: 4, row: 5, direction: 90 }];
map.ramps[0].kind = 'slope';
map.ceilings = [{ x: 3, row: 3, undersideY: 4 }, { x: 10, row: 12, undersideY: 6 }];
map.wallHeights = [{ x: 2, row: 1, height: 4.5 }];
map.cliffs = exposedCliffFaces(map, 4);
map.fixtures = FIXTURE_ROLES.map((role, index) => ({ id: role, role, x: 2 + index % 4, row: 2 + Math.floor(index / 4),
  direction: [0, 90, 180, 270][index % 4], offset: { x: .2, y: role === 'light' ? 2.5 : .1, z: -.2 },
  ...(role === 'switch' ? { linkedId: 'gate' } : {}),
}));
// Keep all fixtures on authored floor even around the small test void.
for (const fixture of map.fixtures) if (!'.DPB'.includes(map.rows[fixture.row][fixture.x])) { fixture.x = 2; fixture.row = 2; }
map.markers = ['enemy', 'reward', 'event'].map((kind, index) => ({ id: `${kind}-point`, label: `검증 ${kind}`, kind,
  contentKey: `content/${kind}`, x: 2 + index, row: 2, direction: 90, offset: { x: .1, y: .2, z: -.1 },
}));
map = updateConnectionGeometry(map, 'north', { width: 5.5 });
assert.deepEqual(validateMap(map).filter(issue => issue.severity === 'error'), []);
const project = { formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS }, bindings };
const scripts = await Promise.all(['Editor/BaekhoMapImporter', 'Runtime/BaekhoMapConnection',
  'Runtime/BaekhoGameplayMarker', 'Runtime/BaekhoMapFixture'].map(name => readFile(resolve(root, `unity-importer/${name}.cs`), 'utf8')));
const zip = await createExportBundle(project, scan, ...scripts);
await writeFile(resolve(local, 'app-generated-unity-v4-bundle.zip'), zip);
const files = unzipSync(zip);
const manifest = JSON.parse(strFromU8(files['Map.baekhomap.json']));
assert.deepEqual(manifest, buildManifest(map, bindings));
assert.equal(manifest.schemaVersion, 4);
assert.equal(manifest.markers.length, 3);
assert.equal(manifest.placements.find(item => item.id === 'fixture-switch').linkedId, 'fixture-gate');
assert.equal(manifest.placements.find(item => item.id === 'fixture-light').surface, 'pivot');
assert.equal(manifest.placements.find(item => item.id === 'door-4-1').fitWidth, 5.5);
assert.equal(manifest.placements.some(item => item.id === 'door-5-1' || item.id === 'door-6-1'), false);
assert.equal(manifest.placements.some(item => item.id === 'floor-4-5'), false, 'Bridge exports no extra floor below its deck');
for (const [name, source] of ['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture'].map((name, index) => [name, scripts[index + 1]]))
  assert.equal(strFromU8(files[`Unity/Runtime/${name}.cs`]), source, `ZIP contains required runtime ${name}`);
await writeFile(resolve(projectPath, 'Assets/BaekhoValidation/app-generated.baekhomap.json'), files['Map.baekhomap.json']);
await runEditor('BaekhoImporterSmoke.RunFeatureExport', 'unity-v4-app-export.log');
console.log(await readFile(resolve(local, 'unity-app-export-result.txt'), 'utf8'));

// v5 verifies the real app's derived fills and lower pit closures, not only hand-written JSON.
const { configureStructures, DEFAULT_STRUCTURE_SETTINGS } = await tsImport('../src/shared/structures.ts', import.meta.url);
let structured = configureStructures(map, DEFAULT_STRUCTURE_SETTINGS);
structured.name = 'Baekho V5 Structure Integration';
const { insertPropInstance } = await tsImport('../src/shared/props.ts', import.meta.url);
const boundsCatalog = JSON.parse(await readFile(resolve(local, 'prop-catalog-validation.json'), 'utf8'));
const measuredAsset = scan.assets.find(asset => asset.path.startsWith('Assets/BaekhoValidation/MeasuredProp') && boundsCatalog.assets.some(entry => entry.guid === asset.guid));
assert.ok(measuredAsset, 'native smoke supplies measured off-center prop');
const measuredSize = boundsCatalog.assets.find(entry => entry.guid === measuredAsset.guid).size;
const measuredBinding = { id: 'measured-v5', label: 'Measured collider prop', role: 'prop', prefabGuid: measuredAsset.guid, prefabPath: measuredAsset.path,
  scale: { x: .25, y: .5, z: .25 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: 'furniture', tags: [], blocksMovement: true, size: measuredSize, placement: 'floor', roomTypes: ['battle'], weight: 1 } };
const v5Bindings = [...structuredClone(bindings), measuredBinding];
const thickFloor = { ...structuredClone(v5Bindings.find(b => b.role === 'floor')), id: 'thick-offset-floor', scale: { x: 2, y: 2.5, z: 2 }, offset: { x: 0, y: .15, z: 0 } };
v5Bindings.push(thickFloor);
v5Bindings.find(b => b.role === 'cliff').offset.y = -.2;
v5Bindings.find(b => b.role === 'wall').offset.y = .1;
const rim = structured.structureFills.find(fill => fill.purpose === 'pitSide' && '.DPR'.includes(structured.rows[fill.row][fill.x]));
assert.ok(rim, 'native slab contact fixture has a pit rim floor');
structured.assetOverrides.push({ x: rim.x, row: rim.row, role: 'floor', bindingId: thickFloor.id });
let placedMeasured = false;
for (let row = 3; row < structured.height - 2 && !placedMeasured; row++) for (let x = 7; x < structured.width - 2 && !placedMeasured; x++) {
  try { structured = insertPropInstance(structured, { x, row }, measuredBinding.id, project.settings, v5Bindings); placedMeasured = true; } catch { /* Probe only validated terrain positions. */ }
}
assert.ok(placedMeasured, 'measured off-center native source fits an existing valid room position');
assert.deepEqual(validateMap(structured).filter(issue => issue.severity === 'error'), []);
const structuredZip = await createExportBundle({ ...project, map: structured, bindings: v5Bindings }, scan, ...scripts);
const structuredFiles = unzipSync(structuredZip), structuredManifest = JSON.parse(strFromU8(structuredFiles['Map.baekhomap.json']));
assert.equal(structuredManifest.schemaVersion, 5);
assert.ok(structuredManifest.placements.some(item => item.fitSize), 'v5 exports authored source fitting for structural closures');
assert.ok(structuredManifest.placements.some(item => item.role === 'deadzone'), 'internal void exports its lower deadzone');
assert.ok(structuredManifest.placements.some(item => item.role === 'prop' && item.centerXZ === true), 'measured props request catalog-envelope alignment without size fitting');
await writeFile(resolve(local, 'app-generated-unity-v5-bundle.zip'), structuredZip);
await writeFile(resolve(projectPath, 'Assets/BaekhoValidation/app-generated.baekhomap.json'), structuredFiles['Map.baekhomap.json']);
await runEditor('BaekhoImporterSmoke.RunFeatureExport', 'unity-v5-app-export.log');
console.log(await readFile(resolve(local, 'unity-app-export-result.txt'), 'utf8'));
