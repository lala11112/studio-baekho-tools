import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";
import { buildWorkbenchGlb } from "./fixtures/workbench-glb";
import type { ExternalWorkbenchRunner, WorkbenchJob, WorkbenchRequest } from "../shared/workbench";

test("video route leaves cancelled static submission intact and requires app cost approval without auto resume or animation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "motion-dispatch-")), store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let runs = 0, decisions = 0;
  const runner: ExternalWorkbenchRunner = { async run(ctx) {
    runs++;
    assert.equal(ctx.job.request.motionVideo?.model, "Test video model");
    assert.deepEqual(ctx.job.request.referenceTimes, [0, 1, 2]);
    assert(ctx.inputs.some(a => a.kind === "model"));
    const answer = await ctx.requestApproval!({ id: "observed-video-cost", title: "Synthetic cost", detail: "10 test credits, no service execution", fields: [] });
    decisions++;
    assert.equal(answer.accepted, false);
    return { status: "needs_input", summary: "Declined, no submission" };
  }, verifyReceipt() { throw Error("No receipt in this test"); } };
  const executor = { execute: async () => { throw Error("Old image worker must not run"); }, hasSubmission: (j: WorkbenchJob) => j.id === "legacy-unknown" };
  const engine = new WorkbenchEngine(store, executor, { externalRunner: runner });
  t.after(() => { engine.shutdown(); store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = new Engine(store, {} as any).create("Synthetic video dispatch");
  const w = engine.create(project.id), stamp = new Date().toISOString();
  const approval = { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 };
  for (const step of ["concept", "rig"] as const) {
    const bytes = step === "rig" ? buildWorkbenchGlb(7) : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const file = `${step}.${step === "rig" ? "glb" : "png"}`;
    store.write(project.id, file, bytes);
    w.jobs.push({ id: step, step, slot: step, request: { step, prompt: "fixture" }, status: "review", createdAt: stamp, updatedAt: stamp, summary: "Synthetic prerequisite", dependencies: {}, approval, checks: [],
      candidates: [{ id: step, label: step, artifacts: [{ path: file, kind: step === "rig" ? "model" : "image", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }] });
    w.selections[step] = { jobId: step, candidateId: step };
  }
  const base: WorkbenchRequest = { step: "reference", prompt: "continuous motion", motion: "Test", duration: 2, fps: 30, referenceFrameCount: 3, referenceTimes: [0, 1, 2] };
  w.jobs.push({ id: "legacy-unknown", step: "reference", slot: "reference:Test", request: base, status: "submission_unknown", createdAt: stamp, updatedAt: stamp, summary: "Cancelled image job", dependencies: { concept: w.selections.concept, rig: w.selections.rig }, approval, candidates: [], checks: [] });
  store.put("workbench", w.id, w);
  const old = structuredClone(w.jobs.at(-1));
  assert.throws(() => engine.action(project.id, { kind: "execute", request: base, approval }), /이전 제출|이미 제출/);
  const request: WorkbenchRequest = { ...base, executionMode: "codex-app", motionVideo: { serviceUrl: "https://example.com/studio", model: "Test video model" } };
  const job = engine.action(project.id, { kind: "execute", request, approval }).jobs[0];
  for (let n = 0; n < 30 && !engine.get(w.id).jobs[0].externalExecution?.worker?.approval; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(decisions, 0); assert.equal(runs, 1);
  assert.equal(engine.get(w.id).jobs[0].externalExecution?.worker?.approval?.id, "observed-video-cost");
  engine.action(project.id, { kind: "external-approval", jobId: job.id, approvalId: "observed-video-cost", answer: { accepted: false, values: {} } });
  await engine.wait(w.id);
  assert.equal(decisions, 1);
  const restarted = new WorkbenchEngine(store, executor, { externalRunner: runner });
  assert.equal(runs, 1); assert.equal(restarted.get(w.id).activeJobId, undefined);
  assert.deepEqual(restarted.get(w.id).jobs.find(j => j.id === "legacy-unknown"), old);
  assert.throws(() => restarted.action(project.id, { kind: "execute", request, approval }), /외부 실행/);
  assert.throws(() => restarted.action(project.id, { kind: "execute", request: { step: "animation", motion: "Test", duration: 2, fps: 30, prompt: "must wait for review" }, approval }), /채택|선택/);
});
