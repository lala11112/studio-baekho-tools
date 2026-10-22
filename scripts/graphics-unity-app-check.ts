// Real app X05 buttons -> isolated Unity batch import -> app receipt/restart/cache reuse.
// Never approves a native image/API task and never enters Play Mode.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import electronBinary from "electron";
import { runProcess } from "../engine/local";
import type { AppState } from "../shared/types";
import type {
  GraphicsWorkspace,
  GraphicsTask,
  UnityDelivery,
} from "../shared/graphics";

const argument = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};
const profile = fs.realpathSync(
  argument("--profile") ??
    "C:/Users/김민준/AppData/Local/Temp/ps-graphics-app-check-oHeeeQ/profile",
);
const unity = fs.realpathSync(
  argument("--unity") ??
    "C:/Users/김민준/AppData/Local/Temp/ps-graphics-check-X4GU1P/Unity",
);
const temp = fs.realpathSync(os.tmpdir());
assert.equal(path.basename(profile), "profile");
assert.equal(path.dirname(path.dirname(profile)), temp);
assert(
  path.basename(path.dirname(profile)).startsWith("ps-graphics-app-check-"),
);
assert.equal(path.dirname(path.dirname(unity)), temp);
assert(path.basename(path.dirname(unity)).startsWith("ps-graphics-check-"));
assert.equal(path.basename(unity), "Unity");
const repository = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-graphics-unity-app-"));
const artifacts = path.join(repository, "artifacts", "runtime");
fs.mkdirSync(artifacts, { recursive: true });
const artifact = path.join(artifacts, "graphics-unity-app-check.json");
const sha = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const startedAt = Date.now();
const errors: string[] = [];
const report: Record<string, unknown> = {
  passed: false,
  profile,
  unity,
  root,
  actualAppButtons: true,
  actualMainPreload: true,
  fakeOnAction: false,
  nativeApprovals: 0,
  apiSubmissions: 0,
  playMode: false,
  errors,
};
const bootstrap = path.join(root, "bootstrap.cjs");
fs.writeFileSync(
  bootstrap,
  `
process.on('uncaughtException', error => { console.error('ISOLATED UNITY APP ERROR:', error.stack); process.exit(1); });
process.on('unhandledRejection', error => { console.error('ISOLATED UNITY APP REJECTION:', error && error.stack || String(error)); process.exit(1); });
const { app, dialog } = require('electron');
app.setAppPath(${JSON.stringify(repository)});process.chdir(${JSON.stringify(repository)});
dialog.showErrorBox = (title, message) => { console.error('ISOLATED UNITY APP DIALOG:', title, message); app.exit(1); };
app.on('browser-window-created', (_event, win) => { win.hide();win.webContents.setBackgroundThrottling(false); });
require(${JSON.stringify(path.join(repository, "dist-electron/main.cjs"))});
`,
);
let app: ElectronApplication | undefined;
let page: Page;
let projectId = "";
let objectId = "";
let pendingSnapshots: GraphicsTask[] = [];
let originalHashes: { path: string; sha256: string }[] = [];
const save = () => fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
async function state(): Promise<AppState> {
  return page.evaluate(() => window.desktop.call<AppState>({ type: "state" }));
}
async function workspace(): Promise<GraphicsWorkspace> {
  const w = (await state()).graphicsWorkspaces?.find(
    (item) => item.projectId === projectId,
  );
  assert(w);
  return w;
}
async function waitForWorkspace(
  predicate: (w: GraphicsWorkspace) => boolean,
  milliseconds = 30000,
): Promise<GraphicsWorkspace> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const w = await workspace();
    if (predicate(w)) return w;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(
    "Actual app host did not reach expected Unity delivery state before timeout",
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
  assert.equal(path.resolve((await state()).dataDir), path.resolve(profile));
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
  await page.getByTestId(`graphics-object-${objectId}`).click();
}
async function verifyOriginals() {
  for (const file of originalHashes)
    assert.equal(
      sha(path.join(profile, "projects", projectId, file.path)),
      file.sha256,
    );
  const current = await state(),
    w = await workspace();
  assert.equal(
    current.projects.find((project) => project.id === projectId)?.jobs.length,
    0,
    "no API or legacy job submitted",
  );
  assert.deepEqual(
    w.tasks.filter((task) => !task.localOnly),
    pendingSnapshots,
    "native pending snapshots never executed or changed",
  );
  for (const task of pendingSnapshots)
    assert(
      !fs.existsSync(
        path.join(profile, "projects", projectId, "graphics", "jobs", task.id),
      ),
    );
}
async function prepareUnity() {
  await page.getByRole("tab", { name: "전체", exact: true }).click();
  await page
    .getByRole("textbox", { name: "작업 검색", exact: true })
    .fill("X05");
  await page.locator('[data-task-id="X05"] .gs-task-open').click();
  const previousIds = (await workspace()).tasks.map((task) => task.id);
  await page.getByTestId("graphics-prepare").click();
  const ready = await waitForWorkspace((w) =>
    w.tasks.some(
      (task) =>
        task.taskId === "X05" &&
        !previousIds.includes(task.id) &&
        task.status === "awaiting_approval",
    ),
  );
  const task = ready.tasks.find(
    (task) => task.taskId === "X05" && !previousIds.includes(task.id),
  )!;
  assert.equal(task.localOnly, true);
  assert.equal(task.cost?.credits, 0);
  assert.equal(task.cost?.provider, "로컬");
  assert.equal(
    path.resolve(task.targetProfile!.projectPath),
    path.resolve(unity),
  );
  await page.getByTestId(`graphics-approve-${task.id}`).click();
  return task.id;
}
function verifyDelivery(delivery: UnityDelivery) {
  assert.equal(delivery.status, "imported", delivery.errors.join(" · "));
  assert.equal(delivery.playbackVerified, false);
  assert(delivery.guid && delivery.prefabPath && delivery.userPrefabPath);
  assert(fs.existsSync(path.join(unity, delivery.prefabPath)));
  assert(fs.existsSync(path.join(unity, delivery.userPrefabPath)));
}

try {
  console.log(
    JSON.stringify({ phase: "actual app Unity check", profile, unity }),
  );
  await launch();
  const initial = await state();
  const project = initial.projects.find(
    (item) => item.name === "Graphics app isolated check",
  );
  assert(project);
  projectId = project.id;
  const before = initial.graphicsWorkspaces?.find(
    (w) => w.projectId === projectId,
  );
  assert(before);
  const object = before.objects.find(
    (item) => item.name === "Isolated static cube",
  );
  assert(object);
  objectId = object.id;
  const version = before.versions.find(
    (item) => item.id === object.accepted["model:main"],
  );
  assert(version);
  assert(
    version.files.some((file) => /synthetic-cube\.blend$/i.test(file.path)),
  );
  originalHashes = before.versions
    .filter((item) => item.provenance.type === "import")
    .flatMap((item) =>
      item.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    );
  pendingSnapshots = before.tasks.filter((task) => !task.localOnly);
  assert(pendingSnapshots.length > 0);
  assert(pendingSnapshots.every((task) => task.status === "awaiting_approval"));
  assert(
    !before.tasks.some(
      (task) =>
        task.status === "running" || task.status === "submission_unknown",
    ),
  );
  report.projectId = projectId;
  report.objectId = objectId;
  report.acceptedVersionId = version.id;
  report.originalHashes = originalHashes;
  await openProject();
  // Existing actual project-target UI persists through main/preload; no project JSON edits.
  await page.locator(".manual-tools summary").click();
  await page
    .locator(".manual-tools")
    .getByRole("button", { name: /Unity로 보내기/ })
    .click();
  await page.getByLabel("대상 Unity 프로젝트", { exact: true }).fill(unity);
  await page.getByLabel("대상 Unity 프로젝트", { exact: true }).press("Tab");
  const targetDeadline = Date.now() + 15000;
  while (
    path.resolve(
      (await state()).projects.find((item) => item.id === projectId)!.unityPath,
    ) !== path.resolve(unity)
  ) {
    assert(Date.now() < targetDeadline);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }
  await page
    .getByRole("button", { name: "Unity 그래픽 제작", exact: true })
    .click();
  await page.getByTestId(`graphics-object-${objectId}`).click();
  await page
    .getByRole("button", { name: "프로젝트 검사", exact: true })
    .click();
  await waitForWorkspace(
    (w) =>
      !!w.target && path.resolve(w.target.projectPath) === path.resolve(unity),
  );
  const firstTaskId = await prepareUnity();
  const queued = await waitForWorkspace(
    (w) =>
      w.deliveries.some((delivery) => delivery.objectId === objectId) ||
      w.tasks.some(
        (task) => task.id === firstTaskId && task.status === "failed",
      ),
    180000,
  );
  const firstTask = queued.tasks.find((task) => task.id === firstTaskId)!;
  assert.notEqual(firstTask.status, "failed", firstTask.message);
  const delivery = queued.deliveries.find(
    (item) => item.id === firstTask.deliveryId,
  );
  assert(delivery);
  assert.equal(delivery.status, "queued");
  report.firstTaskId = firstTaskId;
  report.deliveryId = delivery.id;
  save();
  await verifyOriginals();
  const editor = (await state()).settings.unityEditorPath;
  console.log(
    JSON.stringify({
      phase: "Unity isolated batch import",
      taskId: firstTaskId,
      deliveryId: delivery.id,
    }),
  );
  await runProcess(editor, [
    "-batchmode",
    "-nographics",
    "-quit",
    "-projectPath",
    unity,
    "-executeMethod",
    "Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch",
    "-logFile",
    path.join(root, "unity-app-import.log"),
  ]);
  const importedState = await waitForWorkspace(
    (w) =>
      w.deliveries.some(
        (item) => item.id === delivery.id && item.status !== "queued",
      ),
    45000,
  );
  const imported = importedState.deliveries.find(
    (item) => item.id === delivery.id,
  )!;
  verifyDelivery(imported);
  assert.equal(
    importedState.tasks.find((task) => task.id === firstTaskId)?.status,
    "review",
  );
  const guid = imported.guid;
  const prefabMeta = path.join(unity, imported.prefabPath! + ".meta");
  const generatedPrefabHash = sha(path.join(unity, imported.prefabPath!));
  const userPrefabHash = sha(path.join(unity, imported.userPrefabPath!));
  const metaHash = sha(prefabMeta);
  assert.equal(
    importedState.objects.find((item) => item.id === objectId)?.accepted[
      "model:main"
    ],
    version.id,
  );
  await page.locator(".gs-target").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, "graphics-unity-app-imported.png"),
    fullPage: false,
  });
  await closeApp();
  await launch();
  await openProject();
  const afterRestart = await workspace();
  assert.equal(
    afterRestart.tasks.find((task) => task.id === firstTaskId)?.status,
    "review",
  );
  assert.deepEqual(
    afterRestart.deliveries.find((item) => item.id === delivery.id),
    imported,
  );
  await verifyOriginals();
  const secondTaskId = await prepareUnity();
  const reusedState = await waitForWorkspace(
    (w) =>
      w.tasks.some(
        (task) =>
          task.id === secondTaskId &&
          ["review", "failed"].includes(task.status),
      ),
    60000,
  );
  const secondTask = reusedState.tasks.find(
    (task) => task.id === secondTaskId,
  )!;
  assert.equal(secondTask.status, "review", secondTask.message);
  assert.equal(secondTask.deliveryId, delivery.id);
  const reused = reusedState.deliveries.find(
    (item) => item.id === delivery.id,
  )!;
  verifyDelivery(reused);
  assert.equal(reused.guid, guid);
  assert.equal(reused.prefabPath, imported.prefabPath);
  assert.equal(reused.userPrefabPath, imported.userPrefabPath);
  assert.equal(
    reusedState.deliveries.filter((item) => item.objectId === objectId).length,
    1,
    "same input does not duplicate Unity deliveries",
  );
  assert.equal(sha(prefabMeta), metaHash);
  assert.equal(
    sha(path.join(unity, imported.prefabPath!)),
    generatedPrefabHash,
  );
  assert.equal(sha(path.join(unity, imported.userPrefabPath!)), userPrefabHash);
  await verifyOriginals();
  await closeApp();
  await launch();
  await openProject();
  const final = await workspace();
  assert.equal(
    final.tasks.find((task) => task.id === secondTaskId)?.status,
    "review",
  );
  assert.equal(
    final.deliveries.filter((item) => item.objectId === objectId).length,
    1,
  );
  assert.equal(
    final.deliveries.find((item) => item.id === delivery.id)?.guid,
    guid,
  );
  await verifyOriginals();
  assert.deepEqual(errors, []);
  report.secondTaskId = secondTaskId;
  report.importedDelivery = imported;
  report.guid = guid;
  report.sameInputReused = true;
  report.noDuplicateDelivery = true;
  report.sourcePreserved = true;
  report.generatedPrefabPreserved = true;
  report.userPrefabPreserved = true;
  report.restartPreserved = true;
  report.batchEditorRuns = 1;
  report.passed = true;
  report.elapsedMilliseconds = Date.now() - startedAt;
  save();
  console.log(
    JSON.stringify({
      passed: true,
      artifact,
      profile,
      projectId,
      objectId,
      deliveryId: delivery.id,
      guid,
      sameInputReused: true,
      nativeApprovals: 0,
      apiSubmissions: 0,
      playMode: false,
    }),
  );
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.elapsedMilliseconds = Date.now() - startedAt;
  save();
  console.error(
    JSON.stringify({
      passed: false,
      artifact,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  throw error;
} finally {
  await closeApp();
}
