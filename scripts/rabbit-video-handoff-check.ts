/** Actual accepted rabbit files through the executor; stop at a stub worker, no model/service call. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CodexWorkbenchExecutor } from "../engine/workbench-executor";
import type { Workbench, WorkbenchExecutionContext } from "../shared/workbench";
import type { ProductionWorker, WorkerTask } from "../engine/codex-worker";
const projectId = "26122336-8a7c-48b5-b15f-fa193ca157fd", workbenchId = "1839dc9e-c05b-459b-b985-6ceca49fac76";
const root = path.join(process.env.APPDATA!, "partsmith/projects", projectId), benchFile = path.join(root, "workbench", workbenchId, "workbench.json");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before = hash(benchFile);
const w: Workbench = JSON.parse(fs.readFileSync(benchFile, "utf8")); assert(!w.activeJobId);
const job = structuredClone(w.jobs.find(j => j.id === "34cc1dac-45c6-48ec-a651-532557c5d6ae")!); assert(job);
const inputs = Object.values(job.dependencies).flatMap(s => w.jobs.find(j => j.id === s.jobId)!.candidates.find(c => c.id === s.candidateId)!.artifacts);
const unique = [...new Map(inputs.map(a => [a.path, a])).values()];
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-video-handoff-")); let task: WorkerTask | undefined;
const worker: ProductionWorker = {
  probe: async () => ({ codex: { available: true, authenticated: true, message: "Local stub only" }, capabilities: { studio: false, video: true, motion: true }, message: "Local stub only" }),
  run: async value => { task = value; const result = { status: "needs_input" as const, summary: "STOP: local handoff verification only", candidates: [], checks: [] }; fs.writeFileSync(value.resultPath, JSON.stringify(result)); return { result }; }
};
const context: WorkbenchExecutionContext = { workbench: w, job, workspace, inputs: unique, signal: new AbortController().signal };
const executor = new CodexWorkbenchExecutor(worker, { projectRoot: () => root, blenderPath: () => "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe", unityPath: () => undefined, unityEditorPath: () => "", resourcesPath: path.resolve("integrations"), checkpointRoot: path.join(workspace, "checkpoints") });
await executor.execute(context, () => {}); assert(task, "Must reach the worker boundary");
const index = unique.findIndex(a => a.kind === "frames"), original = unique[index];
const manifest = JSON.parse(fs.readFileSync(path.join(workspace, `inputs/${index}-frames.json`), "utf8"));
assert.equal(manifest.mode, "side"); assert.deepEqual(Object.keys(manifest.videos), ["side"]);
const video = unique.find(a => a.kind === "video")!;
assert.equal(hash(path.join(workspace, manifest.videos.side.path)), video.sha256);
for (const frame of manifest.frames) assert(fs.existsSync(path.join(workspace, frame.side)));
for (const a of unique) assert.equal(hash(path.join(root, a.path)), a.sha256);
assert.equal(hash(benchFile), before); assert.equal(hash(path.join(root, original.path)), original.sha256);
assert(task.prompt.includes("gpt-6-astra"));
const proof = { version: "0.6.20", referenceJobId: job.dependencies["reference:Rabbit_Idle"].jobId, animationJobId: job.id, sourceInputs: unique.length, copiedVideoSha256: video.sha256, decodedFrames: manifest.frames.length, reachedStubWorker: true, astraPrompt: true, sourceFilesAndSelectionsUnchanged: true, realAstraCalls: 0, paidSubmissions: 0, workspace };
fs.writeFileSync("artifacts/runtime/rabbit-video-handoff-check.json", JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
