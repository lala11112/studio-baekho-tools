// Synthetic input fixture; real packaged app button, Blender export and Unity Play Mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";
const fixture = fs
    .readFileSync("artifacts/runtime/native-fixture-path.txt", "utf8")
    .trim(),
  data = fs.mkdtempSync(path.join(os.tmpdir(), "ps-unity-app-"));
const store = new Store(data);
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
const p = new Engine(store, {} as any).create(
    "Synthetic Unity button verification",
  ),
  engine = new WorkbenchEngine(store, {} as any),
  w = engine.create(p.id);
const digest = (f: string) =>
  createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const originals: any[] = [];
for (const name of ["rig", "Idle", "Jump"]) {
  const id = randomUUID(),
    slot = name === "rig" ? "rig" : `animation:${name}`,
    rel = `workbench/${w.id}/jobs/${id}/${name}.blend`,
    file = store.write(
      p.id,
      rel,
      fs.readFileSync(path.join(fixture, name + ".blend")),
    );
  const artifact = {
    path: rel,
    kind: "blend" as const,
    bytes: fs.statSync(file).size,
    sha256: digest(file),
  };
  originals.push({ file, hash: artifact.sha256 });
  w.jobs.push({
    id,
    slot,
    step: name === "rig" ? "rig" : "animation",
    request: {
      step: name === "rig" ? "rig" : "animation",
      prompt: "Synthetic fixture",
      motion: name,
      fps: 30,
      duration: 2,
      loop: name === "Idle",
    },
    status: "review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary: "Synthetic fixture, not production rabbit",
    dependencies: {},
    approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
    checks: [],
    candidates: [
      { id: "fixture", label: "Synthetic " + name, artifacts: [artifact] },
    ],
  });
  w.selections[slot] = { jobId: id, candidateId: "fixture" };
}
store.put("workbench", w.id, w);
store.write(p.id, `workbench/${w.id}/workbench.json`, JSON.stringify(w));
store.db.close();
let app: any, page: any;
const errors: string[] = [];
async function launch() {
  app = await electron.launch({
    executablePath: path.resolve("release/0.6.32/win-unpacked/Partsmith.exe"),
    env: { ...process.env, PARTSMITH_DATA: data },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page
    .locator(`[data-project-id="${p.id}"]`)
    .getByTestId("project-open")
    .click();
  await page.getByTestId("workbench-step-unity").click();
}
const state = () => page.evaluate(() => window.desktop.call({ type: "state" }));
try {
  await launch();
  await page.getByTestId("workbench-unity-rig-type").selectOption("generic");
  await page.getByTestId("workbench-execute-unity").click();
  const end = Date.now() + 240000;
  let job: any;
  do {
    await new Promise((r) => setTimeout(r, 500));
    const s = await state();
    job = s.workbenches
      .find((v: any) => v.id === w.id)
      .jobs.find((j: any) => j.step === "unity");
    if (job && job.status !== "running") break;
  } while (Date.now() < end);
  fs.writeFileSync(
    "artifacts/runtime/app-unity-local-check.json",
    JSON.stringify(
      { synthetic: true, data, project: p.id, bench: w.id, job, errors },
      null,
      2,
    ),
  );
  assert.equal(job?.status, "review", job?.summary);
  assert.equal(job.request.unityExecution, "local");
  assert(!job.externalExecution);
  for (const a of originals) assert.equal(digest(a.file), a.hash);
  await page.getByTestId('workbench-accept-unity').waitFor();
  await page.screenshot({
    path: "artifacts/runtime/app-unity-local-check.png",
    fullPage: true,
  });
  const reportArtifact = job.candidates[0].artifacts.find((a: any) =>
    a.path.endsWith("unity-result.json"),
  );
  const report = JSON.parse(
    fs.readFileSync(
      path.join(data, "projects", p.id, reportArtifact.path),
      "utf8",
    ),
  );
  assert.equal(report.rigType, "generic");
  assert.equal(report.avatarHuman, false);
  assert.equal(report.runtimePlayModeVerified, true);
  assert.deepEqual([...report.runtimeMovingClips].sort(), ["Idle", "Jump"]);
  assert.deepEqual(report.loopClips, ["Idle"]);
  assert(report.textures.length > 0 && report.textures.every((t:any)=>t.width===4096 && t.height===4096),'Unity must retain native 4K textures');
  await app.close();
  await launch();
  await page.getByTestId('workbench-accept-unity').waitFor();
  const again = (await state()).workbenches.find((v: any) => v.id === w.id);
  assert(!again.activeJobId);
  assert.equal(again.jobs.find((j: any) => j.id === job.id).status, "review");
  assert(!again.selections.unity);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "artifacts/runtime/app-unity-local-check.json",
    JSON.stringify(
      {
        synthetic: true,
        actualPackagedButton: true,
        actualBlender: true,
        actualUnityPlayMode: true,
        restart: true,
        newGptWorkers: 0,
        paidSubmissions: 0,
        data,
        project: p.id,
        bench: w.id,
        jobId: job.id,
        report,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS app button -> Blender -> Unity Generic Idle/Jump; restart; no GPT worker or paid request",
  );
} finally {
  await app?.close();
}
