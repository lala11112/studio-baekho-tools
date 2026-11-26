// Real importer/native geometry proof in the existing ignored validation project.
// The user's open Unity project is never opened or changed by this harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(root, '.local/unity-validation');
const output = resolve(root, '.local/prop-orientation-unity-validation');
const versionText = await readFile(resolve(projectPath, 'ProjectSettings/ProjectVersion.txt'), 'utf8');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim();
assert.ok(version, 'This test requires the existing isolated validation project');
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor); await mkdir(output, { recursive: true });
await mkdir(resolve(projectPath, 'Assets/PropOrientationValidation/Editor'), { recursive: true });
await mkdir(resolve(projectPath, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ['unity-importer/Editor/BaekhoMapImporter.cs', 'Assets/Editor/BaekhoMapImporter.cs'],
  ['tests/unity/BaekhoPropOrientationSmoke.cs', 'Assets/PropOrientationValidation/Editor/BaekhoPropOrientationSmoke.cs'],
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture', 'BaekhoWallModule'].map(name => [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
]) await copyFile(resolve(root, source), resolve(projectPath, destination));

async function runEditor(method, filename) {
  const log = resolve(output, filename);
  await new Promise((done, fail) => {
    const child = spawn(editor, ['-batchmode', '-projectPath', projectPath, '-executeMethod', method, '-quit', '-logFile', log], { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Native orientation validation timed out; see ${log}`)); }, 300000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(`Native orientation validation exited ${code}; see ${log}`)); });
  });
  assert.match(await readFile(log, 'utf8'), method.endsWith('.Prepare') ? /BAEKHO_PROP_ORIENTATION_PREPARE_PASS/ : /BAEKHO_PROP_ORIENTATION_UNITY_PASS/);
}

if (!process.argv.includes('--skip-prepare')) await runEditor('BaekhoPropOrientationSmoke.Prepare', 'prepare.log');
if (process.argv.includes('--prepare-only')) process.exit(0);
const [{ DEFAULT_SETTINGS, parseProjectFile, buildManifest, validateMap }, { DEFAULT_DESIGNER },
  { insertPropInstance, propValidationIssues, propPosition, rotatePropInstance }, { rearrangeMapProps }, { propFrontYaw, propRootYaw }] = await Promise.all([
  tsImport('../src/shared/map.ts', import.meta.url), tsImport('../src/shared/features.ts', import.meta.url), tsImport('../src/shared/props.ts', import.meta.url),
  tsImport('../src/shared/furnishing.ts', import.meta.url), tsImport('../src/shared/prop-orientation.ts', import.meta.url),
]);
const native = JSON.parse(await readFile(resolve(output, 'native-catalog.json'), 'utf8'));
const bindings = native.assets.map(asset => {
  const structural = ['floor', 'wall', 'door'].includes(asset.id), workstation = ['Desk', 'Chair', 'Monitor'].includes(asset.id);
  const behavior = asset.id === 'Desk' ? 'workSurface' : asset.id === 'Chair' ? 'seat' : asset.id === 'Monitor' ? 'surfaceAccessory' : asset.id.includes('Console') ? 'floorEquipment' : 'generic';
  return { id: asset.id, label: asset.id, role: structural ? asset.id : 'prop', prefabGuid: asset.guid, prefabPath: asset.path,
    scale: asset.id === 'floor' ? { x: 2, y: .12, z: 2 } : asset.id === 'wall' ? { x: 2, y: 4, z: 2 } : asset.id === 'door' ? { x: 2, y: 3, z: 2 } : { x: 1, y: 1, z: 1 },
    offset: { x: 0, y: 0, z: 0 }, rotationY: asset.id === 'ReversedConsole' ? 27 : 0,
    ...(!structural ? { prop: { category: asset.id, tags: [], size: asset.size, blocksMovement: true, placement: 'floor', roomTypes: ['battle'],
      weight: asset.id === 'ReversedConsole' ? 3 : 1, behavior, frontYaw: asset.nativeFrontYaw,
      composition: { usage: asset.id === 'Crate' ? 'storage' : 'equipment', family: workstation ? 'workstation' : asset.id === 'Crate' ? 'storage' : 'control',
        member: ['Chair', 'Monitor'].includes(asset.id) ? 'companion' : asset.id === 'Desk' ? 'anchor' : 'either', arrangement: asset.id === 'Crate' ? 'island' : 'wall' } } } : {}) };
});
const settings = { ...DEFAULT_SETTINGS, width: 24, height: 20, connectionCount: 1, seed: 237, conceptMode: 'manual', prompt: 'Synthetic prop orientation and use-context validation.',
  designer: { ...DEFAULT_DESIGNER, props: true, decorations: false, vegetation: false, elevation: false, ceilings: false, enemies: false, rewards: false, propLayout: 'grouped', propCoverage: 8 },
  levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } };
let before = { version: 5, name: 'Orientation Before', width: 24, height: 20, cellSize: 2, maxStepHeight: .4,
  rows: ['############D###########', ...Array(18).fill('#......................#'), '########################'],
  elevations: Array.from({ length: 20 }, () => Array(24).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'entry', label: 'Entry', x: 12, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
let index = 0;
for (const row of [4, 8, 12, 16]) for (const x of [3, 7, 11, 15, 19]) {
  const bindingId = ['Console', 'ReversedConsole', 'Desk', 'Chair', 'Monitor', 'Crate'][index % 6];
  before = insertPropInstance(before, { x, row }, bindingId, settings, bindings);
  const prop = before.propInstances.at(-1); prop.id = `scattered-${index}`;
  // Manual insertion is intentional evidence of the old arbitrary layout, then released for rearrangement.
  before = rotatePropInstance(before, prop.id, index % 4 * 90, settings, bindings);
  const rotated = before.propInstances.find(item => item.id === prop.id); rotated.authored = false; rotated.provenance = 'generated'; index++;
}
before = parseProjectFile({ formatVersion: 1, map: before, settings, bindings }).map;
const result = rearrangeMapProps(before, settings, bindings, { props: true, decorations: false });
assert.equal(result.unchanged, false, JSON.stringify(result.issues));
assert.ok(result.groupCount > 0, JSON.stringify(result.issues));
const after = { ...result.map, name: 'Orientation After' };
assert.ok(after.propInstances.some(prop => prop.bindingId === 'Chair'), 'A native complete workstation is generated');
assert.ok(after.propInstances.some(prop => prop.bindingId === 'ReversedConsole'), 'A reversed native front is generated');
assert.equal(after.propInstances.some(prop => prop.bindingId === 'Monitor'), false, 'Unsupported tabletop monitors are omitted');
const equipmentDirections = new Set(after.propInstances.filter(prop => bindings.find(binding => binding.id === prop.bindingId).prop.behavior === 'floorEquipment').map(prop => prop.direction));
assert.ok([0, 90, 180, 270].every(direction => equipmentDirections.has(direction)), 'Native front checks exercise all four wall orientations');
const hasFreeRootYaw = prop => { const yaw = propRootYaw(prop, bindings.find(binding => binding.id === prop.bindingId)); return Math.abs(yaw / 90 - Math.round(yaw / 90)) > .0001; };
assert.ok(after.propInstances.some(hasFreeRootYaw), 'Generated native result contains free yaw');
const geography = map => ({ ...map, name: '', rows: map.rows.map(row => row.replaceAll('P', '.')), propInstances: [] });
assert.deepEqual(geography(after), geography(before), 'Rearrangement preserves the source geography');
for (const [phase, map] of [['before', before], ['after', after]]) {
  assert.deepEqual([...validateMap(map, bindings), ...propValidationIssues(map, bindings)].filter(issue => issue.severity === 'error'), []);
  const manifest = buildManifest(map, bindings);
  await writeFile(resolve(projectPath, `Assets/PropOrientationValidation/${phase}.baekhomap.json`), JSON.stringify(manifest));
  await writeFile(resolve(output, `${phase}.baekho.json`), JSON.stringify({ formatVersion: 1, map, settings, bindings }, null, 2));
  const props = map.propInstances.map(prop => {
    const binding = bindings.find(asset => asset.id === prop.bindingId), behavior = binding.prop.behavior;
    // Equipment must face the generator's independent logical use heading. Native markers
    // catch an omitted/inverted calibration instead of merely repeating the export formula.
    const front = (behavior === 'seat' ? propFrontYaw(prop, binding) : prop.direction) * Math.PI / 180;
    let partnerId = '';
    if (phase === 'after' && behavior === 'seat') {
      const position = propPosition(map, prop, binding);
      const partners = map.propInstances.filter(item => item.groupId === prop.groupId && bindings.find(asset => asset.id === item.bindingId).prop.behavior === 'workSurface');
      partners.sort((a, b) => {
        const distance = item => { const point = propPosition(map, item, bindings.find(asset => asset.id === item.bindingId)); return Math.hypot(point.x - position.x, point.z - position.z); };
        return distance(a) - distance(b);
      });
      assert.ok(partners.length, 'Every generated chair has a work surface in its actual group'); partnerId = partners[0].id;
    }
    return { id: prop.id, behavior, partnerId, size: prop.size, front: { x: Math.sin(front), y: 0, z: Math.cos(front) }, checkFront: phase === 'after' && ['workSurface', 'seat', 'floorEquipment'].includes(behavior) };
  });
  await writeFile(resolve(output, `${phase}-expected.json`), JSON.stringify({ props }, null, 2));
}
await runEditor('BaekhoPropOrientationSmoke.Run', 'render.log');
const unity = (await readFile(resolve(output, 'unity-result.txt'), 'utf8')).trim();
const evidence = { result: 'PASS', syntheticPrefabs: true, nativeGeometry: true, beforeCount: before.propInstances.length, afterCount: after.propInstances.length,
  workstations: after.propInstances.filter(prop => prop.bindingId === 'Chair').length,
  reversedFronts: after.propInstances.filter(prop => prop.bindingId === 'ReversedConsole').length,
  freeYawProps: after.propInstances.filter(hasFreeRootYaw).length,
  equipmentWallDirections: [...equipmentDirections].sort((a, b) => a - b), unsupportedMonitors: 0, unity, issues: result.issues,
  beforeImage: resolve(output, 'before-synthetic-eye.png'), afterImage: resolve(output, 'after-synthetic-eye.png'),
  workstationDetailImage: resolve(output, 'after-workstation-detail.png'), reversedConsoleDetailImage: resolve(output, 'after-reversed-console-detail.png') };
await writeFile(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
