import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type { Quote } from "../shared/types";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function glb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0 }));
  const padding = (4 - json.length % 4) % 4, bytes = Buffer.alloc(20 + json.length + padding, 0x20);
  bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length + padding, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
async function settled(store: Store, id: string) {
  for (let i = 0; i < 200; i++) {
    const jobs = store.project(id).jobs;
    if (jobs.length && jobs.every(job => !["queued", "submitting"].includes(job.status))) return jobs;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error("Fake API boundary did not settle");
}
async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-api-")), store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const calls = { uploads: [] as string[], submits: [] as { endpoint: string; body: Record<string, unknown> }[], polls: [] as string[], downloads: [] as string[], native: 0 };
  const nativeOutput = glb();
  let final = false;
  let balance: () => Promise<{ balance: number }> = async () => ({ balance: 1000 });
  const api = {
    balance: () => balance(),
    upload: async (file: string) => { calls.uploads.push(file); return "actual-upload-token-from-fake-boundary"; },
    submit: async (endpoint: string, body: Record<string, unknown>) => {
      calls.submits.push({ endpoint, body });
      const activeQuote = store.all<Quote>("quote").find(quote => quote.consumed);
      assert(activeQuote, "Durable paid approval must already be consumed before submit");
      return { task_id: `remote-${calls.submits.length}` };
    },
    task: async (id: string) => { calls.polls.push(id); return final ? { status: "success", credits_consumed: 20, output: { model_url: `https://cdn.tripo3d.ai/${id}.glb` } } : { status: "running", progress: 50 }; },
    download: async (url: string) => { calls.downloads.push(url); return nativeOutput; },
  } as unknown as Tripo;
  const engine = new Engine(store, api), project = engine.create("API boundary test");
  const graphics = new GraphicsEngine(store, engine, { resources: path.resolve("integrations"), native: async () => { calls.native++; throw Error("API upload/poll/download must never dispatch GPT"); } });
  let w = await graphics.action(project.id, { kind: "create-object", name: "Static prop", objectKind: "prop" });
  const objectId = w.objects[0].id;
  w = await graphics.action(project.id, { kind: "update-object", objectId, patch: { instruction: "A static stylized prop", settings: { count: 1 } } });
  const source = path.join(root, "original.glb"); fs.writeFileSync(source, glb());
  w = graphics.importFiles(project.id, objectId, "model", [source]);
  const original = w.versions[0];
  await graphics.action(project.id, { kind: "accept", objectId, versionId: original.id });
  t.after(() => { graphics.shutdown(); store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, engine, graphics, project, objectId, original, source, calls, nativeOutput,
    setBalance: (next: typeof balance) => { balance = next; },
    complete: () => { final = true; },
    prepare: async (taskId: string) => (await graphics.action(project.id, { kind: "prepare", objectId, taskId })).tasks.at(-1)!,
  };
}

test("Smart UV uses explicit 20-credit API approval, actual upload token and /mesh/uv default+bake", async t => {
  const f = await fixture(t), originalHash = sha(fs.readFileSync(f.source));
  const task = await f.prepare("T01"), quote = f.store.get<Quote>("quote", task.quoteId!)!;
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.cost?.provider, "Tripo API");
  assert.equal(task.cost?.credits, 20);
  assert.equal(quote.estimatedCredits, 20);
  assert.equal(quote.request.kind, "smart-uv");
  assert.equal(quote.request.model, "default");
  assert.equal(quote.request.bake, true);
  assert.equal(quote.consumed, false);
  // Saving other settings and polling the coordinator cannot treat a placeholder budget as approval.
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { settings: { studioCreditLimit: 0, videoCreditLimit: 0 } } });
  f.graphics.sync();
  assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.submits.length, 0);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const jobs = await settled(f.store, f.project.id);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.calls.uploads[0], f.store.file(f.project.id, f.original.files[0].path));
  assert.equal(sha(fs.readFileSync(f.calls.uploads[0])), originalHash);
  assert.deepEqual(f.calls.submits, [{ endpoint: "/mesh/uv", body: { input: "actual-upload-token-from-fake-boundary", model: "default", bake: true } }]);
  assert(!f.calls.submits.some(call => call.endpoint === "/models/convert"));
  assert.equal(jobs[0].request.kind, "smart-uv");
  assert.equal(f.store.get<Quote>("quote", quote.id)!.consumed, true);
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }));
  assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.native, 0);
});

test("P2 count two costs 200 API credits explicitly separate from Studio and submits exactly two originals", async t => {
  const f = await fixture(t);
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { settings: { count: 2, faceLimit: 10000, quad: true } } });
  const task = await f.prepare("M03"), quote = f.store.get<Quote>("quote", task.quoteId!)!;
  assert.equal(task.cost?.credits, 200);
  assert.equal(task.cost?.provider, "Tripo API");
  assert.match(task.cost!.basis, /Studio 구독과 별도/);
  assert.equal(quote.estimatedCredits, 200);
  assert.equal(quote.request.model, "P2-20260801");
  assert.equal(quote.request.count, 2);
  assert.equal(f.calls.submits.length, 0);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const jobs = await settled(f.store, f.project.id);
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map(job => job.remoteId)).size, 2);
  assert.equal(f.calls.submits.length, 2);
  for (const request of f.calls.submits) {
    assert.equal(request.endpoint, "/generation/text-to-model");
    assert.equal(request.body.model, "P2-20260801");
    assert.equal(request.body.face_limit, 10000);
    assert.equal(request.body.quad, true);
    assert.equal(request.body.texture, false);
  }
  assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.native, 0);
});

test("API polling and original download register review without GPT, duplicate download or new submission", async t => {
  const f = await fixture(t), task = await f.prepare("T01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const [job] = await settled(f.store, f.project.id);
  await f.engine.poll(f.project.id, job.id);
  assert.equal(f.calls.downloads.length, 0);
  f.complete();
  await f.engine.poll(f.project.id, job.id);
  await f.engine.poll(f.project.id, job.id);
  f.graphics.sync(); f.graphics.sync();
  const state = f.graphics.get(f.project.id), completed = state.tasks[0];
  assert.equal(completed.status, "review");
  assert.equal(completed.outputVersionIds.length, 1);
  const output = state.versions.find(version => version.id === completed.outputVersionIds[0])!;
  assert.equal(output.provenance.type, "tripo");
  assert.equal(output.provenance.remoteId, job.remoteId);
  assert.deepEqual(output.sourceVersionIds, [f.original.id]);
  assert.equal(output.files[0].sha256, sha(f.nativeOutput));
  assert.equal(f.calls.polls.length, 2); assert.equal(f.calls.downloads.length, 1);
  assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.uploads.length, 1); assert.equal(f.calls.native, 0);
  assert.equal(state.objects[0].accepted["model:main"], f.original.id, "review never auto-adopts API output");
  assert.equal(f.store.project(f.project.id).jobs[0].credits, 20);
  assert.equal(sha(fs.readFileSync(f.store.file(f.project.id, f.original.files[0].path))), f.original.files[0].sha256);
});

test("zero API balance keeps the approved request pending without uploading or consuming its quote", async t => {
  const f = await fixture(t), task = await f.prepare("T01");
  f.setBalance(async () => ({ balance: 0 }));
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }), /현재 0.*예상 20/);
  assert.equal(f.graphics.get(f.project.id).tasks[0].status, "awaiting_approval");
  assert.equal(f.store.get<Quote>("quote", task.quoteId!)!.consumed, false);
  assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.submits.length, 0); assert.equal(f.calls.native, 0);
});

test("cancellation and a second click during balance lookup cannot submit a paid request", async t => {
  const f = await fixture(t), task = await f.prepare("T01");
  let finish!: (result: { balance: number }) => void;
  f.setBalance(() => new Promise(resolve => { finish = resolve; }));
  const running = f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }), /다른 제작/);
  await f.graphics.action(f.project.id, { kind: "cancel", taskId: task.id });
  const rejected = assert.rejects(running, /취소/);
  finish({ balance: 1000 }); await rejected;
  assert.equal(f.graphics.get(f.project.id).tasks[0].status, "cancelled");
  assert.equal(f.store.get<Quote>("quote", task.quoteId!)!.consumed, false);
  assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.submits.length, 0);
});
