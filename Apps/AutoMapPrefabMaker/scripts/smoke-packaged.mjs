import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const output = path.join(root, '.local', 'packaged-smoke');
await mkdir(output, { recursive: true });
const userData = path.join(output, `user-${Date.now()}`);
await mkdir(userData, { recursive: true });
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executablePath = path.join(root, 'release', 'win-unpacked', 'Baekho Map Forge.exe');
const portable = path.join(root, 'release', `Baekho-Map-Forge-${version}-Windows.exe`);
const importer = path.join('unity-importer', 'Editor', 'BaekhoMapImporter.cs');
const importerSource = await readFile(path.join(root, importer), 'utf8');
assert.match(importerSource, /navigationData = BakeNavigation\(root, surfaceType, agentTypeID\)/, 'Importer source must include automatic NavMesh baking.');
assert.match(importerSource, /AssetDatabase\.CreateAsset\(navigationData, navigationOutput\)/, 'Importer source must persist baked NavMesh data.');
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', importer), 'utf8'), importerSource);
const catalog = path.join('unity-importer', 'Editor', 'BaekhoPropCatalog.cs');
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', catalog), 'utf8'), await readFile(path.join(root, catalog), 'utf8'));
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', 'unity-importer', 'WALL_PREFABS.ko.md'), 'utf8'), await readFile(path.join(root, 'docs', 'wall-mounted-prefabs.md'), 'utf8'));
const connectionScript = path.join('unity-importer', 'Runtime', 'BaekhoMapConnection.cs');
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', connectionScript), 'utf8'), await readFile(path.join(root, connectionScript), 'utf8'));
for (const name of ['BaekhoGameplayMarker', 'BaekhoMapFixture','BaekhoWallModule']) {
  const source = path.join('unity-importer', 'Runtime', `${name}.cs`);
  assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', source), 'utf8'), await readFile(path.join(root, source), 'utf8'));
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENAI_API_KEY;
delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#preview canvas');
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), version, 'Packaged Electron version must match package.json.');
  assert.equal(await page.locator('header.topbar .pill').innerText(), `PREVIEW ${version}`, 'Packaged header must match package.json.');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.baekho?.exportBundle), 'function');
  assert.equal(await page.evaluate(() => typeof window.baekho?.saveProjects), 'function');
  assert.equal(await page.evaluate(() => typeof window.baekho?.generateConcept), 'function', 'Packaged preload exposes concept generation.');
  assert.equal(await page.locator('#conceptMode').inputValue(), 'ai', 'New packaged projects default to AI concept writing.');
  assert.equal(await page.locator('#prompt').count(), 0, 'Manual concept input is optional in AI mode.');
  await page.locator('#conceptMode').selectOption('manual');
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(await page.locator('#prompt').getAttribute('maxlength'), '6000');
  const manualConcept = '패키지 검증: 푸른 결정이 빛나는 지하 정원';
  await page.locator('#prompt').fill(manualConcept);
  await page.locator('#conceptMode').selectOption('ai');
  assert.equal(await page.locator('#prompt').count(), 0);
  assert.equal(await page.locator('#connectionWidth').inputValue(), '2', 'New connection width defaults to 2m.');
  assert.equal(await page.locator('#connectionHeight').inputValue(), '3', 'New connection height defaults to 3m.');
  await page.locator('#connectionWidth').fill('4.5');
  await page.locator('#connectionWidth').press('Tab');
  await page.locator('#connectionHeight').fill('3.75');
  await page.locator('#connectionHeight').press('Tab');
  await page.locator('[data-view="variants"]').click();
  assert.equal(await page.locator('.variant-gallery-empty').isVisible(), true);
  assert.equal(await page.locator('#variantCount option').count(), 7);
  await page.locator('[data-view="3d"]').click();
  await page.locator('#preview canvas').waitFor();
  assert.equal(await page.locator('#connectionWidth').inputValue(), '4.5', 'Edited width survives renderer updates.');
  assert.equal(await page.locator('#connectionHeight').inputValue(), '3.75', 'Edited height survives renderer updates.');
  await page.locator('#conceptMode').selectOption('manual');
  assert.equal(await page.locator('#prompt').inputValue(), manualConcept, 'Manual concept survives AI mode and renderer updates.');
  await page.locator('#conceptMode').selectOption('ai');
  assert.equal(await page.evaluate(() => typeof window.baekho?.setApiKey), 'undefined');
  const codexStatus = await page.evaluate(() => window.baekho.getCodexStatus());
  assert.equal(codexStatus.state, 'ready', `Codex connection must succeed: ${codexStatus.message}`);
  await page.locator('button[data-action="codex"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="codex-refresh"]')?.disabled, undefined, { timeout: 60000 });
  assert.equal(await page.locator('#codex-dialog').evaluate(dialog => dialog.open), true);
  assert.match(await page.locator('#codex-dialog').innerText(), /ChatGPT/);
  const connection = await page.locator('#codex-status').innerText();
  await page.screenshot({ path: path.join(output, 'codex-connection.png') });
  await page.locator('[data-action="close-codex"]').click();
  await page.screenshot({ path: path.join(output, 'packaged-workspace.png') });
  assert.deepEqual(errors, []);
  const report = {
    result: 'PASS', version, isPackaged: true, executablePath,
    portablePath: portable, portableBytes: (await stat(portable)).size,
    importerMatchesSource: true, rendererErrors: errors, connection, codexState: codexStatus.state,
    verified: ['Packaged renderer boot', 'Version matches package.json', '3D canvas', 'Sandboxed preload', 'AI concept default and real preload bridge', 'Optional manual concept with preserved text across mode switches and renderer updates', 'Connection size defaults and edits', 'Latest importer with persisted baked NavMesh', 'Codex status IPC', 'Connection dialog', 'No inference requests'],
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
  await app.close();
}
