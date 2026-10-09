import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const packagedIndex = process.argv.indexOf("--packaged");
const executablePath = packagedIndex >= 0 ? path.resolve(process.argv[packagedIndex + 1]) : electronPath;
const mode = packagedIndex >= 0 ? "packaged" : "development";
const root = process.cwd();
const runtime = path.join(root, "artifacts/integration-runtime", `${mode}-${Date.now()}`);
const profile = path.join(runtime, "profile");
const project = path.join(runtime, "통합 검증 Unity");
const screenshots = path.join(root, "artifacts/screenshots/studio");
fs.mkdirSync(screenshots, { recursive: true });
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
fs.mkdirSync(path.join(project, "Assets"), { recursive: true });
fs.mkdirSync(path.join(project, "ProjectSettings"), { recursive: true });
fs.writeFileSync(path.join(project, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
json(path.join(profile, "combat-lab/settings.json"), { projectPath: project });
const runId = "20261009-integration-fixture";
const candidates = [0, 1].map(i => ({ id: `candidate_${i}`, label: `검증 후보 ${i + 1}`, values: [{ id: "hitStop", value: 0.05 + i * 0.02 }] }));
json(path.join(project, "CombatLabResults", runId, "request.json"), { schemaVersion: 1, adapterId: "fixture", sourceGuid: "fixture-source", actionId: "normal-combo", candidates });
json(path.join(project, "CombatLabResults", runId, "report.json"), { schemaVersion: 1, runId, adapterId: "fixture", sourceGuid: "fixture-source", actionId: "normal-combo", startedUtc: "2026-10-09T01:00:00Z", seed: 1701, notes: ["통합 UI 검사 전용 로컬 fixture. 실제 게임 실행 결과가 아닙니다."], results: candidates.map(candidate => ({ candidate, status: "completed", metrics: { hits: 2, damageDealt: 20, elapsedSeconds: 10 }, videoPath: "" })) });
const env = { ...process.env, BAEKHO_DATA: profile, PARTSMITH_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = [];
const app = await electron.launch({ executablePath, args: mode === "packaged" ? [] : ["."], env, timeout: 45000 });
let page;
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await new Promise(resolve => setTimeout(resolve, 180));
  const base64 = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 2000, height: 1400 } });
    const source = sources.find(item => item.id === win.getMediaSourceId());
    if (source && !source.thumbnail.isEmpty()) return source.thumbnail.toPNG().toString("base64");
    return (await win.capturePage()).toPNG().toString("base64");
  });
  fs.writeFileSync(path.join(screenshots, `${mode}-${name}.png`), Buffer.from(base64, "base64"));
}
async function until(action, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await action(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Timed out waiting for integrated workspace");
}
function observe(p) { p.on("pageerror", e => errors.push(`${p.url()}: ${e.message}`)); }
app.context().on("page", observe);
try {
  page = await app.firstWindow(); observe(page);
  await page.getByTestId("nav-home").waitFor();
  await until(() => page.evaluate(async () => (await window.studio.summary()).results.length === 1));
  await page.locator(".bkh-entry-title", { hasText: "통합 검증 Unity" }).waitFor();
  assert.equal(await page.title(), "백호툴 · Studio Baekho");
  assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, desktop: typeof window.desktop, studio: typeof window.studio, combat: typeof window.baekho })), { require: "undefined", desktop: "object", studio: "object", combat: "undefined" });
  checks.push("home loads real isolated records; shell APIs isolated");
  await capture("home");

  const modelProject = await page.evaluate(() => window.desktop.call({ type: "project.create", name: "통합 확인 캐릭터", demo: false }));
  await page.getByTestId("tool-modeling").click();
  await page.locator(".ps-project-picker select").selectOption(modelProject.id);
  await page.locator(".ps-manual-picker select").selectOption("image");
  const modelPrompt = page.locator(".partsmith-embedded textarea").first();
  await modelPrompt.fill("3D 초안 보존 확인 · 생성하지 않음");
  assert.ok(await page.locator(".partsmith-embedded").evaluate(el => el.getBoundingClientRect().width >= el.parentElement.getBoundingClientRect().width - 2), "modeling workspace fills its content area");
  await capture("modeling");
  await page.getByTestId("nav-home").click();
  await page.getByTestId("tool-modeling").click();
  assert.equal(await modelPrompt.inputValue(), "3D 초안 보존 확인 · 생성하지 않음");
  checks.push("modeling project and unsent prompt survive navigation");

  await page.getByTestId("nav-home").click();
  await page.getByTestId("tool-combat").click();
  const combatPage = await until(() => app.context().pages().find(p => p.url().startsWith("baekho://app/")));
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(v => v.webContents?.getURL().startsWith("baekho://app/") && v.getVisible())));
  await combatPage.locator("#goal").waitFor();
  await combatPage.locator("#goal").fill("타격감 초안 보존 확인 · 생성하지 않음");
  const combatIdentity = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("baekho://app/"))?.id);
  assert.deepEqual(await combatPage.evaluate(() => ({ require: typeof window.require, studio: typeof window.studio, desktop: typeof window.desktop, combat: typeof window.baekho })), { require: "undefined", studio: "undefined", desktop: "undefined", combat: "object" });
  await capture("combat");
  await combatPage.screenshot({ path: path.join(screenshots, `${mode}-combat-content.png`) });
  await page.getByTestId("nav-home").click();
  await page.getByTestId("tool-combat").click();
  assert.equal(await combatPage.locator("#goal").inputValue(), "타격감 초안 보존 확인 · 생성하지 않음");
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("baekho://app/"))?.id), combatIdentity);
  checks.push("combat native view and unsent prompt survive navigation; bridges isolated");

  await page.getByTestId("nav-results").click();
  await page.getByRole("button", { name: /normal-combo 실험, 타격감 찾기/ }).click();
  await combatPage.locator("#reportContent").waitFor({ state: "visible" });
  assert.match(await combatPage.locator("#reportMeta").textContent(), new RegExp(runId));
  await capture("results");
  await combatPage.locator("#setupTab").click();
  assert.equal(await combatPage.locator("#goal").inputValue(), "타격감 초안 보존 확인 · 생성하지 않음");
  checks.push("common results reopen exact combat report without replacing setup draft");

  const secondProject = path.join(runtime, "프로젝트 전환 확인");
  fs.mkdirSync(path.join(secondProject, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(secondProject, "ProjectSettings"), { recursive: true });
  fs.writeFileSync(path.join(secondProject, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
  const previousRun = path.join(project, "CombatLabResults", runId);
  const secondRun = path.join(secondProject, "CombatLabResults", runId);
  json(path.join(secondRun, "request.json"), JSON.parse(fs.readFileSync(path.join(previousRun, "request.json"), "utf8")));
  json(path.join(secondRun, "report.json"), { ...JSON.parse(fs.readFileSync(path.join(previousRun, "report.json"), "utf8")), sourceLabel: "새 프로젝트의 결과" });
  await page.getByTestId("nav-settings").click();
  await app.evaluate(({ dialog }, directory) => {
    globalThis.__studioOriginalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, secondProject);
  try { await page.evaluate(() => window.studio.chooseCombatProject()); }
  finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__studioOriginalDialog; delete globalThis.__studioOriginalDialog; }); }
  await page.getByTestId("nav-results").click();
  await page.getByRole("button", { name: /normal-combo 실험, 타격감 찾기/ }).click();
  await until(() => combatPage.locator("#reportMeta").textContent().then(text => text.includes("새 프로젝트의 결과")));
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(await combatPage.locator("#reportContent").isVisible(), true);
  assert.match(await combatPage.locator("#reportMeta").textContent(), /새 프로젝트의 결과/);
  checks.push("switching Unity projects opens the new project report and survives later polling");

  await page.getByTestId("nav-home").click();
  await page.getByTestId("tool-combat").click();
  await page.getByTestId("nav-settings").click();
  await until(() => app.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents?.getURL().startsWith("baekho://app/"));
    return child && !child.getVisible();
  }));
  await capture("settings");
  checks.push("rapid navigation hides native view over settings");
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.restore(); win.show(); win.setSize(1180, 760);
  });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize().every(n => n > 0)));
  await page.getByTestId("nav-home").click();
  await capture("compact-home");
  await page.getByTestId("tool-combat").click();
  await until(() => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], child = win.contentView.children.find(v => v.webContents?.getURL().startsWith("baekho://app/"));
    if (!child?.getVisible()) return false;
    const b = child.getBounds(), [w, h] = win.getContentSize();
    return b.width > 500 && b.height > 300 && b.x + b.width <= w && b.y + b.height <= h;
  }));
  await capture("compact-combat");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.evaluate(() => window.studio.resizeCombat({ x: 174, y: 115, width: 990, height: 600 }));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); });
  await until(() => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], child = win.contentView.children.find(v => v.webContents?.getURL().startsWith("baekho://app/"));
    return !win.isMinimized() && child?.getBounds().width > 500 && child?.getBounds().height > 300;
  }));
  checks.push("native workspace survives minimize and restore");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  checks.push("1180x760 shell and native workspace remain within window");
  assert.deepEqual(errors, []);
  checks.push("no renderer exceptions");
  assert.equal(fs.existsSync(path.join(project, "Library/CombatLabBridge/requests")), false);
  assert.equal(fs.existsSync(path.join(secondProject, "Library/CombatLabBridge/requests")), false);
  checks.push("no Unity command requests created by navigation or report viewing");
  json(path.join(root, `artifacts/studio-${mode}-smoke.json`), { ok: true, date: new Date().toISOString(), checks, evidence: "isolated local fixture; no paid generation or actual Unity run", rendererErrors: errors, screenshots: path.relative(root, screenshots) });
  console.log(JSON.stringify({ ok: true, mode, checks: checks.length, rendererErrors: errors, screenshots }, null, 2));
} catch (error) {
  if (page) { await capture("failure").catch(() => {}); console.error((await page.locator("body").innerText()).slice(0, 4000)); }
  console.error(JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ size: w.getContentSize(), views: w.contentView.children.map(v => ({ visible: v.getVisible(), bounds: v.getBounds(), url: v.webContents?.getURL() })) }))), null, 2));
  json(path.join(runtime, "failure.json"), { error: String(error.stack), errors, checks });
  throw error;
} finally { await app.close(); }
