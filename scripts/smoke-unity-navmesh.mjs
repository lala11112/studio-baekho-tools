// Native Unity integration: package absence, bake/persist, then a cold reload and path query.
// Only the ignored .local/unity-validation project is modified.
// Run: node scripts/smoke-unity-navmesh.mjs (optional UNITY_EDITOR absolute executable).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
const projectPath = resolve(local, 'unity-validation');
const versionFile = resolve(projectPath, 'ProjectSettings/ProjectVersion.txt');
const versionText = await readFile(versionFile, 'utf8').catch(() => '');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim() ?? '6000.3.10f1';
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor).catch(() => { throw new Error('Set UNITY_EDITOR to an installed Unity Editor executable.'); });
await mkdir(local, { recursive: true });

async function runEditor(method, suffix, marker, { create = false, selfExit = false } = {}) {
  const log = resolve(local, `unity-navmesh-${suffix}.log`);
  const args = ['-batchmode', '-nographics', create ? '-createProject' : '-projectPath', projectPath,
    ...(method ? ['-executeMethod', method] : []), ...(!selfExit ? ['-quit'] : []), '-logFile', log];
  console.log(`Unity navigation check: ${suffix}`);
  await new Promise((done, fail) => {
    const child = spawn(editor, args, { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity timed out; see ${log}`)); }, 360000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) done();
      else fail(new Error(`Unity exited ${code}; see ${log}`));
    });
  });
  if (marker) assert.match(await readFile(log, 'utf8'), marker);
}

if (!versionText) await runEditor(null, 'create', null, { create: true });
await mkdir(resolve(projectPath, 'Assets/Editor'), { recursive: true });
await mkdir(resolve(projectPath, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ['unity-importer/Editor/BaekhoMapImporter.cs', 'Assets/Editor/BaekhoMapImporter.cs'],
  ['tests/unity/BaekhoNavMeshSmoke.cs', 'Assets/Editor/BaekhoNavMeshSmoke.cs'],
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture'].map(name =>
    [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
]) await copyFile(resolve(root, source), resolve(projectPath, destination));

const manifest = JSON.parse(await readFile(resolve(projectPath, 'Packages/manifest.json'), 'utf8'));
if (!manifest.dependencies['com.unity.ai.navigation']) {
  await runEditor('BaekhoNavMeshSmoke.RunMissingPackage', 'missing-package', /BAEKHO_NAVMESH_MISSING_PASS/);
  // The Package Manager chooses a compatible published version. Its async update pump owns exit.
  await runEditor('BaekhoNavMeshSmoke.InstallNavigation', 'install', /BAEKHO_NAVMESH_PACKAGE_PASS/, { selfExit: true });
}
await runEditor('BaekhoNavMeshSmoke.Run', 'bake', /BAEKHO_NAVMESH_PASS/);
await runEditor('BaekhoNavMeshSmoke.RunReload', 'reload', /BAEKHO_NAVMESH_RELOAD_PASS/);
console.log(await readFile(resolve(local, 'unity-navmesh-result.txt'), 'utf8'));
