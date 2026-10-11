import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RunwayWorkbenchRunner } from "../engine/runway-workbench-runner";
import type { RunwayConnection, RunwayTool } from "../engine/runway-client";
import type { Workbench, WorkbenchJob, WorkbenchExecutionContext } from "../shared/workbench";
import { validateVideoSources } from "../shared/motion-video";
import { PNG } from "pngjs";

const digest = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
function setup(t: any, framed = false) {
  const fixture = new PNG({ width: 32, height: 32 }); fixture.data.fill(255);
  const sourcePng = framed ? PNG.sync.write(fixture) : png;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runway-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "jobs", "motion"); fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(root, "side.png"), sourcePng);
  const image = { path: "side.png", kind: "image" as const, role: "whole", view: "left" as const, bytes: sourcePng.length, sha256: digest(sourcePng) };
  const request = { step: "reference" as const, prompt: "fixed side rabbit idle", motion: "Rabbit_Idle", duration: 2, fps: 30, referenceFrameCount: 3, referenceTimes: [0, 1, 2], loop: true,
    motionVideo: { serviceUrl: "https://app.runwayml.com", backend: "runway-mcp" as const, mode: "side" as const, model: "gen-4.5", sourceView: "left" as const, resolution: framed ? "720p" as const : "1080p" as const, nativeDuration: 2, ...(framed ? { framing: "full-body-v1" as const } : {}) } };
  const approval = { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 };
  const packet = JSON.stringify({ jobId: "motion", request, approval }); fs.writeFileSync(path.join(workspace, "external-request.json"), packet);
  const job: WorkbenchJob = { id: "motion", step: "reference", slot: "reference:Rabbit_Idle", status: "running", createdAt: "test", updatedAt: "test", summary: "", candidates: [], checks: [], request, approval, externalExecution: { state: "reserved", requestHash: digest(packet) }, dependencies: { "whole-reference": { jobId: "views", candidateId: "accepted" } } };
  const workbench = { id: "w", projectId: "p", jobs: [{ id: "views", candidates: [{ id: "accepted", artifacts: [image] }] }], selections: {} } as Workbench;
  const controller = new AbortController();
  const ctx: WorkbenchExecutionContext = { workspace, workbench, job, inputs: [image], signal: controller.signal };
  let simulateTimeout = false, taskKind = "task_failed", submits = 0, uploads = 0, fetched = 0;
  const calls: RunwayTool[] = [];
  const connection: RunwayConnection = { open: async () => {}, close: () => {}, call: async (tool, args) => {
    calls.push(tool);
    if (tool === "whoami") return { authenticated: true, team: { id: 1 }, credits: { total: 625 }, availableVideoModels: ["gen-4.5"] };
    if (tool === "init_upload") { uploads++; const uploaded = fs.readFileSync(args.file as string); if (!framed) assert.deepEqual(uploaded, png); else { const actual = PNG.sync.read(uploaded); assert.equal(actual.width / actual.height, 16 / 9); assert(actual.height > 32); } return { kind: "upload_complete", assetUrl: "https://asset.example/original?secret=hidden" }; }
    if (tool === "generate_video") { submits++; assert.equal(args.duration, 2); assert.equal(args.model, "gen-4.5"); assert.equal(args.resolution, framed ? "720p" : "1080p"); assert.equal(args.ratio, framed ? "16:9" : undefined); if (framed) assert.match(String(args.promptText), /Both ear tips.*all four feet/); assert.equal((args.startFrame as any).url, "https://asset.example/original?secret=hidden"); if (simulateTimeout) throw Error("timeout after submit"); return { taskId: "task-1" }; }
    return { kind: taskKind, taskId: "task-1", url: "https://asset.example/video?secret=hidden" };
  } };
  const options = { journalRoot: path.join(root, "journals"), projectRoot: () => root, ffmpegPath: path.resolve("node_modules/ffmpeg-static/ffmpeg.exe"),
    encrypt: (v: string) => Buffer.from(v).toString("base64"), decrypt: (v: string) => Buffer.from(v, "base64").toString(), connection: () => connection,
    fetch: (async (_url: any, init: any) => { fetched++; if (init.method === "PUT") { assert.deepEqual(Buffer.from(init.body), png); return new Response("", { headers: { etag: '"receipt"' } }); }
      return new Response(new Uint8Array(fs.readFileSync(path.join(root, "synthetic.mp4")))) }) as typeof fetch };
  return { root, ctx, controller, options, runner: new RunwayWorkbenchRunner(options), calls,
    state: () => ({ submits, uploads, fetched }), timeout: () => { simulateTimeout = true; }, success: () => { taskKind = "video"; } };
}
test("side video manifest requires one side original; legacy three-view requirement remains", () => {
  const side = { side: { path: "side.mp4", startTime: 0 } };
  validateVideoSources(side, "side"); assert.throws(() => validateVideoSources(side));
  assert.throws(() => validateVideoSources({ ...side, front: side.side }, "side"));
});

test("full-body upload waits for a fresh 24-credit approval, preserves source and sends explicit 16:9/720p only once", async t => {
  const f = setup(t, true), original = fs.readFileSync(path.join(f.root, "side.png"));
  await f.runner.run({ ...f.ctx, requestApproval: async a => { assert.match(a.detail, /추가 예상 24크레딧/); assert.match(a.detail, /16:9 전신/); return { accepted: false, values: {} }; } }, () => {});
  assert.equal(f.state().submits, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "side.png")), original);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.ctx.workspace, "inputs/runway-framing.json"), "utf8"));
  assert.equal(metadata.sourceSha256, digest(original)); assert.notEqual(metadata.uploadSha256, metadata.sourceSha256);
  await f.runner.run({ ...f.ctx, requestApproval: async () => ({ accepted: true, values: {} }) }, () => {});
  assert.equal(f.state().submits, 1); assert.equal(f.state().uploads, 1);
});
test("upload preserves exact accepted bytes, waits for app cost approval and reuses upload on explicit continuation", async t => {
  const f = setup(t);
  const run = () => f.runner.run({ ...f.ctx, requestApproval: async a => { assert.match(a.detail, /24크레딧/); assert.match(a.detail, /실시간 견적 API는 없/); return { accepted: false, values: {} }; } }, () => {});
  assert.equal((await run()).status, "needs_input"); await run();
  assert.deepEqual(f.state(), { submits: 0, uploads: 1, fetched: 0 });
  assert(!fs.readFileSync(path.join(f.root, "journals/w/motion-state.json"), "utf8").includes("secret=hidden"));
});
test("ambiguous paid submission cannot replay after a new runner/restart", async t => {
  const f = setup(t); f.timeout(); const ctx = { ...f.ctx, requestApproval: async () => ({ accepted: true, values: {} }) };
  assert.equal((await f.runner.run(ctx, () => {})).status, "submission_unknown");
  assert.equal((await new RunwayWorkbenchRunner(f.options).run(ctx, () => {})).status, "submission_unknown");
  assert.equal(f.state().submits, 1);
});
test("Idle and Jump jobs reuse the same account/source upload but each needs its own cost approval", async t => {
  const f = setup(t); let approvals = 0;
  const requestApproval = async () => { approvals++; return { accepted: false, values: {} }; };
  await f.runner.run({ ...f.ctx, requestApproval }, () => {});
  const workspace = path.join(f.root, "jobs", "jump"); fs.mkdirSync(workspace, { recursive: true });
  const job = structuredClone(f.ctx.job); job.id = "jump"; job.request.motion = "Rabbit_Jump";
  const packet = JSON.stringify({ jobId: job.id, request: job.request, approval: job.approval });
  fs.writeFileSync(path.join(workspace, "external-request.json"), packet); job.externalExecution!.requestHash = digest(packet);
  await new RunwayWorkbenchRunner(f.options).run({ ...f.ctx, workspace, job, requestApproval }, () => {});
  assert.equal(approvals, 2); assert.equal(f.state().uploads, 1); assert.equal(f.state().submits, 0);
});
test("failed known task is only collected on continuation, never regenerated", async t => {
  const f = setup(t); const ctx = { ...f.ctx, requestApproval: async () => ({ accepted: true, values: {} }) };
  assert.equal((await f.runner.run(ctx, () => {})).status, "needs_input");
  await new RunwayWorkbenchRunner(f.options).run(ctx, () => {});
  assert.equal(f.state().submits, 1); assert.equal(f.calls.filter(x => x === "get_task").length, 2);
});

test("new Jump headroom cannot reuse Idle upload even with the same original", async t => {
  const f = setup(t, true), requestApproval = async () => ({ accepted: false, values: {} });
  await f.runner.run({ ...f.ctx, requestApproval }, () => {});
  const workspace = path.join(f.root, "jobs", "jump"); fs.mkdirSync(workspace, { recursive: true });
  const job = structuredClone(f.ctx.job); job.id = "jump"; job.request.motion = "Rabbit_Jump"; job.request.loop = false;
  const packet = JSON.stringify({ jobId: job.id, request: job.request, approval: job.approval });
  fs.writeFileSync(path.join(workspace, "external-request.json"), packet); job.externalExecution!.requestHash = digest(packet);
  await new RunwayWorkbenchRunner(f.options).run({ ...f.ctx, workspace, job, requestApproval }, () => {});
  assert.equal(f.state().uploads, 2); assert.equal(f.state().submits, 0);
  const idle = JSON.parse(fs.readFileSync(path.join(f.ctx.workspace, "inputs/runway-framing.json"), "utf8"));
  const jump = JSON.parse(fs.readFileSync(path.join(workspace, "inputs/runway-framing.json"), "utf8"));
  assert.notEqual(idle.uploadSha256, jump.uploadSha256); assert.equal(idle.sourceSha256, jump.sourceSha256);
  assert(jump.y > idle.y);
});
test("cancel at approval performs zero paid submissions", async t => {
  const f = setup(t);
  await f.runner.run({ ...f.ctx, requestApproval: async () => { f.controller.abort(); return { accepted: true, values: {} }; } }, () => {});
  assert.equal(f.state().submits, 0);
});
test("modified accepted source is rejected before any remote call", async t => {
  const f = setup(t); fs.appendFileSync(path.join(f.root, "side.png"), "changed");
  await assert.rejects(f.runner.run(f.ctx, () => {}), /해시/); assert.deepEqual(f.calls, []);
});
test("synthetic native video is decoded once into a side review receipt, never accepted or animated", async t => {
  const f = setup(t); f.success();
  execFileSync(f.options.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(f.root, "synthetic.mp4")], { windowsHide: true });
  const ctx = { ...f.ctx, requestApproval: async () => ({ accepted: true, values: {} }) };
  assert.equal((await f.runner.run(ctx, () => {})).status, "completed"); f.runner.verifyReceipt(ctx);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.ctx.workspace, "external-result.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.ctx.workspace, "outputs/video-reference/frames.json"), "utf8"));
  assert.equal(manifest.mode, "side"); assert.equal(manifest.loop, true); assert.deepEqual(Object.keys(manifest.videos), ["side"]);
  assert.equal(receipt.result.candidates[0].artifacts.filter((a: any) => a.kind === "video").length, 1);
  assert.equal(receipt.result.checks.find((c: any) => c.name === "visual_quality").passed, false);
  assert.deepEqual(f.ctx.workbench.selections, {});
  await new RunwayWorkbenchRunner(f.options).run(ctx, () => {}); assert.equal(f.state().submits, 1); assert.equal(f.state().fetched, 1);
  receipt.videos[0].resultId = "other-task"; fs.writeFileSync(path.join(f.ctx.workspace, "external-result.json"), JSON.stringify(receipt));
  assert.throws(() => f.runner.verifyReceipt(ctx), /다릅니다/);
});
