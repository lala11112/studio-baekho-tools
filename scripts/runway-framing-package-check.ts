/** Local framing / actual packaged UI only. No upload, worker or paid generation. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
import { renderRunwayFrame, runwayFrameLayout } from "../shared/runway-framing";
import type { Workbench } from "../shared/workbench";

const version = "0.6.19", projectId = "26122336-8a7c-48b5-b15f-fa193ca157fd", workbenchId = "1839dc9e-c05b-459b-b985-6ceca49fac76";
const project = path.join(process.env.APPDATA!, "partsmith/projects", projectId), live = path.join(project, "workbench", workbenchId, "workbench.json");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex"), before = sha(fs.readFileSync(live));
const w: Workbench = JSON.parse(fs.readFileSync(live, "utf8")); assert(!w.activeJobId && !w.jobs.some(j => j.status === "running"));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-runway-frame-"));
fs.cpSync(project, path.join(data, "projects", projectId), { recursive: true });
const store = new Store(data); await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project", projectId, JSON.parse(fs.readFileSync(path.join(project, "project.json"), "utf8"))); store.put("workbench", w.id, w); store.db.close();
const selection = w.selections["whole-reference"], candidate = w.jobs.find(j => j.id === selection.jobId)!.candidates.find(c => c.id === selection.candidateId)!;
const source = candidate.artifacts.find(a => a.kind === "image" && a.view === "left")!, original = fs.readFileSync(path.join(project, source.path));
assert.equal(sha(original), source.sha256); const png = PNG.sync.read(original), proofs: unknown[] = [], errors: string[] = [];
const launch = async () => {
  const app = await electron.launch({ executablePath: path.resolve(`release/${version}/win-unpacked/Partsmith.exe`), env: { ...process.env, PARTSMITH_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
  await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
  await page.getByTestId("workbench-step-motion").click(); await page.getByTestId("workbench-tab-reference").click();
  return { app, page };
};
let { app, page } = await launch();
try {
  for (const loop of [true, false]) {
    const label = loop ? "idle" : "jump";
    await page.getByRole("button", { name: loop ? "대기 설정" : "제자리 점프 설정", exact: true }).click();
    await page.getByTestId("motion-source-left").check();
    await page.getByTestId("workbench-approve").check(); // Local intent checkbox only; never click execution.
    await page.waitForFunction(() => !(document.querySelector('[data-testid="workbench-execute-reference"]') as HTMLButtonElement)?.disabled);
    const layout = runwayFrameLayout(png.width, png.height, loop), pixels = renderRunwayFrame(png.data, layout);
    await page.waitForFunction(({ width, height }) => { const c = document.querySelector('[data-testid="runway-frame-preview"] canvas') as HTMLCanvasElement; return c?.width === width && c?.height === height; }, layout);
    const actual = await page.getByTestId("runway-frame-preview").locator("canvas").evaluate(async (canvas: HTMLCanvasElement) => {
      const rgba = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const digest = await crypto.subtle.digest("SHA-256", rgba);
      return { width: canvas.width, height: canvas.height, rgbaSha256: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("") };
    });
    assert.equal(actual.rgbaSha256, sha(pixels));
    assert.match(await page.locator("body").innerText(), /720p \(1280×720\).*추가 예상 24크레딧/);
    const framed = new PNG({ width: layout.width, height: layout.height }); framed.data = Buffer.from(pixels);
    fs.writeFileSync(`artifacts/runtime/runway-${label}-framed.png`, PNG.sync.write(framed));
    await page.getByTestId("runway-frame-preview").screenshot({ path: `artifacts/runtime/runway-${label}-frame-preview.png` });
    proofs.push({ motion: label, layout, ...actual, sourcePreserved: true, previewMatchesUploadPixels: true, estimatedCredits: 24 });
  }
  const inspect = async () => {
    const state = await page.evaluate(() => (window as any).desktop.call({ type: "state" }));
    const observed: Workbench = state.workbenches.find((v: Workbench) => v.id === w.id);
    assert.deepEqual(observed.jobs, w.jobs); assert.deepEqual(observed.selections, w.selections); assert(!observed.activeJobId);
  };
  await inspect(); await app.close(); ({ app, page } = await launch()); await inspect();
  assert.equal(sha(fs.readFileSync(live)), before); assert.equal(sha(fs.readFileSync(path.join(project, source.path))), source.sha256);
  assert.deepEqual(errors, []);
  const result = { version, data, proofs, restartNoAutoRun: true, existingResultPreserved: true, liveDataUnchanged: true, uploads: 0, paidSubmissions: 0, errors };
  fs.writeFileSync("artifacts/runtime/runway-framing-package-check.json", JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ errors, preview: await page.getByTestId("runway-frame-preview").innerText(), buttonDisabled: await page.getByTestId("workbench-execute-reference").isDisabled() }));
  await page.screenshot({ path: "artifacts/runtime/runway-frame-package-failure.png" });
  throw error;
} finally { await app.close(); }
