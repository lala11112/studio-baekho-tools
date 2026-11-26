// Focused native compatibility proof: original bake versus guarded bake, isolated validation project only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), project = resolve(root, '.local/unity-validation');
const output = resolve(root, '.local/grouped-unity-validation');
const version = /^m_EditorVersion: (.+)$/m.exec(await readFile(resolve(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1].trim();
assert.ok(version, 'Use the existing isolated project; never create or install a user project');
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
const source = await readFile(resolve(root, 'unity-importer/Editor/BaekhoMapImporter.cs'), 'utf8'), destination = resolve(project, 'Assets/Editor/BaekhoMapImporter.cs');
await copyFile(resolve(root, 'tests/unity/BaekhoGroupedSmoke.cs'), resolve(project, 'Assets/GroupedValidation/Editor/BaekhoGroupedSmoke.cs'));
const baseline = source.split('\n').filter(line => !['float voxelSize = Math.Max(.001f, NavMesh.GetSettingsByID', 'SetNavigationProperty(surface, "overrideVoxelSize", true)', 'SetNavigationProperty(surface, "voxelSize", voxelSize)', 'AddNavigationPropGuards(root, voxelSize, agentTypeID)'].some(fragment => line.includes(fragment))).join('\n');
assert.notEqual(baseline, source, 'Baseline removes only the new voxel and footprint-guard bake calls');
async function run(phase) {
  const log = resolve(output, `low-step-${phase}.log`), method = phase === 'baseline' ? 'RunLowStepBaseline' : 'RunLowStepGuarded';
  await new Promise((done, fail) => {
    const child = spawn(editor, ['-batchmode', '-nographics', '-projectPath', project, '-executeMethod', `BaekhoGroupedSmoke.${method}`, '-quit', '-logFile', log], { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Focused native step check timed out: ${log}`)); }, 180000);
    child.once('error', error => { clearTimeout(timeout); fail(error); }); child.once('exit', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(`Focused ${phase} step check exited ${code}: ${log}`)); });
  });
  assert.match(await readFile(log, 'utf8'), /BAEKHO_LOW_STEP_PASS/);
  const result = JSON.parse(await readFile(resolve(output, `low-step-${phase}.json`), 'utf8'));
  assert.equal(result.lowCrossed, true); assert.equal(result.tallBlocked, true); assert.ok(result.stepHeight < result.climb);
  console.log(`PASS ${phase}: ${result.stepHeight}m native step crosses, taller body blocks; agent radius ${result.agentRadius}m, climb ${result.climb}m`);
  return result;
}
try {
  await writeFile(destination, baseline); const original = await run('baseline');
  await writeFile(destination, source);
  if (!process.argv.includes('--baseline-only')) {
    const guarded = await run('guarded'); assert.equal(guarded.agentRadius, original.agentRadius); assert.equal(guarded.climb, original.climb);
    assert.equal(guarded.lowGuards, 0); assert.equal(guarded.tallGuards, 1);
  }
} finally { await writeFile(destination, source); }
