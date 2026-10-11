/** Synthetic media / isolated profile only. No AI, browser worker, paid submission or live-data write. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
import { prepareMotionVideoFrames } from "../engine/motion-video-media";
import type { MotionVideoLedger } from "../engine/motion-video-ledger";
import type { Workbench, WorkbenchRequest } from "../shared/workbench";

const version = "0.6.17", projectId = "26122336-8a7c-48b5-b15f-fa193ca157fd";
const workbenchId = "1839dc9e-c05b-459b-b985-6ceca49fac76";
const source = path.join(process.env.APPDATA!, "partsmith/projects", projectId);
const liveFile = path.join(source, "workbench", workbenchId, "workbench.json");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = hash(liveFile);
const w: Workbench = JSON.parse(fs.readFileSync(liveFile, "utf8"));
assert(!w.activeJobId && !w.jobs.some(j => j.status === "running"));
const savedSelections = structuredClone(w.selections);
const data = path.resolve(`artifacts/runtime/video-package-${Date.now()}`);
fs.cpSync(source, path.join(data, "projects", projectId), { recursive: true });
const workspace = path.join(data, "projects", projectId, "workbench", w.id, "jobs", "synthetic-video");
fs.mkdirSync(workspace, { recursive: true });
const ffmpeg = path.resolve(`release/${version}/win-unpacked/resources/media/ffmpeg.exe`);
assert(fs.existsSync(ffmpeg));
const entries: ReturnType<MotionVideoLedger["read"]>["entries"] = [];
for (const [index, view] of ["front", "side", "back"].entries()) {
  const file = `${view}.mp4`;
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.2", "-vf", `hue=h=${index * 80}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(workspace, file)], { windowsHide: true });
  entries.push({ phase: view, state: "completed", cost: 0, sourceModelId: "", url: "", resultId: view, resultUrl: `https://example.com/${view}`,
    plan: { phase: view, observedCost: 0, model: "synthetic-only", duration: 2.2, resolution: "320x240", url: "", sourceModelId: "" }, download: { path: file, sha256: hash(path.join(workspace, file)) } });
}
const request: WorkbenchRequest = { step: "reference", prompt: "SYNTHETIC PLAYER TEST; NOT AI MOTION", executionMode: "codex-app",
  motion: "Package_Test", duration: 2, fps: 30, loop: false, referenceFrameCount: 3, referenceTimes: [0, 1, 2],
  motionVideo: { serviceUrl: "https://example.com/", model: "synthetic-only" } };
const result = await prepareMotionVideoFrames(ffmpeg, workspace, request, entries, new AbortController().signal);
const candidate = { id: "synthetic-video", label: "Synthetic playback only", artifacts: result.artifacts.map(a => ({ ...a,
  sha256: hash(path.join(workspace, a.path)), bytes: fs.statSync(path.join(workspace, a.path)).size,
  path: `workbench/${w.id}/jobs/synthetic-video/${a.path}` })) };
w.jobs.unshift({ id: "synthetic-video", step: "reference", slot: "reference:Package_Test", request, status: "review", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: "Synthetic video player test only",
  dependencies: { concept: w.selections.concept, rig: w.selections.rig, "whole-reference": w.selections["whole-reference"] },
  approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 }, candidates: [candidate], checks: [] });
const store = new Store(data); await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project", projectId, JSON.parse(fs.readFileSync(path.join(source, "project.json"), "utf8")));
store.put("workbench", w.id, w); store.db.close();
const errors: string[] = [];
const launch = async () => {
  const app = await electron.launch({ executablePath: path.resolve(`release/${version}/win-unpacked/Partsmith.exe`), env: { ...process.env, PARTSMITH_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("416")) errors.push(m.text()); });
  await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
  await page.getByTestId("workbench-step-motion").click();
  await page.getByTestId("workbench-tab-reference").click();
  await page.getByTestId("workbench-motion-name").fill("Package_Test");
  await page.getByRole("button", { name: "동작 영상 함께 재생" }).waitFor();
  return { app, page };
};
let { app, page } = await launch();
try {
  await page.waitForFunction(() => document.querySelectorAll('video').length === 3 && [...document.querySelectorAll('video')].every(v => v.videoWidth === 320 && v.readyState >= 2));
  assert(await page.getByTestId("workbench-tab-animation").isDisabled());
  await page.getByRole("button", { name: "동작 영상 함께 재생" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.currentTime > 0.25 && !v.paused));
  await page.getByRole("button", { name: "동작 영상 멈추기" }).click();
  await page.getByLabel("동작 영상 시점").fill("1");
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => Math.abs(v.currentTime - 1) < 0.04 && v.paused));
  const range = await page.evaluate(async () => {
    const source = document.querySelector('video')!.currentSrc;
    const r = await fetch(source, { headers: { Range: "bytes=0-31" } });
    const bad = await fetch(source, { headers: { Range: "bytes=999999999-" } });
    return { status: r.status, size: (await r.arrayBuffer()).byteLength, header: r.headers.get("content-range"), invalid: bad.status };
  });
  assert.equal(range.status, 206); assert.equal(range.size, 32); assert.equal(range.invalid, 416);
  await page.getByTestId("workbench-video-review").screenshot({ path: "artifacts/runtime/motion-video-package-player.png" });
  await app.close(); ({ app, page } = await launch());
  const state: any = await page.evaluate(() => (window as any).desktop.call({ type: "state" }));
  const restored = state.workbenches.find((x: Workbench) => x.id === w.id);
  assert.deepEqual(restored.selections, savedSelections); assert(!restored.activeJobId);
  assert.deepEqual(restored.jobs.find((j: any) => j.id === "synthetic-video").candidates, [candidate]);
  assert.equal(hash(liveFile), before); assert.deepEqual(errors, []);
  const report = { version, synthetic: true, paidSubmissions: 0, packagedDecoder: true, originalDimensions: [320, 240], threeVideosPlayedAndSeeked: true, range, restartPreserved: true, liveDataUnchanged: true, animationStarted: false, errors };
  fs.writeFileSync("artifacts/runtime/motion-video-package-check.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  console.error(await page.locator('video').evaluateAll(videos => videos.map(v => ({ src: v.currentSrc, width: v.videoWidth, readyState: v.readyState, error: v.error?.message }))));
  console.error(errors); await page.screenshot({ path: "artifacts/runtime/motion-video-package-failure.png" }); throw error;
} finally { await app.close(); }
