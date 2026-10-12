// Actual built main/preload + renderer, always in a fresh isolated profile.
// npx tsx scripts/graphics-app-check.ts [--source <synthetic.blend>] [--soak-minutes 30]
// Native/API generation is never approved. Only the zero-credit local X04 request is executed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import electronBinary from "electron";
import type { AppState } from "../shared/types";
import type {
  AssetVersion,
  GraphicsTask,
  GraphicsWorkspace,
} from "../shared/graphics";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: npx tsx scripts/graphics-app-check.ts [--source <synthetic.blend>] [--soak-minutes 30]. Fresh isolated app profile; pending native request is never approved; real local Blender export only.",
  );
  process.exit(0);
}
const argument = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};
const source = path.resolve(
  argument("--source") ??
    "C:/Users/김민준/AppData/Local/Temp/ps-graphics-check-X4GU1P/Sources/static.blend",
);
const soakMinutes = Number(argument("--soak-minutes") ?? 0);
assert(
  Number.isFinite(soakMinutes) && soakMinutes >= 0 && soakMinutes <= 120,
  "soak duration must be 0–120 minutes",
);
assert(
  fs.existsSync(source),
  "Provide an existing isolated synthetic Blender fixture with --source",
);
assert.equal(path.extname(source).toLowerCase(), ".blend");
const repository = process.cwd();
for (const file of [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist/index.html",
])
  assert(
    fs.existsSync(path.join(repository, file)),
    `Build the app first: ${file}`,
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-graphics-app-check-"));
assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
assert(path.basename(root).startsWith("ps-graphics-app-check-"));
const profile = path.join(root, "profile"),
  inputs = path.join(root, "inputs");
fs.mkdirSync(inputs, { recursive: true });
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const modelSourceHash = hash(source);
const modelInput = path.join(inputs, "synthetic-cube.blend");
fs.copyFileSync(source, modelInput);
const imageInput = path.join(inputs, "synthetic-reference.png");
const png = new PNG({ width: 32, height: 32 });
for (let y = 0; y < 32; y++)
  for (let x = 0; x < 32; x++) {
    const index = (y * 32 + x) * 4;
    png.data[index] = x < 16 ? 224 : 42;
    png.data[index + 1] = y < 16 ? 190 : 94;
    png.data[index + 2] = 60;
    png.data[index + 3] = 255;
  }
fs.writeFileSync(imageInput, PNG.sync.write(png));
const imageSourceHash = hash(imageInput);
const artifacts = path.join(repository, "artifacts", "runtime");
fs.mkdirSync(artifacts, { recursive: true });
const artifact = path.join(artifacts, "graphics-app-check.json");
const startedAt = Date.now();
const errors: string[] = [];
const report: Record<string, unknown> = {
  passed: false,
  root,
  profile,
  source,
  modelSourceHash,
  imageSourceHash,
  startedAt: new Date(startedAt).toISOString(),
  soakMinutes,
  actualMainPreload: true,
  fakeOnAction: false,
  nativeApprovals: 0,
  paidSubmissions: 0,
  errors,
};
const bootstrap = path.join(root, "bootstrap.cjs");
fs.writeFileSync(
  bootstrap,
  `
process.on('uncaughtException', error => { console.error('ISOLATED APP ERROR:', error.stack); process.exit(1); });
process.on('unhandledRejection', error => { console.error('ISOLATED APP REJECTION:', error && error.stack || String(error)); process.exit(1); });
const { app, dialog } = require('electron');
app.setAppPath(${JSON.stringify(repository)});
process.chdir(${JSON.stringify(repository)});
dialog.showErrorBox = (title, message) => { console.error('ISOLATED APP DIALOG:', title, message); app.exit(1); };
app.on('browser-window-created', (_event, win) => { win.hide(); win.webContents.setBackgroundThrottling(false); });
require(${JSON.stringify(path.join(repository, "dist-electron/main.cjs"))});
`,
);

let app: ElectronApplication | undefined;
let page: Page;
let projectId = "";
let imageObjectId = "";
let modelObjectId = "";
let pendingId = "";
let pendingSnapshot: GraphicsTask;
let imageVersion: AssetVersion;
let modelVersion: AssetVersion;
let localTaskId = "";
let exportedVersions: AssetVersion[] = [];

function saveReport() {
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
}
async function state(): Promise<AppState> {
  return page.evaluate(() => window.desktop.call<AppState>({ type: "state" }));
}
async function workspace(): Promise<GraphicsWorkspace> {
  const value = (await state()).graphicsWorkspaces?.find(
    (item) => item.projectId === projectId,
  );
  assert(value, "graphics workspace exists in actual host state");
  return value;
}
async function waitForWorkspace(
  predicate: (value: GraphicsWorkspace) => boolean,
  timeout = 15000,
): Promise<GraphicsWorkspace> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = (await state()).graphicsWorkspaces?.find(
      (item) => item.projectId === projectId,
    );
    if (current && predicate(current)) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw Error(
    "Actual host state did not reach the expected condition within the bounded wait",
  );
}
async function launch() {
  app = await electron.launch({
    executablePath: electronBinary as unknown as string,
    args: [bootstrap],
    env: { ...process.env, PARTSMITH_DATA: profile, PARTSMITH_DEV: "" },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .waitFor();
  const current = await state();
  assert.equal(path.resolve(current.dataDir), path.resolve(profile));
  const security = await page.evaluate(() => ({
    node: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: typeof window.desktop.call,
  }));
  assert.deepEqual(security, {
    node: "undefined",
    process: "undefined",
    bridge: "function",
  });
}
async function closeApp() {
  const closing = app;
  app = undefined;
  if (!closing) return;
  try {
    await closing.close();
  } catch (error) {
    closing.process().kill();
    throw error;
  }
}
async function openProject() {
  await page
    .locator(`[data-project-id="${projectId}"]`)
    .getByTestId("project-open")
    .click();
  await page.getByTestId("graphics-studio").waitFor();
}
async function selectTask(taskId: string) {
  await page.getByRole("tab", { name: "전체", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 검색", exact: true })
    .fill(taskId);
  await page.locator(`[data-task-id="${taskId}"] .gs-task-open`).click();
}
async function createObject(name: string, kind: "weapon" | "prop") {
  await page.getByLabel("이름", { exact: true }).fill(name);
  await page.getByLabel("종류", { exact: true }).selectOption(kind);
  await page
    .getByRole("button", { name: "오브젝트 만들기", exact: true })
    .click();
  await waitForWorkspace((current) =>
    current.objects.some((object) => object.name === name),
  );
  const object = (await workspace()).objects.find(
    (item) => item.name === name,
  )!;
  await page.getByTestId(`graphics-object-${object.id}`).click();
  return object.id;
}
async function importFile(
  file: string,
  role: "design" | "model",
  objectId: string,
) {
  assert(app);
  // The real main process opens its real dialog API; only the returned fixture selection is substituted.
  await app.evaluate(({ dialog }, selected) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      // Literal function source avoids tsx's keep-names helper in Electron's separate context.
      value: Function(
        "selected",
        "return async function () { return { canceled: false, filePaths: [selected] }; }",
      )(selected),
    });
  }, file);
  await page.getByLabel("가져올 자료의 역할").selectOption(role);
  await page.getByTestId("graphics-import").click();
  await waitForWorkspace((current) =>
    current.versions.some((version) => version.objectId === objectId),
  );
  const version = (await workspace()).versions.find(
    (item) => item.objectId === objectId,
  )!;
  await page.getByTestId(`graphics-version-${version.id}`).click();
  assert.equal(version.files[0].sha256, hash(file));
  assert.equal(
    hash(path.join(profile, "projects", projectId, version.files[0].path)),
    hash(file),
  );
  return version;
}
async function acceptVersion(version: AssetVersion) {
  await page.getByTestId("graphics-accept-version").click();
  await page
    .getByTestId("graphics-accept-version")
    .filter({ hasText: "현재 채택 버전" })
    .waitFor();
  assert.equal(
    (await workspace()).objects.find((object) => object.id === version.objectId)
      ?.accepted[`${version.role}:${version.slot}`],
    version.id,
  );
}
async function assertNoGeneration() {
  const current = await state(),
    w = await workspace();
  assert.equal(
    current.projects.find((project) => project.id === projectId)?.jobs.length,
    0,
    "no legacy/API job was submitted",
  );
  assert.equal(
    current.productionRuns?.filter((run) => run.projectId === projectId)
      .length ?? 0,
    0,
  );
  assert(
    !current.workbenches
      ?.filter((item) => item.projectId === projectId)
      .some((item) => item.jobs.length > 0),
  );
  assert(
    w.tasks
      .filter((task) => !task.localOnly)
      .every(
        (task) => task.id === pendingId && task.status === "awaiting_approval",
      ),
  );
  if (pendingId)
    assert(
      !fs.existsSync(
        path.join(
          profile,
          "projects",
          projectId,
          "graphics",
          "jobs",
          pendingId,
        ),
      ),
      "pending native request never created worker files",
    );
}
async function verifyPending(label: string) {
  const w = await workspace(),
    task = w.tasks.find((item) => item.id === pendingId);
  assert.deepEqual(
    task,
    pendingSnapshot,
    `${label}: frozen native request preserved byte-for-byte in state`,
  );
  assert.deepEqual(
    w.versions.find((version) => version.id === imageVersion.id),
    imageVersion,
  );
  assert.equal(
    hash(path.join(profile, "projects", projectId, imageVersion.files[0].path)),
    imageSourceHash,
  );
  assert.equal(
    w.objects.find((object) => object.id === imageObjectId)?.accepted[
      "design:main"
    ],
    imageVersion.id,
  );
  await page.getByTestId(`graphics-object-${imageObjectId}`).click();
  await page.getByTestId(`graphics-cost-${pendingId}`).waitFor();
  assert.equal(
    await page.getByTestId(`graphics-approve-${pendingId}`).isEnabled(),
    true,
  );
  assert.match(
    await page.getByTestId(`graphics-cost-${pendingId}`).innerText(),
    /Codex 계정 사용량/,
  );
  await assertNoGeneration();
}
async function waitUntil(deadline: number) {
  while (Date.now() < deadline)
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(30000, deadline - Date.now())),
    );
}

try {
  console.log(
    JSON.stringify({ phase: "launch isolated actual app", root, soakMinutes }),
  );
  await launch();
  assert.equal(
    (await state()).projects.length,
    0,
    "fresh profile contains no copied production projects",
  );
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("프로젝트 이름").fill("Graphics app isolated check");
  assert.equal(await create.getByRole("checkbox").isChecked(), false);
  await create
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await page.getByTestId("graphics-studio").waitFor();
  projectId = (await state()).projects[0].id;
  report.projectId = projectId;
  assert.equal(await page.locator("[data-task-id]").count(), 116);
  imageObjectId = await createObject("Isolated reference weapon", "weapon");
  imageVersion = await importFile(imageInput, "design", imageObjectId);
  await acceptVersion(imageVersion);
  await page
    .getByTestId("graphics-reference-version")
    .selectOption(imageVersion.id);
  await page.getByLabel("참고 역할", { exact: true }).selectOption("style");
  await page.getByRole("button", { name: "참고 연결", exact: true }).click();
  await page
    .getByRole("button", {
      name: "synthetic-reference.png 참고 연결 해제",
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("원하는 결과와 유지할 특징")
    .fill(
      "Pending-only test. A sword inspired by the attached colors. Preserve the original. Do not submit without explicit approval.",
    );
  await selectTask("I02");
  await page.getByTestId("graphics-prepare").click();
  await waitForWorkspace((current) =>
    current.tasks.some(
      (task) => task.taskId === "I02" && task.status === "awaiting_approval",
    ),
  );
  pendingSnapshot = (await workspace()).tasks.find(
    (task) => task.taskId === "I02",
  )!;
  pendingId = pendingSnapshot.id;
  assert.equal(pendingSnapshot.cost?.provider, "Codex");
  assert.equal(pendingSnapshot.cost?.credits, null);
  assert.deepEqual(pendingSnapshot.inputVersionIds, [imageVersion.id]);
  assert.equal(pendingSnapshot.objectSnapshot?.references[0].role, "style");
  await verifyPending("initial");
  await page.getByTestId(`graphics-cost-${pendingId}`).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, "graphics-app-pending.png"),
    fullPage: false,
  });
  report.pendingTaskId = pendingId;
  report.requestHash = pendingSnapshot.requestHash;
  const pendingAt = Date.now(),
    deadline = pendingAt + soakMinutes * 60000;
  saveReport();
  if (soakMinutes > 0) {
    console.log(
      JSON.stringify({
        phase: "durable pending wait",
        minutes: soakMinutes,
        restartAt: new Date(pendingAt + soakMinutes * 30000).toISOString(),
        finishAt: new Date(deadline).toISOString(),
      }),
    );
    await waitUntil(pendingAt + soakMinutes * 30000);
    await verifyPending("midpoint before restart");
  }
  await closeApp();
  await launch();
  await openProject();
  await verifyPending("restart");
  report.pendingRestartPreserved = true;
  if (soakMinutes > 0) {
    await waitUntil(deadline);
    await verifyPending("durable wait finished");
    assert(Date.now() - pendingAt >= soakMinutes * 60000);
  }
  report.pendingMeasuredMilliseconds = Date.now() - pendingAt;
  console.log(
    JSON.stringify({
      phase: "pending verified; real local X04 next",
      elapsedMs: report.pendingMeasuredMilliseconds,
    }),
  );

  modelObjectId = await createObject("Isolated static cube", "prop");
  modelVersion = await importFile(modelInput, "model", modelObjectId);
  await acceptVersion(modelVersion);
  await selectTask("X04");
  await page.getByLabel("출력 형식", { exact: true }).selectOption("both");
  await page.getByTestId("graphics-prepare").click();
  await waitForWorkspace((current) =>
    current.tasks.some(
      (task) => task.taskId === "X04" && task.status === "awaiting_approval",
    ),
  );
  const localTask = (await workspace()).tasks.find(
    (task) => task.taskId === "X04",
  )!;
  localTaskId = localTask.id;
  assert.equal(localTask.localOnly, true);
  assert.equal(localTask.cost?.credits, 0);
  assert.equal(localTask.cost?.provider, "로컬");
  assert.deepEqual(localTask.inputVersionIds, [modelVersion.id]);
  assert.equal(localTask.settings.exportFormat, "both");
  await page.getByTestId(`graphics-approve-${localTaskId}`).click();
  const completedWorkspace = await waitForWorkspace(
    (current) =>
      current.tasks.some(
        (task) =>
          task.id === localTaskId &&
          ["review", "failed", "submission_unknown"].includes(task.status),
      ),
    180000,
  );
  const localResult = completedWorkspace.tasks.find(
    (task) => task.id === localTaskId,
  )!;
  assert.equal(localResult.status, "review", localResult.message);
  exportedVersions = (await workspace()).versions.filter((version) =>
    localResult.outputVersionIds.includes(version.id),
  );
  assert.equal(exportedVersions.length, 1);
  const exportedFiles = exportedVersions.flatMap((version) => version.files);
  assert(exportedFiles.some((file) => /\.fbx$/i.test(file.path)));
  assert(exportedFiles.some((file) => /\.glb$/i.test(file.path)));
  for (const file of exportedFiles)
    assert.equal(
      hash(path.join(profile, "projects", projectId, file.path)),
      file.sha256,
    );
  assert.equal(hash(source), modelSourceHash);
  assert.equal(hash(modelInput), modelSourceHash);
  assert.equal(
    hash(path.join(profile, "projects", projectId, modelVersion.files[0].path)),
    modelSourceHash,
  );
  assert.equal(
    (await workspace()).objects.find((object) => object.id === modelObjectId)
      ?.accepted["model:main"],
    modelVersion.id,
    "exports remain unaccepted",
  );
  await page.getByTestId(`graphics-version-${exportedVersions[0].id}`).click();
  await page.getByTestId("graphics-preview").locator("canvas").waitFor();
  await page.getByTestId("graphics-preview").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, "graphics-app-local-export.png"),
    fullPage: false,
  });
  await assertNoGeneration();
  report.localTaskId = localTaskId;
  report.localOutputFiles = exportedFiles.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  report.localApprovedCredits = 0;
  report.originalsPreserved = true;
  report.exportUnaccepted = true;

  await closeApp();
  await launch();
  await openProject();
  await verifyPending("final restart");
  const finalWorkspace = await workspace();
  assert.equal(
    finalWorkspace.tasks.find((task) => task.id === localTaskId)?.status,
    "review",
  );
  assert.deepEqual(
    finalWorkspace.versions.filter((version) =>
      exportedVersions.some((item) => item.id === version.id),
    ),
    exportedVersions,
  );
  assert.equal(
    finalWorkspace.objects.find((object) => object.id === modelObjectId)
      ?.accepted["model:main"],
    modelVersion.id,
  );
  for (const version of exportedVersions)
    for (const file of version.files)
      assert.equal(
        hash(path.join(profile, "projects", projectId, file.path)),
        file.sha256,
      );
  assert.deepEqual(errors, []);
  report.localRestartPreserved = true;
  report.passed = true;
  report.completedAt = new Date().toISOString();
  report.elapsedMilliseconds = Date.now() - startedAt;
  saveReport();
  console.log(
    JSON.stringify({
      passed: true,
      root,
      projectId,
      pendingTaskId: pendingId,
      localTaskId,
      artifact,
      pendingMeasuredMilliseconds: report.pendingMeasuredMilliseconds,
      nativeApprovals: 0,
      paidSubmissions: 0,
    }),
  );
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.elapsedMilliseconds = Date.now() - startedAt;
  saveReport();
  console.error(
    JSON.stringify({
      passed: false,
      root,
      artifact,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  throw error;
} finally {
  await closeApp();
}
