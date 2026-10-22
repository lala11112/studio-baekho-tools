/** Real saved FBX, isolated recovery state. Never starts service production. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
import { workbenchUsage } from "../shared/workbench-usage";
import type { Workbench } from "../shared/workbench";

const version = "0.6.31",
  projectId = "c73ee321-703d-4ad5-a595-364c1b8d6c88",
  benchId = "fa6cdada-1e5b-4298-8880-6ac5af24aef9",
  jobId = "a5d5e915-6c44-4953-85fd-119d6e570deb";
const live = path.join(process.env.APPDATA!, "partsmith"),
  data = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-model-host-"));
const relative = `projects/${projectId}/workbench/${benchId}`,
  workspace = path.join(data, relative, "jobs", jobId);
const sha = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const liveWorkspace = path.join(live, relative, "jobs", jobId),
  originalReceipt = JSON.parse(
    fs.readFileSync(path.join(liveWorkspace, "external-result.json"), "utf8"),
  );
const originalFiles = [
  path.join(live, "workbench.db"),
  path.join(live, relative, "workbench.json"),
  path.join(liveWorkspace, "external-result.json"),
  ...originalReceipt.files.map((f: any) => path.join(liveWorkspace, f.path)),
];
const hashes = originalFiles.map((file) => ({ file, sha256: sha(file) }));
fs.copyFileSync(
  path.join(live, "workbench.db"),
  path.join(data, "workbench.db"),
);
fs.cpSync(
  path.join(live, "projects", projectId),
  path.join(data, "projects", projectId),
  { recursive: true },
);
const journals = path.join(data, "workbench-chrome-journals", benchId);
fs.mkdirSync(journals, { recursive: true });
for (const suffix of [".json", ".downloads.json"])
  fs.copyFileSync(
    path.join(live, "workbench-chrome-journals", benchId, jobId + suffix),
    path.join(journals, jobId + suffix),
  );
// Only the isolated fixture is changed to reproduce loss after native download.
fs.renameSync(
  path.join(workspace, "external-result.json"),
  path.join(workspace, "external-result.before-test.json"),
);
const stateFile = path.join(journals, jobId + ".downloads.json"),
  downloadState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
downloadState.workspace = workspace;
fs.writeFileSync(stateFile, JSON.stringify(downloadState));
const store = new Store(data);
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
const bench = store.get<Workbench>("workbench", benchId)!;
assert(!bench.activeJobId);
const job = bench.jobs.find((j) => j.id === jobId)!;
assert.equal(job.status, "review");
job.status = "needs_input";
job.externalExecution!.state = "reserved";
job.candidates = [];
job.checks = [];
job.summary = "검증용 복사본: 다운로드 후 로컬 처리 복구";
store.put("workbench", benchId, bench);
fs.writeFileSync(
  path.join(data, relative, "workbench.json"),
  JSON.stringify(bench),
);
store.db.close();
const workerDirs = fs
  .readdirSync(workspace)
  .filter((n) => n.startsWith("app-worker-"));
const errors: string[] = [];
let app: Awaited<ReturnType<typeof electron.launch>>, page: any;
async function launch() {
  app = await electron.launch({
    executablePath: path.resolve(
      `release/${version}/win-unpacked/Partsmith.exe`,
    ),
    env: { ...process.env, PARTSMITH_DATA: data },
  });
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("downloads")),
    downloadState.downloads,
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page
    .locator(`[data-testid="project-card"][data-project-id="${projectId}"]`)
    .getByTestId("project-open")
    .click();
  await page.getByTestId("workbench-step-parts").click();
}
const state = async () =>
  page.evaluate(() => (window as any).desktop.call({ type: "state" }));
try {
  await launch();
  await page.getByTestId("workbench-external-recover").click();
  let completed: any;
  const deadline = Date.now() + 120000;
  do {
    completed = (await state()).workbenches
      .find((w: any) => w.id === benchId)
      .jobs.find((j: any) => j.id === jobId);
    if (
      completed.externalExecution?.worker?.attempt === 6 &&
      completed.status !== "running"
    )
      break;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  assert.equal(completed.status, "review", completed.summary);
  await page.getByTestId("workbench-accept-model").waitFor();
  let current = (await state()).workbenches.find((w: any) => w.id === benchId),
    result = current.jobs.find((j: any) => j.id === jobId);
  assert.equal(result.status, "review");
  assert.equal(result.externalExecution.state, "received");
  assert.equal(result.externalExecution.worker.localOnly, true);
  assert.equal(result.externalExecution.worker.attempt, 6);
  assert.equal(current.selections["model:whole"], undefined);
  assert.deepEqual(
    fs.readdirSync(workspace).filter((n) => n.startsWith("app-worker-")),
    workerDirs,
  );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(workspace, "external-result.json"), "utf8"),
  );
  for (const file of receipt.files)
    assert.equal(sha(path.join(workspace, file.path)), file.sha256);
  const reportFile = receipt.files.find((f: any) =>
    f.path.endsWith("inspection.json"),
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(workspace, reportFile.path), "utf8"),
  );
  assert.equal(report.vertices, 9844);
  assert.equal(report.faces, 10297);
  assert.equal(report.quads, 9038);
  assert.equal(report.geometryEdited, false);
  const usage = workbenchUsage(result);
  assert.equal(usage.total, 3419412);
  assert.equal(usage.local, 1);
  assert.equal(usage.measured, 5);
  const usagePanel = page
    .getByTestId("workbench-usage")
    .filter({ hasText: "기록된 실행 5회" });
  await usagePanel.locator("summary").click();
  assert((await usagePanel.innerText()).includes("3,419,412"));
  await page.locator("canvas").first().waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: "artifacts/runtime/model-host-package.png",
    fullPage: true,
  });
  const derivativeHashes = receipt.files.map((f: any) => ({
    file: path.join(workspace, f.path),
    sha256: f.sha256,
  }));
  await app!.close();
  await launch();
  await page.getByTestId("workbench-accept-model").waitFor();
  current = (await state()).workbenches.find((w: any) => w.id === benchId);
  result = current.jobs.find((j: any) => j.id === jobId);
  assert(!current.activeJobId);
  assert.equal(result.status, "review");
  assert.equal(result.externalExecution.worker.attempt, 6);
  assert.equal(current.selections["model:whole"], undefined);
  for (const h of [...hashes, ...derivativeHashes])
    assert.equal(sha(h.file), h.sha256);
  assert.deepEqual(
    fs.readdirSync(workspace).filter((n) => n.startsWith("app-worker-")),
    workerDirs,
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "artifacts/runtime/model-host-package.json",
    JSON.stringify(
      {
        version,
        at: new Date().toISOString(),
        isolated: true,
        realSavedFbx: true,
        appButton: true,
        restart: true,
        newWorkers: 0,
        paidSubmissions: 0,
        report,
        usage,
        liveFilesUnchanged: true,
        pageErrors: errors,
        data,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      version,
      appButton: true,
      realSavedFbx: true,
      restart: true,
      newWorkers: 0,
      paidSubmissions: 0,
      faces: report.faces,
      usage,
      data,
    }),
  );
} finally {
  await app!?.close().catch(() => {});
}
