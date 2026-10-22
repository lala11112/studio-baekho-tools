// Actual Unity catalog/component/Inspector regression in the repository's ignored test project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(root, '.local/unity-validation');
const versionText = await readFile(resolve(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').catch(() => '');
assert.ok(versionText, 'Run npm run test:unity:navmesh to prepare .local/unity-validation first.');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim();
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor);
const manifest = JSON.parse(await readFile(resolve(project, 'Packages/manifest.json'), 'utf8'));
assert.ok(manifest.dependencies['com.coplaydev.unity-mcp'], 'Run npm run test:unity:mcp once to prepare the MCP adapter test dependency.');
for (const [source, destination] of [
  ...['BaekhoPropCatalog', 'BaekhoMapAssetEditor', 'BaekhoAssetCatalog'].map(name =>
    [`unity-importer/Editor/${name}.cs`, `Assets/Editor/${name}.cs`]),
  ...['BaekhoWallModule', 'BaekhoMapAsset'].map(name =>
    [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
  ['unity-importer/Mcp/BaekhoGetAssetCatalogTool.cs', 'Assets/Editor/BaekhoGetAssetCatalogTool.cs'],
  ['tests/unity/BaekhoAssetCatalogSmoke.cs', 'Assets/Editor/BaekhoAssetCatalogSmoke.cs'],
]) {
  await mkdir(dirname(resolve(project, destination)), { recursive: true });
  await copyFile(resolve(root, source), resolve(project, destination));
}
const log = resolve(root, '.local/unity-asset-catalog.log');
await new Promise((done, fail) => {
  const child = spawn(editor, ['-batchmode', '-nographics', '-projectPath', project,
    '-executeMethod', 'BaekhoAssetCatalogSmoke.Run', '-quit', '-logFile', log],
  { cwd: root, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill(); fail(new Error(`Unity catalog test timed out; see ${log}`)); }, 480000);
  child.once('error', error => { clearTimeout(timer); fail(error); });
  child.once('exit', code => {
    clearTimeout(timer);
    code === 0 ? done() : fail(new Error(`Unity catalog test exited ${code}; see ${log}`));
  });
});
assert.match(await readFile(log, 'utf8'), /BAEKHO_ASSET_CATALOG_PASS/);
const { parseUnityAssetCatalog, importUnityAssetCatalogBindings } = await tsImport('../src/shared/unity-asset-catalog.ts', import.meta.url);
const { scanUnityProject } = await tsImport('../electron/services/unity-project.ts', import.meta.url);
const catalog = parseUnityAssetCatalog(JSON.parse(await readFile(resolve(root, '.local/unity-asset-catalog.json'), 'utf8')));
const scan = await scanUnityProject(project);
const result = importUnityAssetCatalogBindings([], catalog, scan.assets, 2);
assert.equal(result.added, catalog.assets.length);
assert.equal(result.unmatched, 0);
assert.equal(importUnityAssetCatalogBindings(result.bindings, catalog, scan.assets, 2).added, 0);
console.log(await readFile(resolve(root, '.local/unity-asset-catalog-result.json'), 'utf8'));
console.log(`Unity → TypeScript catalog contract: ${result.added} prefabs, repeat import adds 0.`);
