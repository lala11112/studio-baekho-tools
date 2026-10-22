import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const version = "0.6.3";
const source = path.resolve("artifacts/runtime/guided-image-smoke/candidate.png");
const data = path.resolve("artifacts/runtime", `existing-image-package-${randomUUID()}`);
const reportFile = path.resolve("artifacts/existing-image-package-check.json");
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourceHash = digest(source);
assert.equal(fs.statSync(source).size, 1352005);
const report = {
  date: new Date().toISOString(),
  passed: false,
  version,
  source: { file: source, sha256: sourceHash, bytes: fs.statSync(source).size },
  isolatedUserData: data,
  automationSeam: "Native file-picker response selects the existing real PNG; packaged import, persistence and UI are unmodified. No worker mock.",
  limitations: [
    "Model input means the selected source shown in the whole-model UI, not an executed or frozen Tripo submission.",
    "No new image generation, Studio submission, model output, Blender, rigging or animation was tested.",
  ],
  checks: [],
  errors: [],
};
let app;
const launch = async () => {
  const current = await electron.launch({
    executablePath: path.resolve(`release/${version}/win-unpacked/Partsmith.exe`),
    env: { ...process.env, PARTSMITH_DATA: data },
  });
  await current.evaluate(({ BrowserWindow, session }) => {
    globalThis.existingImageDeniedRequests = [];
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        globalThis.existingImageDeniedRequests.push(new URL(details.url).origin);
        callback({ cancel: true });
      },
    );
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1050 });
  });
  return current;
};
const imageInfo = async (locator) => {
  await locator.waitFor();
  await locator.evaluate((img) => img.decode());
  return locator.evaluate((img) => ({
    src: img.src,
    width: img.naturalWidth,
    height: img.naturalHeight,
    complete: img.complete,
  }));
};
try {
  app = await launch();
  let page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.waitForSelector(".home");
  const info = await app.evaluate(({ app, nativeImage }, imagePath) => ({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    size: nativeImage.createFromPath(imagePath).getSize(),
  }), source);
  assert.equal(info.isPackaged, true);
  assert.equal(info.version, version);
  assert.equal(info.userData, data);
  assert.deepEqual(info.size, { width: 1024, height: 1536 });
  report.source.dimensions = info.size;
  const call = (command) => page.evaluate((c) => window.desktop.call(c), command);
  let state = await call({ type: "state" });
  assert.equal(state.key.configured, false);
  assert.equal(state.projects.length, 0);
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).first().click();
  await page.locator(".modal input[type=text],.modal input:not([type])").first().fill("기존 실제 이미지 전달 검증");
  await page.getByRole("button", { name: "프로젝트 만들기", exact: true }).click();
  await page.getByTestId("workbench").waitFor();
  const web = await call({ type: "chatgpt.status" });
  assert.equal(web.ready, false);
  assert.equal(web.opened, false);
  await app.evaluate(({ dialog }, imagePath) => {
    globalThis.existingImagePickerCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.existingImagePickerCalls++;
      return { canceled: false, filePaths: [imagePath] };
    };
  }, source);
  await page.getByRole("button", { name: "기존 이미지 가져오기", exact: true }).click();
  const candidate = page.getByTestId("workbench-candidate-0");
  const display = await imageInfo(candidate.locator("img"));
  assert.deepEqual([display.width, display.height], [1024, 1536]);
  assert.equal(await candidate.getAttribute("class"), "wb-candidate selected");
  assert.equal(await page.getByTestId("workbench-select-0").isDisabled(), true);
  state = await call({ type: "state" });
  const project = state.projects[0];
  const workbench = state.workbenches.find((w) => w.projectId === project.id);
  assert.equal(workbench.jobs.length, 1);
  const job = workbench.jobs[0];
  assert.equal(job.step, "concept");
  assert.equal(job.status, "review");
  assert.deepEqual(workbench.selections.concept, { jobId: job.id, candidateId: job.candidates[0].id });
  const image = job.candidates[0].artifacts[0];
  assert.equal(image.sha256, sourceHash);
  const root = path.join(data, "projects", project.id);
  assert.equal(digest(path.join(root, project.assets[0].file)), sourceHash);
  assert.equal(digest(path.join(root, image.path)), sourceHash);
  report.checks.push("Real original imported, copied without byte changes, decoded and visibly selected in concept UI without authenticated ChatGPT.");
  await page.screenshot({ path: "artifacts/screenshots/existing-image-concept-package.png" });
  await page.getByTestId("workbench-next-parts").click();
  assert.equal(await page.getByTestId("workbench-model-input").inputValue(), "whole");
  assert.equal(await page.getByTestId("workbench-model-role").inputValue(), "whole");
  const modelInput = await imageInfo(page.locator("img.wb-selected-source"));
  assert.equal(modelInput.src, display.src);
  report.checks.push("Whole-image modeling page displays the exact selected original as input; no model action was submitted.");
  await page.screenshot({ path: "artifacts/screenshots/existing-image-model-input-package.png" });
  report.firstRun = {
    projectId: project.id,
    workbenchId: workbench.id,
    jobId: job.id,
    selection: workbench.selections.concept,
    sourceArtifact: image,
    conceptDisplay: display,
    modelInputDisplay: modelInput,
    pickerCalls: await app.evaluate(() => globalThis.existingImagePickerCalls),
    deniedHttpOrigins: await app.evaluate(() => globalThis.existingImageDeniedRequests),
  };
  assert.equal(report.firstRun.pickerCalls, 1);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.waitForSelector(".home");
  await page.locator(`[data-testid="project-card"][data-project-id="${project.id}"]`).getByTestId("project-open").click();
  await page.getByTestId("workbench").waitFor();
  assert.equal(await page.getByTestId("workbench-model-input").inputValue(), "whole");
  const restoredInput = await imageInfo(page.locator("img.wb-selected-source"));
  assert.deepEqual(restoredInput, modelInput);
  state = await call({ type: "state" });
  const restored = state.workbenches.find((w) => w.id === workbench.id);
  assert.deepEqual(restored.selections.concept, workbench.selections.concept);
  assert.equal(restored.jobs.length, 1);
  assert.equal(restored.jobs[0].candidates[0].artifacts[0].sha256, sourceHash);
  assert.equal(digest(path.join(root, image.path)), sourceHash);
  assert.equal(digest(source), sourceHash);
  assert.equal(state.productionRuns.length, 0);
  assert.equal((await call({ type: "chatgpt.status" })).opened, false);
  assert.equal((await app.windows()).length, 1);
  assert.deepEqual(report.errors, []);
  report.checks.push("After closing and reopening the packaged app, selection, whole-model input, native dimensions and stored/original SHA-256 are unchanged.");
  report.reopened = { input: restoredInput, jobs: restored.jobs.length, browserOpened: false };
  report.generation = { newImageCalls: 0, submittedModelJobs: 0, paidRequests: 0, mockedWorkers: 0 };
  report.passed = true;
  console.log(`PASS packaged ${version}: existing real PNG → selected concept → whole-model input → persisted reopen; SHA-256 ${sourceHash}. No generation.`);
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  if (app) await app.close();
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
