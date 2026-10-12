/** ONE actual native image pilot through the built app UI; isolated profile; never auto-retry/adopt. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronBinary from "electron";
import type { AppState } from "../shared/types";
import type { GraphicsWorkspace } from "../shared/graphics";

const repository = process.cwd(), evidenceFolder = path.join(repository, "artifacts/runtime");
fs.mkdirSync(evidenceFolder, { recursive: true });
const evidence = path.join(evidenceFolder, "graphics-native-live.json");
const previous = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, "utf8")) : undefined;
const recoverExisting = process.argv.includes("--recover-existing");
if (previous?.nativeApprovalClicked && !recoverExisting)
  throw Error("The one native pilot was already approved. Inspect its preserved job; this script will not generate again.");
if (recoverExisting) assert(previous?.nativeApprovalClicked && previous.taskId && previous.projectId && previous.objectId && previous.root, "Existing approved pilot evidence is required for recovery");
for (const file of ["dist-electron/main.cjs", "dist-electron/preload.cjs", "dist/index.html"])
  assert(fs.existsSync(path.join(repository, file)), `Build actual app first: ${file}`);
const root = recoverExisting ? String(previous.root) : fs.mkdtempSync(path.join(os.tmpdir(), "ps-graphics-native-live-"));
assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
assert(path.basename(root).startsWith("ps-graphics-native-live-"));
const profile = path.join(root, "profile"), bootstrap = path.join(root, "bootstrap.cjs");
const pageErrors: string[] = [], startedAt = Date.now();
const report: Record<string, unknown> = { passed: false, root, profile, evidence, actualMainPreload: true,
  startedAt: new Date(startedAt).toISOString(), nativeApprovalClicked: false, approvedCount: 1,
  externalPaidApiSubmissions: 0, browserRequired: false, autoAdoption: false, pageErrors };
if (recoverExisting) {
  Object.assign(report, previous, { passed: false, pageErrors, recoveryStartedAt: new Date().toISOString(), originalPilotFailure: previous.originalPilotFailure ?? previous.error });
  delete report.error;
}
const save = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(bootstrap, `
process.on('uncaughtException', error => { console.error('ISOLATED APP ERROR:', error.stack); process.exit(1); });
process.on('unhandledRejection', error => { console.error('ISOLATED APP REJECTION:', error && error.stack || String(error)); process.exit(1); });
const { app, dialog } = require('electron');
app.setAppPath(${JSON.stringify(repository)});
process.chdir(${JSON.stringify(repository)});
dialog.showErrorBox = (title, message) => { console.error('ISOLATED APP DIALOG:', title, message); app.exit(1); };
app.on('browser-window-created', (_event, win) => { win.hide(); win.on('show', () => win.hide()); win.webContents.setBackgroundThrottling(false); });
require(${JSON.stringify(path.join(repository, "dist-electron/main.cjs"))});
`);

let app: ElectronApplication | undefined, page: Page,
  projectId = recoverExisting ? String(previous.projectId) : "",
  objectId = recoverExisting ? String(previous.objectId) : "",
  taskId = recoverExisting ? String(previous.taskId) : "";
const recoveryHashes: Record<string, string> = {};
async function state() { return page.evaluate(() => window.desktop.call<AppState>({ type: "state" })); }
async function workspace(): Promise<GraphicsWorkspace> {
  const workspace = (await state()).graphicsWorkspaces?.find(item => item.projectId === projectId);
  assert(workspace, "actual host graphics workspace missing"); return workspace;
}
async function waitFor(predicate: (workspace: GraphicsWorkspace) => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await workspace(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Actual app state did not reach the expected condition");
}
async function launch() {
  app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [bootstrap], env: { ...process.env, PARTSMITH_DATA: profile, PARTSMITH_DEV: "" }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).waitFor();
  assert.equal(path.resolve((await state()).dataDir), path.resolve(profile));
}
async function close() { const current = app; app = undefined; if (current) await current.close(); }
function captureLocalEvidence() {
  if (!projectId || !taskId) return;
  const jobFolder = path.join(profile, "projects", projectId, "graphics/jobs", taskId);
  report.jobFolder = jobFolder;
  report.dispatchPath = path.join(jobFolder, "dispatch.json");
  report.workerLogPath = path.join(jobFolder, "work/codex-events.jsonl");
  report.workerResultPath = path.join(jobFolder, "work/result.json");
  report.usagePath = path.join(jobFolder, "usage.json");
  report.nativeProvenancePath = path.join(jobFolder, "native-provenance.json");
  if (fs.existsSync(String(report.usagePath)))
    report.usageMetadata = JSON.parse(fs.readFileSync(String(report.usagePath), "utf8"));
  if (fs.existsSync(String(report.workerLogPath))) {
    let invalidLines = 0;
    const events: { type: string; itemType?: string; status?: string; tool?: string; server?: string; keys?: string[] }[] = [];
    for (const line of fs.readFileSync(String(report.workerLogPath), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "item.completed") events.push({ type: parsed.type, itemType: parsed.item?.type, status: parsed.item?.status, tool: parsed.item?.tool ?? parsed.item?.tool_name, server: parsed.item?.server, keys: Object.keys(parsed.item ?? {}) });
      } catch { invalidLines++; }
    }
    report.nativeEventSummary = events;
    report.invalidNativeEventLines = invalidLines;
    report.workerLogSha256 = hash(String(report.workerLogPath));
  }
}

try {
  save(); console.log(JSON.stringify({ phase: recoverExisting ? "recover same app-owned native result" : "launch isolated actual app", root, evidence }));
  await launch();
  if (recoverExisting) {
    assert.equal((await state()).projects.length, 1);
    for (const field of ["workerLogPath", "workerResultPath", "usagePath", "dispatchPath"]) {
      const file = String(previous[field]); assert(fs.existsSync(file), `Saved proof missing: ${field}`); recoveryHashes[file] = hash(file);
    }
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId("project-open").click();
    await page.getByTestId("graphics-studio").waitFor();
    await page.getByTestId(`graphics-object-${objectId}`).click();
    const existing = await workspace();
    assert.equal(existing.tasks.length, 1, "No additional native request was prepared");
    assert.equal(existing.tasks[0].id, taskId);
    assert.deepEqual(existing.objects.find(object => object.id === objectId)!.accepted, {});
    if (existing.tasks[0].status !== "review") {
      assert(["failed", "submission_unknown"].includes(existing.tasks[0].status));
      await page.getByRole("button", { name: "기존 작업 상태 확인", exact: true }).click();
      report.existingRecoveryClickedAt = new Date().toISOString(); save();
    }
    console.log(JSON.stringify({ phase: "existing result only; no new approval", projectId, objectId, taskId }));
  } else {
  assert.equal((await state()).projects.length, 0, "fresh profile only");
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("프로젝트 이름").fill("네이티브 이미지 단일 연결 검증");
  assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
  await dialog.getByRole("button", { name: "프로젝트 만들기", exact: true }).click();
  await page.getByTestId("graphics-studio").waitFor(); projectId = (await state()).projects[0].id;
  report.projectId = projectId;
  await page.getByLabel("이름", { exact: true }).fill("네이티브 검증 대검");
  await page.getByLabel("종류", { exact: true }).selectOption("weapon");
  await page.getByRole("button", { name: "오브젝트 만들기", exact: true }).click();
  await waitFor(value => value.objects.some(object => object.name === "네이티브 검증 대검"));
  objectId = (await workspace()).objects.find(object => object.name === "네이티브 검증 대검")!.id;
  report.objectId = objectId;
  await page.getByTestId(`graphics-object-${objectId}`).click();
  await page.getByRole("tab", { name: "전체", exact: true }).click();
  await page.getByRole("textbox", { name: "작업 검색", exact: true }).fill("I01");
  await page.locator('[data-task-id="I01"] .gs-task-open').click();
  await page.getByLabel("원하는 결과와 유지할 특징").fill("완성도 높은 스타일라이즈드 판타지 게임용 대검 콘셉트 원본 한 장. 대검 한 자루만 단독으로, 손잡이와 칼끝을 포함한 전체 실루엣이 넉넉한 여백 안에 완전히 보이게 구성하세요. 세련된 은빛 넓은 칼날, 짙은 청색 손잡이, 절제된 금속 문양으로 기능적인 형태를 표현하세요. 깔끔한 흰 배경, 일관된 부드러운 조명, 게임 제작에 읽기 쉬운 형태. 인물, 손, 문자, 로고, 여러 시점 시트는 넣지 마세요. 네이티브 이미지 원본 품질과 현재 설정된 모델·추론 수준을 유지하세요.");
  await page.getByLabel("후보 개수", { exact: true }).fill("1");
  await page.getByTestId("graphics-prepare").click();
  await waitFor(value => value.tasks.some(task => task.taskId === "I01" && task.status === "awaiting_approval"));
  const pending = (await workspace()).tasks.find(task => task.taskId === "I01")!; taskId = pending.id;
  report.taskId = taskId; report.requestHash = pending.requestHash; report.frozenSettings = pending.settings;
  assert.equal(pending.settings.count, 1); assert.equal(pending.cost?.provider, "Codex"); assert.equal(pending.cost?.credits, null);
  assert.deepEqual(pending.inputVersionIds, []); assert.deepEqual((await workspace()).objects[0].accepted, {});
  await page.getByTestId(`graphics-cost-${taskId}`).scrollIntoViewIfNeeded();
  assert.match(await page.getByTestId(`graphics-cost-${taskId}`).innerText(), /Codex 계정 사용량/);
  // Hidden Chromium windows may not produce compositor screenshots; this is not a generation gate.
  await page.screenshot({ path: path.join(evidenceFolder, "graphics-native-live-approval.png"), timeout: 2000 }).catch(() => { report.hiddenApprovalScreenshotUnavailable = true; });
  // Persist before the single UI click. Even a click/transport failure cannot authorize replay.
  report.nativeApprovalClicked = true; report.approvedAt = new Date().toISOString(); save();
  await page.getByTestId(`graphics-approve-${taskId}`).click();
  console.log(JSON.stringify({ phase: "one native usage approval clicked", projectId, objectId, taskId }));
  }
  const deadline = Date.now() + 31 * 60_000;
  let lastUpdate = 0, result = (await workspace()).tasks.find(task => task.id === taskId)!;
  while (["awaiting_approval", "running"].includes(result.status) && Date.now() < deadline) {
    if (Date.now() - lastUpdate > 15000) {
      lastUpdate = Date.now(); report.lastStatus = result.status; report.lastMessage = result.message; captureLocalEvidence(); save();
      console.log(JSON.stringify({ phase: "waiting native result", status: result.status, message: result.message.slice(0, 500), elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) }));
    }
    await new Promise(resolve => setTimeout(resolve, 1500)); result = (await workspace()).tasks.find(task => task.id === taskId)!;
  }
  captureLocalEvidence(); report.lastStatus = result.status; report.lastMessage = result.message; save();
  assert.equal(result.status, "review", result.message);
  const completed = await workspace(), versions = completed.versions.filter(version => result.outputVersionIds.includes(version.id));
  assert.equal(versions.length, 1); assert.equal(versions[0].files.length, 1);
  const original = versions[0].files[0], absolute = path.join(profile, "projects", projectId, original.path);
  assert.equal(hash(absolute), original.sha256); assert.equal(fs.statSync(absolute).size, original.bytes);
  assert.deepEqual(completed.objects.find(object => object.id === objectId)!.accepted, {});
  assert.equal((await state()).projects.find(project => project.id === projectId)!.jobs.length, 0);
  for (const [file, priorHash] of Object.entries(recoveryHashes)) assert.equal(hash(file), priorHash, "Saved-result recovery must not dispatch another native turn or alter original proof");
  if (recoverExisting) report.recoveryProofHashesUnchanged = true;
  report.original = { ...original, absolute }; report.versionId = versions[0].id;
  await page.getByTestId(`graphics-version-${versions[0].id}`).click();
  await page.getByTestId("graphics-preview").locator("img").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="graphics-preview"] img')].some(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0));
  report.renderedDimensions = await page.getByTestId("graphics-preview").locator("img").evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
  await page.getByTestId("graphics-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceFolder, "graphics-native-live-result.png"), timeout: 2000 }).catch(() => { report.hiddenResultScreenshotUnavailable = true; });
  const before = structuredClone(completed); await close(); await launch();
  await page.locator(`[data-project-id="${projectId}"]`).getByTestId("project-open").click();
  await page.getByTestId("graphics-studio").waitFor();
  const restarted = await workspace();
  assert.deepEqual(restarted, before); assert.equal(hash(absolute), original.sha256);
  assert.deepEqual(restarted.objects.find(object => object.id === objectId)!.accepted, {});
  await page.getByTestId(`graphics-object-${objectId}`).click(); await page.getByTestId(`graphics-version-${versions[0].id}`).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="graphics-preview"] img')].some(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0));
  assert.deepEqual(pageErrors, []);
  report.restartPreserved = true; report.passed = true; report.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: true, evidence, projectId, taskId, original: absolute, usagePath: report.usagePath }));
} catch (error) {
  captureLocalEvidence(); report.error = error instanceof Error ? error.message : String(error); report.elapsedMilliseconds = Date.now() - startedAt; save();
  console.error(JSON.stringify({ passed: false, evidence, root, projectId, taskId, error: report.error }));
  process.exitCode = 1;
} finally { await close(); }
