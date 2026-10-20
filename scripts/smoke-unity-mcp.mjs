// Actual Unity MCP adapter checks, entirely inside ignored .local/unity-validation.
// Uses UNITY_MCP_PACKAGE when set; otherwise resolves the installed sibling-project
// package cache, with the official MCP 9.7.1 package as the portable fallback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
const project = resolve(local, 'unity-validation');
const versionText = await readFile(resolve(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').catch(() => '');
assert.ok(versionText, 'Run npm run test:unity:navmesh first to create the validation project and install AI Navigation.');
const version = /^m_EditorVersion: (.+)$/m.exec(versionText)?.[1].trim();
const editor = process.env.UNITY_EDITOR ?? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
await access(editor);
let mcpPackage = process.env.UNITY_MCP_PACKAGE;
if (!mcpPackage) {
  const cache = resolve(root, '../Four-Tiger-Sword/Four-Tiger-Sword/Library/PackageCache');
  const installed = (await readdir(cache).catch(() => [])).find(name => name.startsWith('com.coplaydev.unity-mcp@'));
  if (installed) mcpPackage = resolve(cache, installed);
}
if (mcpPackage) {
  const info = JSON.parse(await readFile(resolve(mcpPackage, 'package.json'), 'utf8'));
  assert.equal(info.name, 'com.coplaydev.unity-mcp', 'UNITY_MCP_PACKAGE must point to the Unity MCP package');
}
const manifestFile = resolve(project, 'Packages/manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
assert.ok(manifest.dependencies['com.unity.ai.navigation'], 'AI Navigation must be installed in the validation project.');
manifest.dependencies['com.coplaydev.unity-mcp'] = mcpPackage
  ? `file:${resolve(mcpPackage).replaceAll('\\', '/')}`
  : 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#78ee5418415953b79c358bfe6355fcc3fde7912b';
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
await mkdir(resolve(project, 'Assets/Editor'), { recursive: true });
await mkdir(resolve(project, 'Assets/Baekho/Runtime'), { recursive: true });
for (const [source, destination] of [
  ['unity-importer/Editor/BaekhoMapImporter.cs', 'Assets/Editor/BaekhoMapImporter.cs'],
  ['unity-importer/Mcp/BaekhoBuildMapTool.cs', 'Assets/Editor/BaekhoBuildMapTool.cs'],
  ['tests/unity/BaekhoMcpSmoke.cs', 'Assets/Editor/BaekhoMcpSmoke.cs'],
  ...['BaekhoMapConnection', 'BaekhoGameplayMarker', 'BaekhoMapFixture', 'BaekhoWallModule'].map(name =>
    [`unity-importer/Runtime/${name}.cs`, `Assets/Baekho/Runtime/${name}.cs`]),
]) await copyFile(resolve(root, source), resolve(project, destination));

async function run(method, suffix, marker) {
  const log = resolve(local, `unity-mcp-${suffix}.log`);
  console.log(`Unity MCP validation: ${suffix}`);
  await new Promise((done, fail) => {
    const child = spawn(editor, ['-batchmode', '-nographics', '-projectPath', project,
      '-executeMethod', `BaekhoMcpSmoke.${method}`, '-quit', '-logFile', log],
    { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); fail(new Error(`Unity MCP validation timed out; see ${log}`)); }, 480000);
    child.once('error', error => { clearTimeout(timeout); fail(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? done() : fail(new Error(`Unity MCP validation exited ${code}; see ${log}`));
    });
  });
  assert.match(await readFile(log, 'utf8'), marker);
}

await run('Run', 'build', /BAEKHO_MCP_PASS/);
await run('RunReload', 'reload', /BAEKHO_MCP_RELOAD_PASS/);
console.log(await readFile(resolve(local, 'unity-mcp-result.json'), 'utf8'));
