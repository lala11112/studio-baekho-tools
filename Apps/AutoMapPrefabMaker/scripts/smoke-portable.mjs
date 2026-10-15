import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

// Test the outer portable launcher, including its real temporary extraction path.
// No login, inference, project editing, or existing application process is touched.
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32') throw new Error('Portable EXE smoke testing requires Windows.');
if (process.argv.length > 3) throw new Error('Usage: node scripts/smoke-portable.mjs [path-to-portable.exe]');
const executable = path.resolve(root, process.argv[2] || `release/Baekho-Map-Forge-${metadata.version}-Windows.exe`);
if (!(await stat(executable)).isFile() || path.extname(executable).toLowerCase() !== '.exe') {
  throw new Error('Select a built Windows portable EXE.');
}
const output = path.join(root, '.local', 'portable-smoke', `${path.basename(executable, '.exe')}-${Date.now()}`);
await mkdir(output, { recursive: true });
// NSIS uses a fixed extraction subdirectory for each build. Isolate TEMP so an
// already-open copy cannot be disturbed. Spaces and ~ also exercise file URLs.
const temporaryRoot = await realpath(path.dirname(output));
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'portable~temp-'));

// Start with ordinary desktop environment variables, without Codex agent routing,
// API credentials, development overrides, or injected Node startup options.
const desktopKeys = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|OS|USERNAME|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|COMPUTERNAME|SESSIONNAME|NUMBER_OF_PROCESSORS|PROCESSOR_.+|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|ALLUSERSPROFILE|PROGRAMDATA|PUBLIC|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => desktopKeys.test(key)));
for (const key of Object.keys(environment)) if (/^(?:TEMP|TMP)$/i.test(key)) delete environment[key];
environment.TEMP = temporaryDirectory;
environment.TMP = temporaryDirectory;
const windowsDirectory = environment.SystemRoot || environment.SYSTEMROOT || environment.windir || environment.WINDIR;
if (!windowsDirectory) throw new Error('SystemRoot is required to verify ownership of portable child processes.');
const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = path.join(windowsDirectory, 'System32', 'taskkill.exe');
// NSIS portable's ExecWait requires its extraction parent in Windows short-path
// form. This still exercises ~ URL escaping, while isolation uses the same folder.
const { stdout: shortTemporaryPath } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
  '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TEMP).ShortPath'],
{ windowsHide: true, timeout: 10000, env: environment });
environment.TEMP = shortTemporaryPath.trim();
environment.TMP = environment.TEMP;

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function processSnapshot() {
  // Never read process command lines: they may contain unrelated account data.
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, env: environment });
  const values = JSON.parse(stdout);
  return new Map((Array.isArray(values) ? values : [values]).map(value => [Number(value.ProcessId), value]));
}

function isDescendant(snapshot, processId, ancestorId) {
  const visited = new Set();
  while (processId > 0 && !visited.has(processId)) {
    if (processId === ancestorId) return true;
    visited.add(processId);
    processId = Number(snapshot.get(processId)?.ParentProcessId ?? 0);
  }
  return false;
}

const port = await reservePort();
const endpoint = `http://127.0.0.1:${port}`;
const launcher = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: 'ignore',
});
let launcherExited = false;
let launchError;
let launcherExit;
const exited = new Promise(resolve => {
  launcher.once('error', error => { launchError = error; launcherExited = true; resolve(); });
  launcher.once('exit', (code, signal) => { launcherExit = { code, signal }; launcherExited = true; resolve(); });
});
let browser;
let page;
let ownedBrowser;
let failure;
const report = { executable, screenshot: path.join(output, 'portable-codex.png'), temporaryDirectory, launcherPid: launcher.pid };
console.log(`Starting actual portable launcher: ${path.basename(executable)}`);

try {
  const deadline = Date.now() + 90000;
  let endpointReady = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (launcherExited) throw new Error(`Portable launcher exited before CDP became available (code ${launcherExit?.code}).`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && typeof (await response.json()).webSocketDebuggerUrl === 'string') { endpointReady = true; break; }
    } catch { /* Portable extraction and Chromium startup take a few seconds. */ }
    await delay(400);
  }
  assert.ok(endpointReady, 'Portable launcher did not expose its private loopback CDP endpoint within 90 seconds.');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const session = await browser.newBrowserCDPSession();
  const information = await session.send('SystemInfo.getProcessInfo');
  const browserPid = Number(information.processInfo.find(process => process.type === 'browser')?.id);
  const snapshot = await processSnapshot();
  assert.ok(Number.isInteger(browserPid) && isDescendant(snapshot, browserPid, launcher.pid),
    'CDP browser must belong to this portable launcher before the test may operate or close it.');
  ownedBrowser = snapshot.get(browserPid);
  report.browserPid = browserPid;
  await session.detach();
  console.log('Portable browser ownership verified; checking the real preload IPC bridge.');
  const pageDeadline = Date.now() + 30000;
  while (!page && Date.now() < pageDeadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('file:'));
    if (!page) await delay(200);
  }
  assert.ok(page, 'Portable app did not open its local application page.');
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForSelector('#preview canvas', { timeout: 30000 });
  await page.waitForFunction(() => typeof window.baekho?.getCodexStatus === 'function', undefined, { timeout: 15000 });
  assert.equal(await page.evaluate(() => typeof window.baekho?.saveProjects), 'function');
  await page.locator('[data-view="variants"]').click();
  assert.equal(await page.locator('.variant-gallery-empty').isVisible(), true);
  await page.locator('[data-view="3d"]').click();
  await page.locator('#preview canvas').waitFor();
  report.pageUrl = page.url();
  report.previewVersion = await page.locator('header.topbar .pill').innerText();
  const status = await page.evaluate(async () => {
    const result = await window.baekho.getCodexStatus();
    return { state: result.state, message: result.message, version: result.version, modelCount: result.models.length };
  });
  report.codex = status;
  await page.locator('[data-action="codex"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="codex-refresh"]')?.disabled, undefined, { timeout: 60000 });
  await page.screenshot({ path: report.screenshot });
  assert.equal(status.state, 'ready', `Portable Codex status should be ready: ${status.message}`);
  const expectedVersion = path.basename(executable).match(/^Baekho-Map-Forge-(.+)-Windows\.exe$/)?.[1] || metadata.version;
  assert.equal(report.previewVersion, `PREVIEW ${expectedVersion}`, 'Portable header must display the tested package version.');
  assert.deepEqual(rendererErrors, [], 'Portable renderer must not raise page errors.');
  report.result = 'PASS';
  console.log(`PASS portable EXE: real IPC accepted, Codex ready, ${status.modelCount} models. No login or inference performed.`);
} catch (error) {
  failure = error;
  report.result = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
  if (page && ownedBrowser) await page.screenshot({ path: report.screenshot }).catch(() => undefined);
} finally {
  // First close only the verified app window; this run never edits a project.
  if (page && ownedBrowser && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => undefined);
  await Promise.race([exited, delay(15000)]);
  if (!launcherExited || ownedBrowser) {
    try {
      const snapshot = await processSnapshot();
      const launcherStillOwned = !launcherExited && snapshot.has(launcher.pid);
      const currentBrowser = ownedBrowser && snapshot.get(Number(ownedBrowser.ProcessId));
      const browserStillOwned = currentBrowser && currentBrowser.CreationDate === ownedBrowser.CreationDate;
      // A recorded creation time prevents killing a recycled PID after the launcher exits.
      const killPid = launcherStillOwned ? launcher.pid : browserStillOwned ? Number(ownedBrowser.ProcessId) : null;
      if (killPid !== null) {
        report.forcedCleanup = true;
        await execute(taskkill, ['/PID', String(killPid), '/T', '/F'], { windowsHide: true, timeout: 10000, env: environment });
        await Promise.race([exited, delay(5000)]);
      }
    } catch (error) {
      report.result = 'FAIL';
      report.cleanupError = error instanceof Error ? error.message : String(error);
      if (!failure) failure = new Error('Could not confirm cleanup of the owned portable process.');
    }
  }
  // Only a verified owned CDP connection may receive Browser.close during disconnect.
  if (browser && ownedBrowser) await browser.close().catch(() => undefined);
  try {
    const remaining = await processSnapshot();
    const currentBrowser = ownedBrowser && remaining.get(Number(ownedBrowser.ProcessId));
    assert.ok(launcherExited && (!currentBrowser || currentBrowser.CreationDate !== ownedBrowser.CreationDate),
      'Owned portable processes must stop before their extraction directory is removed.');
    const resolvedTemporaryDirectory = await realpath(temporaryDirectory);
    const relativeTemporaryDirectory = path.relative(temporaryRoot, resolvedTemporaryDirectory);
    assert.ok(relativeTemporaryDirectory && !relativeTemporaryDirectory.startsWith('..') && !path.isAbsolute(relativeTemporaryDirectory)
      && path.dirname(resolvedTemporaryDirectory) === temporaryRoot && path.basename(resolvedTemporaryDirectory).startsWith('portable~temp-'),
    'Temporary extraction directory must remain inside the smoke-test workspace.');
    await rm(resolvedTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    report.temporaryDirectoryRemoved = true;
  } catch (error) {
    report.result = 'FAIL';
    report.cleanupError = error instanceof Error ? error.message : String(error);
    if (!failure) failure = new Error('Could not confirm cleanup of the owned portable extraction directory.');
  }
  report.launcherExit = launcherExit;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`Portable smoke report: ${path.relative(root, path.join(output, 'result.json'))}`);
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exitCode = 1;
}
