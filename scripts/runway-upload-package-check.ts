/** Real account/upload only, isolated project copy. NEVER approves a paid generation. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../engine/store";
import type { Workbench } from "../shared/workbench";

const projectId = "26122336-8a7c-48b5-b15f-fa193ca157fd", workbenchId = "1839dc9e-c05b-459b-b985-6ceca49fac76";
const source = path.join(process.env.APPDATA!, "partsmith/projects", projectId);
const liveFile = path.join(source, "workbench", workbenchId, "workbench.json");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = hash(liveFile), w: Workbench = JSON.parse(fs.readFileSync(liveFile, "utf8"));
assert(!w.activeJobId && !w.jobs.some(j => j.status === "running"));
const data = path.join(os.tmpdir(), `partsmith-runway-upload-${Date.now()}`);
fs.cpSync(source, path.join(data, "projects", projectId), { recursive: true });
const store = new Store(data); await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project", projectId, JSON.parse(fs.readFileSync(path.join(source, "project.json"), "utf8"))); store.put("workbench", w.id, w); store.db.close();
const launch = async () => {
  const app = await electron.launch({ executablePath: path.resolve("release/0.6.18/win-unpacked/Partsmith.exe"), env: { ...process.env, PARTSMITH_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
  await page.getByTestId("workbench-step-motion").click(); await page.getByTestId("workbench-tab-reference").click();
  return { app, page };
};
let { app, page } = await launch();
const state = () => page.evaluate(() => (window as any).desktop.call({ type: "state" }));
try {
  await page.getByRole("button", { name: "대기 설정", exact: true }).click();
  await page.getByTestId("motion-source-left").check();
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-reference").click();
  // Wait without repeating model/tool requests. UI approval is never clicked here.
  for (let poll = 0; poll < 180; poll++) {
    const observed: Workbench = (await state()).workbenches.find((x: Workbench) => x.id === w.id);
    const latest = observed.jobs[0];
    if (latest.request.motionVideo?.backend === "runway-mcp" && latest.externalExecution?.worker &&
      (latest.externalExecution.worker.approval || latest.status !== "running")) {
      const prompt = latest.externalExecution.worker.approval;
      if (prompt && !prompt.id.startsWith("runway-cost-")) {
        console.log(JSON.stringify({ appPermission: prompt }));
        fs.writeFileSync("artifacts/runtime/runway-pending-permission.json", JSON.stringify(prompt, null, 2));
        const answerPath = "artifacts/runtime/runway-permission-answer.json";
        for (let wait = 0; wait < 180 && !fs.existsSync(answerPath); wait++) await delay(1000);
        assert(fs.existsSync(answerPath), "Upload permission not answered");
        const answer = JSON.parse(fs.readFileSync(answerPath, "utf8")); assert.equal(answer.approvalId, prompt.id); assert.equal(answer.accepted, true);
        for (const f of prompt.fields) {
          if (f.options) await page.getByLabel(f.label).selectOption(answer.values[f.id]);
          else if (answer.values[f.id]) await page.getByLabel(f.label).fill(answer.values[f.id]);
        }
        await page.getByTestId("workbench-codex-approve").click(); continue;
      }
      console.log(JSON.stringify({ observedStatus: latest.status, summary: latest.summary, approval: prompt?.id })); break;
    }
    await delay(1000);
  }
  const current: Workbench = (await state()).workbenches.find((x: Workbench) => x.id === w.id);
  const job = current.jobs[0];
  assert.equal(job.request.motionVideo?.mode, "side");
  assert.equal(job.request.motionVideo?.sourceView, "left");
  assert.equal(job.externalExecution?.worker?.approval?.id, `runway-cost-${job.id}`, job.summary);
  const approval = job.externalExecution!.worker!.approval!;
  assert.match(approval.detail, /24크레딧/);
  const journal = path.join(data, "workbench-runway-journals", w.id, job.id);
  const checkpoint = JSON.parse(fs.readFileSync(journal + "-state.json", "utf8"));
  assert(checkpoint.assetEncrypted); assert(!checkpoint.taskId); assert(!fs.existsSync(journal + ".json"));
  assert.equal(checkpoint.sourceHash, "b96d1a200ac6c30c773a53fe9b244edc065174045bb40df4f486c1717ccc6ef6");
  await page.getByTestId("workbench-status").screenshot({ path: "artifacts/runtime/runway-upload-cost.png" });
  await page.getByTestId("workbench-codex-decline").click();
  await page.waitForFunction(async id => !(await (window as any).desktop.call({ type: "state" })).workbenches.find((w: any) => w.id === id)?.activeJobId, w.id);
  await app.close(); ({ app, page } = await launch());
  const after: Workbench = (await state()).workbenches.find((x: Workbench) => x.id === w.id);
  assert(!after.activeJobId); assert.deepEqual(after.selections, w.selections);
  assert.equal(after.jobs[0].status, "needs_input"); assert(!fs.existsSync(journal + ".json"));
  assert.equal(hash(liveFile), before);
  const report = { at: new Date().toISOString(), version: "0.6.18", data, jobId: job.id, realAccount: true,
    appButtonDispatch: true, originalUploadCompleted: true, sourceSha256: checkpoint.sourceHash, sourceBytes: 1674171,
    sourcePreserved: true, encryptedCheckpoint: true, estimatedCredits: 24, paidSubmissions: 0, uploadModelTurns: checkpoint.uploadModelTurns, uploadUsage: checkpoint.uploadUsage, orchestrationModelTurns: 0,
    costDeclinedForTest: true, restartNoAutoRun: true, selectionsPreserved: true, liveDataUnchanged: true };
  fs.writeFileSync("artifacts/runtime/runway-upload-package-check.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: "artifacts/runtime/runway-upload-failure.png" });
  const s = await state(); console.log(JSON.stringify({ data, latest: s.workbenches.find((x: Workbench) => x.id === w.id)?.jobs[0]?.summary })); throw error;
} finally { await app.close(); }
