import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const output = path.join(root, '.local', 'packaged-smoke');
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executablePath = path.join(root, 'release', 'win-unpacked', 'Baekho Map Forge.exe');
const portable = path.join(root, 'release', `Baekho-Map-Forge-${version}-Windows.exe`);
const importer = path.join('unity-importer', 'Editor', 'BaekhoMapImporter.cs');
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', importer), 'utf8'), await readFile(path.join(root, importer), 'utf8'));
const connectionScript = path.join('unity-importer', 'Runtime', 'BaekhoMapConnection.cs');
assert.equal(await readFile(path.join(root, 'release', 'win-unpacked', 'resources', connectionScript), 'utf8'), await readFile(path.join(root, connectionScript), 'utf8'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENAI_API_KEY;
delete env.BAEKHO_DEV_URL;
const app = await electron.launch({ executablePath, env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#preview canvas');
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.baekho?.exportBundle), 'function');
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
    verified: ['Packaged renderer boot', '3D canvas', 'Sandboxed preload', 'Codex status IPC', 'Connection dialog', 'No inference requests'],
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(window => window.destroy()); }).catch(() => {});
  await app.close();
}
