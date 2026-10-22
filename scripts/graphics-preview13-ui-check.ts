/** Actual application UI only: private copies of the adopted rabbit, no production commands.
 * Run after the final build: npx tsx scripts/graphics-preview13-ui-check.ts [--source-build]
 * Or select a packaged exe: --executable "C:/.../Partsmith.exe".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import electronBinary from 'electron';
import { Store } from '../engine/store';
import type { AppState, Project } from '../shared/types';
import type { GraphicsWorkspace } from '../shared/graphics';

const repo = process.cwd(), version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const sourceBuild = process.argv.includes('--source-build'), exeIndex = process.argv.indexOf('--executable');
const fontOnly = process.argv.includes('--font-only');
const executable = sourceBuild ? electronBinary as unknown as string : exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : path.join(repo, `release/${version}/win-unpacked/Partsmith.exe`);
assert(fs.existsSync(executable), `Build the application first: ${executable}`);
assert(!(sourceBuild && exeIndex >= 0), 'Use either --source-build or --executable.');
const projectId = 'ff70e6a6-b1cc-4dea-9a92-f9e092114578', objectId = '99583b40-8d0a-413d-a3c7-4f68351b6a6c';
const productionProfile = path.join(process.env.APPDATA!, 'partsmith'), productionRoot = path.join(productionProfile, 'projects', projectId);
const runtime = path.join(repo, 'artifacts/runtime'), screenshots = path.join(runtime, 'graphics-preview13-ui');
fs.mkdirSync(screenshots, { recursive: true });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (file: string) => sha(fs.readFileSync(file));
const within = (root: string, relative: string) => {
  const absolute = path.resolve(root, relative), rel = path.relative(root, absolute);
  assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), `Outside project: ${relative}`);
  assert(!fs.lstatSync(absolute).isSymbolicLink() && fs.statSync(absolute).isFile(), `Not a regular file: ${relative}`);
  const real = fs.realpathSync(absolute), realRelative = path.relative(fs.realpathSync(root), real);
  assert(realRelative !== '..' && !realRelative.startsWith('..' + path.sep) && !path.isAbsolute(realRelative), `Linked file outside project: ${relative}`);
  return absolute;
};

// Read the production DB into memory. Do not open it through Store, whose startup can recover records.
const SQL = await initSqlJs({ locateFile: () => path.join(repo, 'node_modules/sql.js/dist/sql-wasm.wasm') });
const sourceDb = new SQL.Database(fs.readFileSync(path.join(productionProfile, 'workbench.db')));
function sourceRecord<T>(kind: string): T {
  const statement = sourceDb.prepare('SELECT json FROM records WHERE kind=? AND id=?');
  try { statement.bind([kind, projectId]); assert(statement.step(), `Missing source ${kind}`); return JSON.parse(statement.getAsObject().json as string); }
  finally { statement.free(); }
}
const originalWorkspace = sourceRecord<GraphicsWorkspace>('graphics'), originalProject = sourceRecord<Project>('project');
sourceDb.close();
assert(originalWorkspace.objects.some(object => object.id === objectId), 'Current rabbit is absent; do not restore an older project.');
assert(!originalWorkspace.tasks.some(task => task.status === 'running'), 'Production is active; do not snapshot/restart it.');
assert(!originalProject.jobs.some(job => ['queued', 'submitting', 'running'].includes(job.status)), 'API job is active; stop this UI check.');
const metadata = ['project.json', 'graphics/workspace.json'].map(relative => {
  const file = within(productionRoot, relative); return { relative, file, bytes: fs.readFileSync(file) };
});
assert.deepEqual(JSON.parse(metadata[1].bytes.toString()), originalWorkspace, 'Workspace file and DB differ; wait for an idle snapshot.');
assert.deepEqual(JSON.parse(metadata[0].bytes.toString()), originalProject, 'Project file and DB differ; wait for an idle snapshot.');
const references = new Map<string, string>();
for (const version of originalWorkspace.versions) for (const file of version.files) {
  const prior = references.get(file.path); assert(!prior || prior === file.sha256, 'Conflicting source hash.'); references.set(file.path, file.sha256);
}
for (const asset of originalProject.assets) for (const relative of [asset.file, asset.nativeFile].filter((value): value is string => !!value))
  if (!references.has(relative)) references.set(relative, fileSha(within(productionRoot, relative)));
const originalFiles = [...references].map(([relative, expectedSha]) => {
  const file = within(productionRoot, relative), actualSha = fileSha(file); assert.equal(actualSha, expectedSha, `Original changed: ${relative}`);
  return { relative, file, sha256: actualSha, bytes: fs.statSync(file).size };
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-preview13-ui-')), privateRoot = path.join(profile, 'projects', projectId);
fs.mkdirSync(privateRoot, { recursive: true });
for (const file of originalFiles) {
  const dest = path.join(privateRoot, file.relative); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file.file, dest, fs.constants.COPYFILE_EXCL); assert.equal(fileSha(dest), file.sha256);
}
for (const file of metadata) { const dest = path.join(privateRoot, file.relative); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, file.bytes, { flag: 'wx' }); }
const store = new Store(profile); await store.open(path.join(repo, 'node_modules/sql.js/dist/sql-wasm.wasm'));
store.put('project', projectId, originalProject); store.put('graphics', projectId, originalWorkspace);
// No credential/configuration records copied; this affects only the newly created private profile.
store.settings = { ...store.settings, unityPath: '' }; store.db.close();

type Combo = { width: number; height: number; zoom: number };
const combinations: Combo[] = [
  { width: 1920, height: 1080, zoom: 1 }, { width: 1280, height: 900, zoom: 1 },
  { width: 960, height: 900, zoom: 1.25 }, { width: 800, height: 900, zoom: 1.5 },
  { width: 1280, height: 900, zoom: 1.5 },
];
const stages = ['1 이미지', '2 모델', '3 재질', '4 조립·수정', '5 리깅', '6 애니메이션', '7 Unity 전달'];
const errors: string[] = [], violations: { screen: string; combo: Combo; message: string; details?: unknown }[] = [], checks: unknown[] = [];
let app: ElectronApplication | undefined, page: Page | undefined, productionPreserved = false, privatePreserved = false, sourceFilesPreserved = false, commandAudit: unknown, originalMinimumSize: number[] | undefined;
const reportFile = path.join(runtime, fontOnly ? 'graphics-preview13-fonts.json' : 'graphics-preview13-ui.json');
const fontDiagnostics: unknown[] = [];
let activeScreen = 'launch', activeCombo = combinations[0];
const finding = (condition: boolean, message: string, details?: unknown) => { if (!condition) violations.push({ screen: activeScreen, combo: activeCombo, message, details }); };
async function settle() { await page!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function screenshot(file: string) {
  // Playwright's CDP screenshot clips incorrectly after Electron zoom changes on Windows DPI.
  // Capture the actual full webContents surface, without cropping/resizing image pixels.
  const bytes = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(file, Buffer.from(bytes, 'base64'));
}
async function resize(combo: Combo) {
  activeCombo = combo;
  const content = await app!.evaluate(({ BrowserWindow }, value) => {
    const win = BrowserWindow.getAllWindows().find(window => window.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    win.setSize(value.width, value.height); win.webContents.setZoomFactor(value.zoom);
    const actual = win.getSize(); if (Math.abs(actual[0] - value.width) > 1 || Math.abs(actual[1] - value.height) > 1) throw Error(`Actual window size ${actual} differs from requested ${value.width},${value.height}`);
    return win.getContentSize();
  }, combo);
  await page!.waitForFunction(({ content, zoom }) => Math.abs(innerWidth - content[0] / zoom) <= 2 && Math.abs(innerHeight - content[1] / zoom) <= 2, { content, zoom: combo.zoom });
  await settle();
}
async function scrollTop() {
  await page!.evaluate(() => { document.scrollingElement?.scrollTo(0, 0); for (const node of document.querySelectorAll<HTMLElement>('.app-body,.page,.gs-workspace,.gs-main,.gs-options,.gs-results')) node.scrollTop = 0; });
  await settle();
}
async function controlBounds(locator: Locator) {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { text: (el.textContent ?? '').trim().slice(0, 140), x: r.x, y: r.y, width: r.width, height: r.height, fontSize: parseFloat(style.fontSize),
      visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden', reachable: !!hit && (hit === el || el.contains(hit)),
      viewport: { width: innerWidth, height: innerHeight }, scroll: { width: el.scrollWidth, height: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight } };
  });
}
async function capture(screen: string, primary?: Locator, modal = false) {
  activeScreen = screen;
  await scrollTop();
  const layout = await page!.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('details:not([open]) > :not(summary)'); };
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const clipped = (el: Element) => {
      const bounds = el.getBoundingClientRect(); let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.body) {
        const s = getComputedStyle(ancestor), a = ancestor.getBoundingClientRect();
        if (['hidden', 'clip'].includes(s.overflowX) && (bounds.left < a.left - 2 || bounds.right > a.right + 2)) return true;
        ancestor = ancestor.parentElement;
      } return false;
    };
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, documentWidth: document.documentElement.scrollWidth,
      headers: [...document.querySelectorAll('.topbar,.page-heading,.gs-header')].filter(visible).map(el => ({ ...rect(el), text: el.textContent?.trim().slice(0, 100), clipped: clipped(el) })),
      panels: [...document.querySelectorAll('.app,.app-body,.page,.gs-workspace,.gs-main,.gs-current-options,.gs-creation-options,.gs-execution-card,.gs-new-object-dialog')].filter(visible).map(el => ({ class: el.className, ...rect(el), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })),
      controls: [...document.querySelectorAll('button,input,select,textarea')].filter(visible).map(el => ({ tag: el.tagName, type: el.getAttribute('type'), label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 80), ...rect(el), fontSize: parseFloat(getComputedStyle(el).fontSize), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })),
      text: [...document.querySelectorAll('.page-heading p,.settings-page label,.gs-creation-options > p,.gs-execution-summary,.gs-creation-execute strong')].filter(visible).map(el => ({ class: el.className, size: parseFloat(getComputedStyle(el).fontSize), text: el.textContent?.trim().slice(0, 100) })),
      dialog: (() => { const el = document.querySelector('dialog[open]'); if (!el) return undefined; const footer = el.querySelector('footer'); return { ...rect(el), footer: footer ? rect(footer) : undefined }; })(),
    };
  });
  finding(layout.documentWidth <= layout.viewport.width + 2, 'Document horizontal overflow', layout);
  for (const panel of layout.panels) finding(panel.scrollWidth <= panel.clientWidth + 2, `Panel horizontal overflow: ${panel.class}`, panel);
  for (const header of layout.headers) finding(!header.clipped && header.x >= -2 && header.x + header.width <= layout.viewport.width + 2, 'Header clipped horizontally', header);
  const topbar = layout.headers[0]; if (topbar) finding(topbar.y >= -2 && topbar.y + topbar.height <= layout.viewport.height + 2, 'Global header outside viewport', topbar);
  for (const text of layout.text) finding(text.size >= 12, 'Body text below 12px', text);
  for (const control of layout.controls) {
    if (control.type === 'checkbox' || control.type === 'radio' || control.type === 'range' || control.tag === 'BUTTON') continue;
    finding(control.height >= 30 && control.fontSize >= 13, 'Input/select below 30px height or 13px text', control);
  }
  let primaryBounds;
  if (primary) {
    await primary.waitFor({ state: 'visible' }); await primary.scrollIntoViewIfNeeded(); await settle(); primaryBounds = await controlBounds(primary);
    finding(primaryBounds.reachable && primaryBounds.x >= -2 && primaryBounds.x + primaryBounds.width <= primaryBounds.viewport.width + 2 && primaryBounds.y >= -2 && primaryBounds.y + primaryBounds.height <= primaryBounds.viewport.height + 2, 'Primary button cannot be reached after scrolling', primaryBounds);
    finding(primaryBounds.height >= 32 && primaryBounds.fontSize >= 13 && primaryBounds.scroll.height <= primaryBounds.scroll.clientHeight + 2, 'Primary button size/text is clipped', primaryBounds);
  }
  if (modal) {
    const d = layout.dialog, f = d?.footer;
    finding(!!d && d.x >= -2 && d.y >= -2 && d.x + d.width <= layout.viewport.width + 2 && d.y + d.height <= layout.viewport.height + 2, 'Modal outside viewport', d);
    finding(!!f && f.y >= 0 && f.y + f.height <= layout.viewport.height + 2, 'Modal footer not persistently visible', f);
  }
  const suffix = `${activeCombo.width}-z${activeCombo.zoom}`.replace('.', '_'), imagePath = path.join(screenshots, `${screen}-${suffix}.png`);
  await screenshot(imagePath); checks.push({ screen, combo: activeCombo, layout, primary: primaryBounds, screenshot: imagePath });
}

try {
  const env = { ...process.env, PARTSMITH_DATA: profile, PARTSMITH_DEV: '' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: executable, args: sourceBuild ? [repo] : [], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  // tsx/esbuild keepNames emits __name around named closures sent to page.evaluate.
  // Supply only that test-serialization helper in the isolated page.
  await page.addInitScript('globalThis.__name = value => value;');
  await page.evaluate('globalThis.__name = value => value;');
  // Only the private verification window is allowed below the product's minimum size
  // so 800/960px are genuinely tested rather than silently clamped to 1080px.
  originalMinimumSize = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0], minimum = win.getMinimumSize(); win.setMinimumSize(320, 240); return minimum; });
  // Enforce a read-only command boundary in THIS private app. Preserve the real state dispatcher.
  await app.evaluate(({ ipcMain, session }) => {
    const original = (ipcMain as any)._invokeHandlers.get('partsmith:command'); if (!original) throw Error('Command guard is unavailable.');
    (globalThis as any).__ui13Audit = { states: 0, blocked: [] as string[], network: [] as string[] };
    ipcMain.removeHandler('partsmith:command');
    ipcMain.handle('partsmith:command', (event, command) => {
      if (command?.type === 'state') { (globalThis as any).__ui13Audit.states++; return original(event, command); }
      (globalThis as any).__ui13Audit.blocked.push(String(command?.type)); return { ok: false, error: 'UI verification permits state reads only.' };
    });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      (globalThis as any).__ui13Audit.network.push(new URL(details.url).hostname); done({ cancel: true });
    });
  });
  const state = () => page!.evaluate(() => window.desktop.call<AppState>({ type: 'state' }));
  const initialState = await state(); assert.equal(initialState.dataDir, profile); assert.equal(initialState.key.configured, false);
  assert.deepEqual(initialState.graphicsWorkspaces!.find(workspace => workspace.projectId === projectId), originalWorkspace);
  if (fontOnly) {
    await resize({ width: 1280, height: 900, zoom: 1 });
    const fontSample = async (screen: string, selector: string) => {
      const sample = await page!.locator(selector).first().evaluate(el => {
        const style = getComputedStyle(el);
        return { text: el.textContent?.trim().slice(0, 120), fontFamily: style.fontFamily, fontSize: style.fontSize,
          fontWeight: style.fontWeight, fontsStatus: document.fonts.status,
          malgunAvailable: document.fonts.check('13px "Malgun Gothic"'), segoeAvailable: document.fonts.check('13px "Segoe UI"') };
      });
      const cdp = await page!.context().newCDPSession(page!);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const dom = await cdp.send('DOM.getDocument');
      const node = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector });
      const actualFonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
      await cdp.detach(); fontDiagnostics.push({ screen, selector, ...sample, actualFonts: actualFonts.fonts });
    };
    await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click();
    await page.locator('main.home').waitFor(); await fontSample('home', 'main.home h1');
    await page.getByRole('button', { name: '연결 설정', exact: true }).first().click();
    await page.locator('main.settings-page').waitFor(); await fontSample('settings', 'main.settings-page label');
    await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click();
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
    await page.getByTestId('graphics-studio').waitFor();
    await page.getByTestId(`graphics-object-${objectId}`).click();
    await fontSample('graphics', '.gs-execution-summary');
  }
  for (const combo of fontOnly ? [] : combinations) {
    await resize(combo);
    await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click(); await page.locator('main.home').waitFor();
    await capture('home', page.getByRole('button', { name: '새 프로젝트', exact: true }).first());
    await page.getByRole('button', { name: '연결 설정', exact: true }).first().click(); await page.locator('main.settings-page').waitFor();
    await page.getByLabel('Tripo API 키', { exact: true }).waitFor();
    await capture('settings', page.getByRole('button', { name: '경로 저장', exact: true }));
    await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click();
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
    await page.getByTestId('graphics-studio').waitFor(); await page.getByTestId(`graphics-object-${objectId}`).click();
    const nav = page.getByRole('navigation', { name: '제작 단계', exact: true }); assert.equal(await nav.getByRole('button').count(), 7);
    for (let index = 0; index < stages.length; index++) {
      await nav.getByRole('button', { name: stages[index], exact: true }).click(); await settle();
      assert.equal(await nav.getByRole('button', { name: stages[index], exact: true }).getAttribute('aria-current'), 'step');
      await capture(`stage-${index + 1}`, page.getByTestId('graphics-prepare'));
    }
    await page.getByTestId('graphics-new-object').click(); const dialog = page.getByRole('dialog', { name: '새 오브젝트 만들기', exact: true }); await dialog.waitFor();
    const groups = dialog.getByRole('group', { name: '오브젝트 분류', exact: true }); assert.equal(await groups.getByRole('button').count(), 5);
    await groups.getByRole('button', { name: '건물·건축 부품', exact: true }).click();
    await dialog.getByRole('group', { name: '만들 대상 선택', exact: true }).getByRole('button', { name: '단독 건물', exact: true }).click();
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('화면 검사용 건물 · 생성하지 않음');
    await capture('new-object', dialog.getByRole('button', { name: '오브젝트 만들기', exact: true }), true);
    await dialog.getByRole('button', { name: '취소', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
    assert.deepEqual((await state()).graphicsWorkspaces!.find(workspace => workspace.projectId === projectId), originalWorkspace, 'Viewing screens must not change settings/adoptions/tasks.');
  }
  const finalState = await state();
  assert.deepEqual(finalState.graphicsWorkspaces!.find(workspace => workspace.projectId === projectId), originalWorkspace);
  assert.deepEqual(finalState.projects.find(project => project.id === projectId), originalProject); privatePreserved = true;
  commandAudit = await app.evaluate(() => (globalThis as any).__ui13Audit);
  assert.deepEqual((commandAudit as any).blocked, [], 'An unexpected mutation command was blocked.');
  assert.deepEqual((commandAudit as any).network, [], 'An unexpected external browser request was blocked.');
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (app) await screenshot(path.join(screenshots, 'failure.png')).catch(() => {});
  if (app) commandAudit = await app.evaluate(() => (globalThis as any).__ui13Audit).catch(() => undefined);
} finally {
  await app?.close();
  productionPreserved = metadata.every(file => fs.readFileSync(file.file).equals(file.bytes));
  sourceFilesPreserved = originalFiles.every(file => fileSha(file.file) === file.sha256);
  const privateWorkspace = path.join(privateRoot, 'graphics/workspace.json');
  privatePreserved = privatePreserved && fs.readFileSync(privateWorkspace).equals(metadata[1].bytes) && originalFiles.every(file => fileSha(path.join(privateRoot, file.relative)) === file.sha256);
  const passed = !errors.length && !violations.length && productionPreserved && sourceFilesPreserved && privatePreserved;
  const report = { passed, version, executable, profile, screenshots, checks, fontDiagnostics, violations, errors, commandAudit, originalMinimumSize, privateMinimumSizeOverride: [320, 240], screenshotMethod: 'Electron webContents.capturePage native PNG',
    originalFiles: originalFiles.length, originalBytes: originalFiles.reduce((sum, file) => sum + file.bytes, 0), productionPreserved, sourceFilesPreserved, privatePreserved,
    productionMutations: 0, paidSubmissions: 0, gptRequests: 0, generatedAssets: 0 };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, profile, reportFile, screens: checks.length, violations: violations.length, errors: errors.length, productionPreserved, sourceFilesPreserved, privatePreserved }));
  if (!passed) process.exitCode = 1;
}
