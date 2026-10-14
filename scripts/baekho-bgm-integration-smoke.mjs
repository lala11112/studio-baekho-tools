import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// This harness has no generation mode. It reads the original three-track proof,
// copies only its BGM folder, and uses a fresh app profile with empty credentials.
const root = process.cwd();
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} requires a value`);
  return path.resolve(process.argv[index + 1]);
};
const packaged = option("--packaged");
const source = option("--source-bgm") ?? path.resolve(root, "../bgm-app/artifacts/runtime/bgm-live-2026-10-14/profile/bgm");
const mode = packaged ? "packaged" : "development";
const runtimeParent = path.join(root, "artifacts/runtime");
fs.mkdirSync(runtimeParent, { recursive: true });
const runtime = fs.mkdtempSync(path.join(runtimeParent, `baekho-bgm-${mode}-`));
const profile = path.join(runtime, "profile");
const screenshots = path.join(runtime, "screenshots");
fs.mkdirSync(screenshots, { recursive: true });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function snapshot(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink(), "BGM proof folders must not contain links");
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return snapshot(file, base);
    assert.ok(entry.isFile(), "BGM proof entries must be regular files");
    return [{ file: path.relative(base, file), bytes: fs.statSync(file).size, sha256: digest(file) }];
  });
}
function copyDirectory(sourceDirectory, destination) {
  // Node 24.14 fs.cpSync can crash on Windows paths containing Korean text.
  // Copy regular entries explicitly and never follow a filesystem link.
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "BGM proof folders must not contain links");
    const sourceEntry = path.join(sourceDirectory, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourceEntry, destinationEntry);
    else {
      assert.ok(entry.isFile(), "BGM proof entries must be regular files");
      fs.copyFileSync(sourceEntry, destinationEntry, fs.constants.COPYFILE_EXCL);
    }
  }
}
const originalFiles = snapshot(source);
const originalLedger = JSON.parse(fs.readFileSync(path.join(source, "ledger.json"), "utf8"));
assert.equal(originalLedger.candidates.length, 3, "Expected the three existing proof tracks");
assert.ok(originalLedger.candidates.every((candidate) => candidate.status === "ready"));
assert.equal(originalLedger.totalReservedUsd, 0.12);
fs.mkdirSync(profile, { recursive: true });
copyDirectory(source, path.join(profile, "bgm"));
assert.deepEqual(snapshot(path.join(profile, "bgm")), originalFiles);
const env = { ...process.env, FAL_KEY: "", TRIPO_API_KEY: "", TRIPO_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", BAEKHO_DATA: profile, PARTSMITH_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PARTSMITH_DEV;
let app;
let page;
let modelProjectId;
const errors = [];
const checks = [];
const playback = [];
const exports = [];
const networkAttempts = [];
async function until(action, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}
function observe(target) { target.on("pageerror", (error) => errors.push(error.message)); }
async function launch() {
  app = await electron.launch({ executablePath: packaged ?? electronPath, args: packaged ? [] : ["."], cwd: root, env, timeout: 45_000 });
  app.context().on("page", observe);
  page = await app.firstWindow();
  observe(page);
  // Both Node fetch and Electron network are denied before any tool is opened.
  // Local custom protocols remain available for MP3 preview/native workspaces.
  await app.evaluate(({ session, ipcMain }) => {
    globalThis.__integrationNetworkAttempts = [];
    globalThis.fetch = async (target) => {
      let host = "unknown";
      try { host = new URL(String(target)).hostname; } catch { /* Never log a raw URL. */ }
      globalThis.__integrationNetworkAttempts.push({ transport: "fetch", host });
      throw new Error("External network is disabled in the local integration test.");
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      globalThis.__integrationNetworkAttempts.push({ transport: "electron", host: new URL(details.url).hostname });
      callback({ cancel: true });
    });
    for (const name of ["generate", "retry", "refresh"]) {
      ipcMain.removeHandler(`bgm:${name}`);
      ipcMain.handle(`bgm:${name}`, () => {
        globalThis.__integrationNetworkAttempts.push({ transport: "blocked-ipc", action: name });
        throw new Error("Only saved BGM state, selection and export are allowed in this test.");
      });
    }
  });
  await page.getByTestId("nav-home").waitFor();
  return page;
}
async function close() {
  if (!app) return;
  networkAttempts.push(...await app.evaluate(() => globalThis.__integrationNetworkAttempts ?? []).catch(() => []));
  await app.close();
  app = undefined;
}
async function home() { await page.getByTestId("nav-home").click(); }
async function capture(name) { await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true }); }
async function preview(candidate, restart = false) {
  const audio = page.locator(`audio[src="${candidate.previewUrl}"]`);
  await audio.waitFor();
  const result = await audio.evaluate(async (element) => {
    element.muted = true;
    element.currentTime = 0;
    await element.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { element.removeEventListener("timeupdate", check); reject(new Error("Local MP3 playback did not advance")); }, 10_000);
      function check() {
        if (element.currentTime <= 0.1) return;
        clearTimeout(timer);
        element.removeEventListener("timeupdate", check);
        resolve();
      }
      element.addEventListener("timeupdate", check);
      check();
    });
    element.pause();
    return { duration: element.duration, currentTime: element.currentTime, readyState: element.readyState };
  });
  assert.ok(result.duration >= 29 && result.duration <= 31, "Expected an existing 30-second track");
  playback.push({ id: candidate.id, restart, ...result });
}
async function exportTrack(candidate, suffix) {
  const file = path.join(runtime, `${candidate.id}-${suffix}.mp3`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, file);
  await page.getByTestId(`bgm-select-${candidate.id}`).click();
  await until(() => page.evaluate(() => window.bgm.state()).then((state) => state.selectedId === candidate.id), "BGM selection persisted");
  await page.getByTestId("bgm-export").click();
  await until(() => fs.existsSync(file), "local MP3 export");
  await page.waitForFunction(() => !document.querySelector('[data-testid="bgm-export"]')?.disabled);
  const sourceFile = path.join(source, "media", `${candidate.id}.mp3`);
  assert.equal(digest(file), digest(sourceFile), "Export must exactly match the original saved MP3");
  exports.push({ id: candidate.id, suffix, file: path.relative(runtime, file), bytes: fs.statSync(file).size, sha256: digest(file) });
}
function stableCandidates(state) { return state.candidates.map(({ id, requestId, status, prompt }) => ({ id, requestId, status, prompt })); }
async function verifyNoJobs() {
  const state = await page.evaluate(() => window.desktop.call({ type: "state" }));
  assert.ok((state.graphicsWorkspaces ?? []).every((workspace) => !workspace.tasks?.length), "Navigation must not create graphics generation tasks");
  assert.ok((state.productionRuns ?? []).length === 0, "Navigation must not create production runs");
  assert.ok((state.workbenchJobs ?? []).length === 0, "Navigation must not create workbench generation jobs");
}
let failure;
try {
  await launch();
  for (const id of ["modeling", "combat", "hit-timing", "bgm"]) await page.getByTestId(`tool-${id}`).waitFor();
  checks.push("all four tool cards are available");
  await capture("home");

  const modelProject = await page.evaluate(() => window.desktop.call({ type: "project.create", name: "통합 검증 — 생성 없는 그래픽 작업", demo: false }));
  modelProjectId = modelProject.id;
  await page.getByTestId("tool-modeling").click();
  const picker = page.locator(".ps-project-picker select");
  await until(() => picker.locator(`option[value="${modelProjectId}"]`).count(), "new local project listed");
  await picker.selectOption(modelProjectId);
  await page.getByTestId("graphics-studio").waitFor();
  await page.getByTestId("graphics-new-object").waitFor();
  assert.equal(await page.getByTestId("graphics-prepare").count(), 0, "Empty graphics project must have no prepared production request");
  await page.getByTestId("graphics-new-object").click();
  const creation = page.getByTestId("graphics-create-dialog");
  await creation.waitFor();
  await creation.locator(".gs-subject-groups button").first().click();
  await creation.locator(".gs-subject-targets button").first().click();
  await creation.locator("#gs-object-name").fill("Local integration draft — no generation");
  await creation.locator('button[type="submit"]').click();
  await creation.waitFor({ state: "hidden" });
  await page.locator("#gs-instruction").fill("Keep this latest GraphicsStudio draft; do not generate.");
  await capture("graphics");
  await home();
  await page.getByTestId("tool-modeling").click();
  await page.getByTestId("graphics-studio").waitFor();
  assert.equal(await picker.inputValue(), modelProjectId);
  assert.equal(await page.locator("#gs-instruction").inputValue(), "Keep this latest GraphicsStudio draft; do not generate.");
  checks.push("latest GraphicsStudio opens by default and retains its local object draft across navigation");

  for (const [tool, prefix, ownBridge] of [["combat", "baekho://app/", "baekho"], ["hit-timing", "aht://app/", "autoHitTimer"]]) {
    await home();
    await page.getByTestId(`tool-${tool}`).click();
    const native = await until(() => app.context().pages().find((target) => target.url().startsWith(prefix)), `${tool} native workspace`);
    await native.locator("body").waitFor();
    await until(() => native.evaluate((bridge) => typeof window[bridge] === "object", ownBridge), `${tool} isolated bridge`);
    assert.equal(await native.evaluate(() => typeof window.bgm), "undefined");
    await until(() => app.evaluate(({ BrowserWindow }, urlPrefix) => BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.webContents?.getURL().startsWith(urlPrefix) && view.getVisible()), prefix), `${tool} visible native workspace`);
    await native.screenshot({ path: path.join(screenshots, `${tool}.png`) });
    checks.push(`${tool} native workspace renders with its isolated bridge`);
  }

  await home();
  await page.getByTestId("tool-bgm").click();
  await page.getByTestId("bgm-description").waitFor();
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible())), "native workspaces hidden while BGM is visible");
  const initial = await page.evaluate(() => window.bgm.state());
  assert.equal(initial.configured, false);
  assert.deepEqual(stableCandidates(initial), stableCandidates(originalLedger));
  assert.equal(initial.totalReservedUsd, originalLedger.totalReservedUsd);
  assert.equal(await page.getByTestId("bgm-generate").isEnabled(), false);
  await page.getByTestId("bgm-description").fill("저장된 음악만 확인하는 무과금 통합 검증");
  for (const candidate of initial.candidates) {
    await preview(candidate);
    await exportTrack(candidate, "initial");
  }
  const selected = initial.candidates[2];
  await capture("bgm");
  await home();
  await page.getByTestId("tool-bgm").click();
  assert.equal(await page.getByTestId("bgm-description").inputValue(), "저장된 음악만 확인하는 무과금 통합 검증");
  assert.equal((await page.evaluate(() => window.bgm.state())).selectedId, selected.id);
  checks.push("three existing tracks play, select and export identically; BGM draft survives navigation");
  await verifyNoJobs();
  await close();

  await launch();
  await page.getByTestId("tool-modeling").click();
  await page.locator(".ps-project-picker select").selectOption(modelProjectId);
  await page.getByTestId("graphics-studio").waitFor();
  await home();
  await page.getByTestId("tool-bgm").click();
  await page.getByTestId("bgm-description").waitFor();
  const restored = await page.evaluate(() => window.bgm.state());
  assert.equal(restored.configured, false);
  assert.equal(restored.selectedId, selected.id);
  assert.equal(restored.totalReservedUsd, originalLedger.totalReservedUsd);
  assert.deepEqual(stableCandidates(restored), stableCandidates(initial));
  for (const candidate of restored.candidates) {
    await preview(candidate, true);
    await exportTrack(candidate, "restart");
  }
  await capture("bgm-after-restart");
  await verifyNoJobs();
  checks.push("restart preserves all request IDs, reservations, selection and three offline exports");
  await close();
  assert.deepEqual(errors, [], "No renderer exceptions");
  assert.deepEqual(networkAttempts, [], "Offline validation must not attempt external requests");
  checks.push("no renderer errors, external network attempts or generation jobs");
} catch (error) {
  failure = error;
  if (page && app) await capture("failure").catch(() => {});
} finally {
  await close();
  try { assert.deepEqual(snapshot(source), originalFiles, "Original BGM proof must remain byte-identical"); checks.push("original BGM ledger, journals and MP3 files remain byte-identical"); }
  catch (error) { failure ??= error; }
  const evidence = { ok: !failure, mode, checkedAt: new Date().toISOString(), runtime, profile, sourceBgm: source, originalFileCount: originalFiles.length, modelProjectId, generatedCount: 0, reservedUsdBefore: originalLedger.totalReservedUsd, checks, playback, exports, rendererErrors: errors, networkAttempts, ...(failure ? { error: String(failure.stack ?? failure) } : {}) };
  json(path.join(runtime, "verification.json"), evidence);
  json(path.join(root, `artifacts/baekho-bgm-${mode}-smoke.json`), evidence);
  console.log(JSON.stringify({ ok: evidence.ok, mode, checks: checks.length, evidence: path.join(runtime, "verification.json"), generatedCount: 0, exports: exports.length, rendererErrors: errors, networkAttempts }, null, 2));
}
if (failure) throw failure;
