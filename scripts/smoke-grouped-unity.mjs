// Actual importer, measured synthetic prefabs and character-eye PNGs in the ignored validation project.
// No package installs, AI calls or changes to any user game project. Requires an installed licensed Editor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { unzipSync, strFromU8 } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(root, '.local/unity-validation');
const output = resolve(root, '.local/grouped-unity-validation');
const versionText = await readFile(resolve(projectPath, 'ProjectSettings/ProjectVersion.txt'), 'utf8');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim();
assert.ok(version, 'Use the existing isolated validation project; this test never creates or installs a project');
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor); await mkdir(output, { recursive: true });
await mkdir(resolve(projectPath, 'Assets/GroupedValidation/Editor'), { recursive: true });
await mkdir(resolve(projectPath, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ['unity-importer/Editor/BaekhoMapImporter.cs', 'Assets/Editor/BaekhoMapImporter.cs'],
  ['tests/unity/BaekhoGroupedSmoke.cs', 'Assets/GroupedValidation/Editor/BaekhoGroupedSmoke.cs'],
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture', 'BaekhoWallModule'].map(name => [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
]) await copyFile(resolve(root, source), resolve(projectPath, destination));

async function runEditor(method, filename) {
  const log = resolve(output, filename);
  await new Promise((done, fail) => {
    // Keep graphics enabled for real RenderTexture camera output. The helper window stays hidden.
    const child = spawn(editor, ['-batchmode', '-projectPath', projectPath, '-executeMethod', method, '-quit', '-logFile', log], { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity grouped validation timed out; see ${log}`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(`Unity grouped validation exited ${code}; see ${log}`)); });
  });
  assert.match(await readFile(log, 'utf8'), method.endsWith('.Prepare') ? /BAEKHO_GROUPED_PREPARE_PASS/ : /BAEKHO_GROUPED_UNITY_PASS/);
}
await runEditor('BaekhoGroupedSmoke.Prepare', 'prepare.log');
const [{ DEFAULT_SETTINGS, parseProjectFile, buildManifest }, { DEFAULT_DESIGNER }, { insertPropInstance, propWorldSize, propValidationIssues },
  { rearrangeMapProps }, { scanUnityProject }, { createExportBundle }] = await Promise.all([
  tsImport('../src/shared/map.ts', import.meta.url), tsImport('../src/shared/features.ts', import.meta.url), tsImport('../src/shared/props.ts', import.meta.url),
  tsImport('../src/shared/furnishing.ts', import.meta.url), tsImport('../electron/services/unity-project.ts', import.meta.url), tsImport('../electron/services/projects.ts', import.meta.url),
]);
const native = JSON.parse(await readFile(resolve(output, 'native-catalog.json'), 'utf8'));
const bindings = native.assets.map(asset => ({ id: asset.id, label: asset.id, role: ['floor', 'wall', 'door'].includes(asset.id) ? asset.id : 'prop',
  prefabGuid: asset.guid, prefabPath: asset.path, scale: asset.id === 'floor' ? { x: 2, y: .12, z: 2 } : asset.id === 'wall' ? { x: 2, y: 4, z: 2 } : asset.id === 'door' ? { x: 2, y: 3, z: 2 } : { x: 1, y: 1, z: 1 },
  offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  ...(['console', 'generator', 'crate'].includes(asset.id) ? { prop: { category: asset.id, tags: [], size: asset.size,
    blocksMovement: true, placement: 'floor', roomTypes: ['battle'], weight: 1,
    composition: { usage: asset.id === 'crate' ? 'storage' : 'equipment', family: asset.id === 'crate' ? 'storage' : 'equipment', member: 'either', arrangement: asset.id === 'crate' ? 'island' : 'wall' } } } : {}),
}));
const settings = { ...DEFAULT_SETTINGS, width: 24, height: 20, connectionCount: 1, seed: 237, conceptMode: 'manual',
  prompt: 'Synthetic native grouped validation. Same room and measured prefabs before and after.',
  designer: { ...DEFAULT_DESIGNER, props: true, decorations: false, vegetation: false, elevation: false, ceilings: false, enemies: false, rewards: false, propLayout: 'grouped', propCoverage: 8 },
  levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } };
let before = { version: 5, name: 'Synthetic Before', width: 24, height: 20, cellSize: 2, maxStepHeight: .4,
  rows: ['############D###########', ...Array(18).fill('#......................#'), '########################'],
  elevations: Array.from({ length: 20 }, () => Array(24).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'entry', label: 'Entry', x: 12, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
let count = 0;
for (const row of [4, 8, 12, 16]) for (const x of [3, 7, 11, 15, 19]) {
  const bindingId = ['console', 'generator', 'crate'][count % 3];
  before = insertPropInstance(before, { x, row }, bindingId, settings, bindings);
  const prop = before.propInstances.at(-1); prop.id = `scattered-${count}`; prop.authored = false; prop.provenance = 'generated';
  prop.direction = [0, 90, 180, 270][count % 4]; prop.size = propWorldSize(bindings.find(binding => binding.id === bindingId), prop.direction); count++;
}
before = parseProjectFile({ formatVersion: 1, map: before, settings, bindings }).map;
const result = rearrangeMapProps(before, settings, bindings, { props: true, decorations: false });
assert.equal(result.unchanged, false, JSON.stringify(result.issues)); assert.ok(result.groupCount > 0); assert.ok(result.movedProps > 0);
assert.deepEqual(propValidationIssues(result.map, bindings).filter(issue => issue.severity === 'error'), []);
const after = { ...result.map, name: 'Synthetic After' };
const geography = map => ({ ...map, name: '', rows: map.rows.map(row => row.replaceAll('P', '.')), propInstances: [] });
assert.deepEqual(geography(after), geography(before), 'the same map geography and source prefabs are used before and after');
const scan = await scanUnityProject(projectPath);
const importerScripts = await Promise.all(['Editor/BaekhoMapImporter', 'Runtime/BaekhoMapConnection', 'Runtime/BaekhoGameplayMarker', 'Runtime/BaekhoMapFixture'].map(name => readFile(resolve(root, `unity-importer/${name}.cs`), 'utf8')));
const { analyzeLevelDesign } = await tsImport('../src/shared/level-design.ts', import.meta.url);
for (const [phase, map] of [['before', before], ['after', after]]) {
  const project = { formatVersion: 1, map, settings, bindings };
  const bundle = await createExportBundle(project, scan, ...importerScripts);
  await writeFile(resolve(output, `${phase}-synthetic-unity.zip`), bundle);
  const files = unzipSync(bundle), manifest = JSON.parse(strFromU8(files['Map.baekhomap.json']));
  assert.deepEqual(manifest, buildManifest(map, bindings));
  assert.equal(manifest.placements.some(placement => 'groupId' in placement || 'provenance' in placement), false, 'Unity remains on individual placement wire format');
  await writeFile(resolve(projectPath, `Assets/GroupedValidation/${phase}.baekhomap.json`), files['Map.baekhomap.json']);
  await writeFile(resolve(output, `${phase}.baekho.json`), JSON.stringify(project));
  const analysis = analyzeLevelDesign(map, settings); assert.ok(analysis.combatCenter, 'actual level-design analysis supplies a combat center');
  const world = cell => ({ x: (cell.x - (map.width - 1) / 2) * map.cellSize, y: map.elevations[cell.row][cell.x], z: ((map.height - 1) / 2 - cell.row) * map.cellSize });
  const door = map.connections[0], entry = world(door), inward = { 0: [0, -1], 90: [-1, 0], 180: [0, 1], 270: [1, 0] }[door.direction]; entry.x += inward[0] * map.cellSize * 1.25; entry.z += inward[1] * map.cellSize * 1.25;
  await writeFile(resolve(output, `${phase}-expected.json`), JSON.stringify({ groups: result.groupCount, moved: result.movedProps,
    combatCenter: world(analysis.combatCenter), entry, floorHalfX: map.width * map.cellSize / 2 - map.cellSize * 1.5, floorHalfZ: map.height * map.cellSize / 2 - map.cellSize * 1.5,
    props: map.propInstances.map(prop => ({ id: prop.id, groupId: prop.groupId ?? '', size: prop.size })) }));
}
await runEditor('BaekhoGroupedSmoke.Run', 'render.log');
const resultText = await readFile(resolve(output, 'unity-result.txt'), 'utf8');
const navigation = JSON.parse(await readFile(resolve(output, 'navigation-result.json'), 'utf8'));
assert.equal(navigation.groups, result.groupCount); assert.ok(navigation.routes >= result.groupCount * 2 + 1);
assert.ok(navigation.minimumRouteMetres > 3); assert.ok(navigation.agentRadius >= .4); assert.ok(navigation.agentHeight >= 1.7);
assert.ok(navigation.minimumPhysicalClearance >= navigation.agentRadius - .001, 'every sampled native route preserves the full character radius against real prop and wall colliders');
assert.ok(navigation.voxelSize <= navigation.agentRadius / 6 + .00001); assert.ok(navigation.propGuards >= after.propInstances.length); assert.ok(navigation.quarterMetreSamples > navigation.routes * 10);
await writeFile(resolve(output, 'result.json'), JSON.stringify({ result: 'PASS', syntheticPrefabs: true, eyeHeightMetres: 1.7,
  beforeCount: before.propInstances.length, afterCount: after.propInstances.length, groups: result.groupCount, moved: result.movedProps,
  added: result.addedProps, removed: result.removedProps, unity: resultText, navigation,
  beforeImage: resolve(output, 'before-synthetic-eye.png'), afterImage: resolve(output, 'after-synthetic-eye.png') }, null, 2));
console.log(resultText); console.log(`PASS real importer manifests and character-eye before/after renders: ${output}`);
