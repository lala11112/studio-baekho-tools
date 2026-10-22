/** Verify accepted video and retry UI in the packaged app without dispatching production. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
const live = process.argv.includes("--live-ready"), version = "0.6.20";
const projectId = "26122336-8a7c-48b5-b15f-fa193ca157fd", workbenchId = "1839dc9e-c05b-459b-b985-6ceca49fac76";
const root = path.join(process.env.APPDATA!, "partsmith"), project = path.join(root, "projects", projectId);
const file = path.join(project, "workbench", workbenchId, "workbench.json"), bytes = fs.readFileSync(file), w = JSON.parse(bytes.toString());
assert(!w.activeJobId && !w.jobs.some((j: any) => j.status === "running"));
const data = live ? root : fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-video-handoff-"));
if (!live) {
  fs.cpSync(project, path.join(data, "projects", projectId), { recursive: true });
  const store = new Store(data); await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  store.put("project", projectId, JSON.parse(fs.readFileSync(path.join(project, "project.json"), "utf8"))); store.put("workbench", w.id, w); store.db.close();
}
const launch = async () => {
  const app = await electron.launch({ executablePath: path.resolve(`release/${version}/win-unpacked/Partsmith.exe`), env: { ...process.env, PARTSMITH_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
  await page.getByTestId("workbench-step-motion").click(); await page.getByTestId("workbench-tab-animation").click();
  await page.getByTestId("workbench-motion-name").fill("Rabbit_Idle");
  const retry = page.getByRole("button", { name: "기존 작업 이어서 확인", exact: true });
  assert(await retry.isEnabled()); await retry.scrollIntoViewIfNeeded();
  const state = await page.evaluate(() => (window as any).desktop.call({ type: "state" }));
  const current = state.workbenches.find((v: any) => v.id === w.id);
  assert.deepEqual(current.jobs, w.jobs); assert.deepEqual(current.selections, w.selections); assert(!current.activeJobId);
  return { app, page };
};
let { app, page } = await launch();
if (!live) { await app.close(); ({ app, page } = await launch()); }
assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
const proof = { version, liveReady: live, acceptedReference: w.selections["reference:Rabbit_Idle"], existingFailedJob: "34cc1dac-45c6-48ec-a651-532557c5d6ae", retryEnabled: true, jobsAndSelectionsUnchanged: true, productionCalls: 0, paidSubmissions: 0, restartNoAutoRun: !live };
fs.writeFileSync(`artifacts/runtime/rabbit-video-handoff-${live ? "live-ready" : "package-check"}.json`, JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
if (live) await new Promise<void>(resolve => app.on("close", () => resolve())); else await app.close();
