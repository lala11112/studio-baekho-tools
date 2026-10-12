// Packaged UI inspection of an already-generated native image. Never approves or recovers a task.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron, type ElectronApplication } from "playwright";
import type { AppState } from "../shared/types";

const repo = process.cwd();
const prior = JSON.parse(fs.readFileSync(path.join(repo, "artifacts/runtime/graphics-native-live.json"), "utf8"));
assert.equal(prior.passed, true);
const executablePath = path.join(repo, "release/0.7.0-preview.1/win-unpacked/Partsmith.exe");
assert(fs.existsSync(executablePath));
const workspaceFile = path.join(prior.profile, "projects", prior.projectId, "graphics/workspace.json");
const baseline = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const proofFiles = [prior.workerLogPath, prior.resultPath, prior.usagePath, prior.dispatchPath, prior.original.absolute].filter(Boolean);
const hashes = Object.fromEntries(proofFiles.map((file: string) => [file, digest(file)]));
const errors: string[] = [];
let app: ElectronApplication | undefined;
try {
  for (let run = 0; run < 2; run++) {
    const env = { ...process.env, PARTSMITH_DATA: prior.profile, PARTSMITH_DEV: "" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, env, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.locator(`[data-project-id="${prior.projectId}"]`).getByTestId("project-open").click();
    await page.getByTestId("graphics-studio").waitFor();
    await page.getByTestId(`graphics-object-${prior.objectId}`).click();
    await page.getByTestId(`graphics-version-${prior.versionId}`).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="graphics-preview"] img')].some(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth === 1024));
    await page.getByRole("button", { name: "이미지 크게 보기", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    assert.equal(await dialog.locator("img").evaluate(element => (element as HTMLImageElement).naturalHeight), 1536);
    if (run === 0) await page.screenshot({ path: path.join(repo, "artifacts/runtime/graphics-package-image.png") });
    const state = await page.evaluate(() => window.desktop.call<AppState>({ type: "state" }));
    assert.deepEqual(state.graphicsWorkspaces?.find(space => space.projectId === prior.projectId), baseline);
    assert.equal(state.projects.find(project => project.id === prior.projectId)!.jobs.length, 0);
    await app.close(); app = undefined;
  }
  for (const [file, hash] of Object.entries(hashes)) assert.equal(digest(file), hash);
  assert.deepEqual(errors, []);
  const result = { passed: true, version: "0.7.0-preview.1", executablePath, profile: prior.profile, projectId: prior.projectId, nativeTaskId: prior.taskId, originalHash: prior.original.sha256, actualPackagedApp: true, imageEnlargement: true, restartPreserved: true, unaccepted: true, additionalModelTurns: 0, paidSubmissions: 0, errors, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(repo, "artifacts/runtime/graphics-package-check.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await app?.close(); }
