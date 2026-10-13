import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type { Quote } from "../shared/types";
import { defaultCreation } from "../shared/graphics-creation";

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
async function fixture(t: any, fbx = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-api-")), store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const calls = { uploads: [] as string[], submits: [] as { endpoint: string; body: Record<string, unknown> }[], polls: [] as string[], downloads: [] as string[], native: 0 };
  const nativeOutput = fbx ? Buffer.from("Kaydara FBX Binary  \x00\x1a\x00original") : glb();
  let final = false;
  let balance: () => Promise<{ balance: number }> = async () => ({ balance: 1000 });
  const api = {
    balance: () => balance(),
    upload: async (file: string) => { calls.uploads.push(file); return "actual-upload-token-from-fake-boundary" + (calls.uploads.length > 1 ? `-${calls.uploads.length}` : ""); },
    submit: async (endpoint: string, body: Record<string, unknown>) => {
      calls.submits.push({ endpoint, body });
      const activeQuote = store.all<Quote>("quote").find(quote => quote.consumed);
      assert(activeQuote, "Durable paid approval must already be consumed before submit");
      return { task_id: `remote-${calls.submits.length}` };
    },
    task: async (id: string) => { calls.polls.push(id); return final ? { status: "success", credits_consumed: 20, output: { model_url: `https://cdn.tripo3d.ai/${id}.glb` } } : { status: "running", progress: 50 }; },
    download: async (url: string) => { calls.downloads.push(url); return nativeOutput; },
  } as unknown as Tripo;
  const engine = new Engine(store, api, async (id, native) => {
    const preview = native.replace(/\.fbx$/, "-preview.glb"); store.write(id, preview, glb());
    store.write(id, preview.replace(/\.glb$/, ".report.json"), JSON.stringify({ schemaVersion: 1, mode: "convert", previewOnly: true, nativeSourceSha256: sha(nativeOutput), faces: 6, triangles: 12 }));
    return preview;
  }), project = engine.create("API boundary test");
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

test("creation texture candidates quote a total and all submit before any result finishes", async t => {
  const f = await fixture(t), creation = defaultCreation('prop');
  creation.stageSettings.surface!.values = { surfaceMode: 'texture', textureMethod: 'tripo', textureSize: 4096, count: 4 };
  await f.graphics.action(f.project.id, { kind: 'update-object', objectId: f.objectId, patch: { creation } });
  const task = await f.prepare('T03'), quote = f.store.get<Quote>('quote', task.quoteId!)!;
  assert.equal(task.cost?.credits, 80);
  assert.equal(quote.request.count, 4);
  assert.equal(f.calls.submits.length, 0);
  await f.graphics.action(f.project.id, { kind: 'approve', taskId: task.id });
  const jobs = await settled(f.store, f.project.id);
  assert.equal(jobs.length, 4);
  assert(jobs.every(job => job.status === 'running' && job.request.count === 1));
  assert.equal(new Set(jobs.map(job => job.remoteId)).size, 4);
  assert.equal(f.calls.submits.length, 4);
  assert.equal(f.calls.polls.length, 0);
  assert.equal(f.calls.native, 0);
  assert(jobs.every(job => job.request.sourceId === quote.request.sourceId));
  await assert.rejects(f.graphics.action(f.project.id, { kind: 'approve', taskId: task.id }));
  assert.equal(f.calls.submits.length, 4);
  assert.throws(() => f.engine.quote(f.project.id, { kind: 'smart-uv', model: 'default', prompt: '', count: 2, sourceId: quote.request.sourceId, bake: true }), /한 번씩/);
});

async function acceptDesign(f: Awaited<ReturnType<typeof fixture>>, name = "white-rabbit") {
  const source = path.join(f.root, name + ".png");
  fs.writeFileSync(source, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(name)]));
  const state = f.graphics.importFiles(f.project.id, f.objectId, "design", [source]), version = state.versions.at(-1)!;
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: version.id });
  return version;
}

test("T03 freezes the accepted design after its model and uploads the exact original image at unchanged 20-credit cost", async t => {
  const f = await fixture(t), design = await acceptDesign(f), task = await f.prepare("T03");
  const quote = f.store.get<Quote>("quote", task.quoteId!)!;
  assert.deepEqual(task.inputVersionIds, [f.original.id, design.id]); assert.equal(task.settings.textureReference, "auto");
  assert.equal(task.cost?.credits, 20); assert.equal(quote.request.sourceId, `graphics-${f.original.id}`);
  assert.deepEqual(quote.request.sourceIds, [`graphics-${design.id}`]); assert.equal(quote.request.prompt, "");
  assert.equal(task.instruction, "A static stylized prop", "The frozen user instruction remains in task history");
  const changed = await acceptDesign(f, "new-selection"); assert.notEqual(changed.id, design.id);
  quote.expiresAt = 0; f.store.quote(quote);
  let state = await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  assert.equal(f.calls.submits.length, 0); assert.deepEqual(state.tasks[0].inputVersionIds, task.inputVersionIds); assert.equal(state.tasks[0].requestHash, task.requestHash);
  const refreshed = f.store.get<Quote>("quote", state.tasks[0].quoteId!)!; assert.deepEqual(refreshed.request, quote.request);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); const [job] = await settled(f.store, f.project.id);
  assert.deepEqual(f.calls.uploads, [f.store.file(f.project.id, f.original.files[0].path), f.store.file(f.project.id, design.files[0].path)]);
  assert.equal(sha(fs.readFileSync(f.calls.uploads[1])), design.files[0].sha256);
  assert.equal(f.calls.submits[0].body.input, "actual-upload-token-from-fake-boundary");
  assert.deepEqual(f.calls.submits[0].body.texture_prompt, { image: "actual-upload-token-from-fake-boundary-2" });
  assert.equal(f.calls.submits[0].body.texture_quality, "detailed"); assert.equal(f.calls.submits[0].body.pbr, true);
  f.complete(); await f.engine.poll(f.project.id, job.id); f.graphics.sync();
  state = f.graphics.get(f.project.id); assert.equal(state.tasks[0].status, "review");
  assert.deepEqual(state.versions.find(version => version.provenance.jobId === job.id)!.sourceVersionIds, [f.original.id, design.id]);
  assert.equal(state.objects[0].accepted["model:main"], f.original.id); assert.equal(f.calls.submits.length, 1);
  await assert.rejects(f.graphics.recover(f.project.id, task.id), /복구할 중단 작업/); assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.uploads.length, 2);
});

test("T03 explicit text mode excludes an accepted design and still uses the original model at 20 credits", async t => {
  const f = await fixture(t); await acceptDesign(f);
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { settings: { textureReference: "text" } } });
  const task = await f.prepare("T03"), quote = f.store.get<Quote>("quote", task.quoteId!)!;
  assert.deepEqual(task.inputVersionIds, [f.original.id]); assert.equal(quote.request.sourceIds, undefined); assert.equal(task.cost?.credits, 20);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await settled(f.store, f.project.id);
  assert.deepEqual(f.calls.uploads, [f.store.file(f.project.id, f.original.files[0].path)]);
  assert.deepEqual(f.calls.submits[0].body.texture_prompt, { text: "A static stylized prop" });
});

test("an older prepared T03 without reference settings never binds a later adopted design when its quote refreshes", async t => {
  const f = await fixture(t), task = await f.prepare("T03"), state = f.graphics.get(f.project.id);
  delete state.tasks[0].settings.textureReference; f.store.put("graphics", f.project.id, state);
  const before = structuredClone(state.tasks[0]), quote = f.store.get<Quote>("quote", task.quoteId!)!;
  await acceptDesign(f); quote.expiresAt = 0; f.store.quote(quote);
  const refreshed = await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  assert.deepEqual(refreshed.tasks[0].inputVersionIds, before.inputVersionIds); assert.deepEqual(refreshed.tasks[0].settings, before.settings);
  assert.equal(refreshed.tasks[0].requestHash, before.requestHash);
  assert.deepEqual(f.store.get<Quote>("quote", refreshed.tasks[0].quoteId!)!.request, quote.request);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await settled(f.store, f.project.id);
  assert.equal(f.calls.uploads.length, 1); assert.deepEqual(f.calls.submits[0].body.texture_prompt, { text: "A static stylized prop" });
});

test("T03 changed reference bytes block upload and part selection never falls back to the whole design", async t => {
  await t.test("reference hash", async t => {
    const f = await fixture(t), design = await acceptDesign(f), task = await f.prepare("T03");
    fs.appendFileSync(f.store.file(f.project.id, design.files[0].path), "changed");
    await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }), /해시/);
    assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.submits.length, 0);
  });
  await t.test("part slot", async t => {
    const f = await fixture(t); await acceptDesign(f);
    const state = f.graphics.get(f.project.id), model = state.versions.find(version => version.id === f.original.id)!;
    model.slot = "part-head"; state.objects[0].accepted["model:part-head"] = model.id; delete state.objects[0].accepted["model:main"];
    state.objects[0].settings.partId = "head"; f.store.put("graphics", f.project.id, state);
    await assert.rejects(f.prepare("T03"), /파츠에 채택한 디자인 이미지가 없습니다/);
    assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.submits.length, 0);
    state.objects[0].settings.textureReference = 'text'; f.store.put('graphics', f.project.id, state);
    const task = await f.prepare("T03"); assert.deepEqual(task.inputVersionIds, [model.id]);
    assert.equal(f.store.get<Quote>("quote", task.quoteId!)!.request.sourceIds, undefined);
  });
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

test("new API result registration rejects altered provenance or bytes and recovery never rehashes them into success", async t => {
  for (const scenario of ["native-hash", "missing-native", "missing-checkpoint", "remote-id", "remote-output", "source-hash", "source-alias", "asset-native", "asset-parent", "quote-request", "preview-hash", "legacy-preview"]) {
    await t.test(scenario, async t => {
      const f = await fixture(t, scenario === "preview-hash" || scenario === "legacy-preview"), task = await f.prepare("T01");
      await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
      const [submitted] = await settled(f.store, f.project.id); f.complete(); await f.engine.poll(f.project.id, submitted.id);
      const project = f.store.project(f.project.id), job = project.jobs[0], asset = project.assets.find(a => a.jobId === job.id)!;
      const checkpointFile = f.store.file(project.id, `checkpoints/tripo/${job.id}.json`), beforeCalls = structuredClone(f.calls);
      const native = f.store.file(project.id, job.nativeFiles![0]), preview = f.store.file(project.id, asset.file);
      if (scenario === "native-hash") fs.appendFileSync(native, "changed after backend completion");
      if (scenario === "missing-native") fs.unlinkSync(native);
      if (scenario === "missing-checkpoint") fs.unlinkSync(checkpointFile);
      if (scenario === "remote-id") job.remoteId = "remote-other";
      if (scenario === "remote-output") job.output = { model_url: "https://cdn.tripo3d.ai/other.glb" };
      if (scenario === "source-hash") fs.appendFileSync(f.store.file(project.id, f.original.files[0].path), "changed source");
      if (scenario === "source-alias") project.assets.find(a => a.id === job.request.sourceId)!.file = asset.file;
      if (scenario === "asset-native") asset.nativeFile = f.original.files[0].path;
      if (scenario === "asset-parent") asset.parentIds = ["unrelated-source"];
      if (scenario === "quote-request") {
        const quote = f.store.get<Quote>("quote", job.quoteId)!; quote.request.bake = false; f.store.quote(quote);
      }
      if (scenario === "preview-hash") fs.appendFileSync(preview, "changed preview");
      if (scenario === "legacy-preview") {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8")); delete checkpoint.results;
        fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));
      }
      f.store.save(project);
      const preserved = fs.existsSync(native) ? fs.readFileSync(native) : undefined;
      // Exercise the app-restart boundary: successful backend work has not yet
      // been registered as a Graphics version and must retain its original proof.
      const restarted = new GraphicsEngine(f.store, f.engine, { resources: path.resolve("integrations") });
      restarted.sync();
      let state = restarted.get(project.id);
      assert.equal(state.tasks[0].status, "failed"); assert.match(state.tasks[0].message, /등록 보류/);
      assert.equal(state.versions.length, 1); assert.deepEqual(state.tasks[0].outputVersionIds, []);
      await restarted.recover(project.id, task.id); state = restarted.get(project.id);
      assert.equal(state.tasks[0].status, "failed"); assert.equal(state.versions.length, 1);
      assert.deepEqual(f.calls, beforeCalls, "Registration/recovery must not GET, download, upload or submit");
      assert.equal(f.store.project(project.id).jobs[0].remoteId, job.remoteId);
      assert.equal(f.store.project(project.id).jobs[0].status, "success", "The backend journal stays truthful and untouched");
      if (preserved) assert.deepEqual(fs.readFileSync(native), preserved); else assert.equal(fs.existsSync(native), false);
    });
  }
});

test("original-only receipts remain usable and previously registered versions never get new hashes on recovery", async t => {
  const f = await fixture(t), task = await f.prepare("T01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const [job] = await settled(f.store, f.project.id); f.complete(); await f.engine.poll(f.project.id, job.id);
  const checkpointFile = f.store.file(f.project.id, `checkpoints/tripo/${job.id}.json`), checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
  delete checkpoint.results; fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));
  f.graphics.sync(); const state = f.graphics.get(f.project.id);
  assert.equal(state.tasks[0].status, "review"); const versions = structuredClone(state.versions);
  fs.appendFileSync(f.store.file(f.project.id, checkpoint.native[0].file), "changed after registration");
  state.tasks[0].status = "failed"; f.store.put("graphics", f.project.id, state);
  await f.graphics.recover(f.project.id, task.id);
  assert.deepEqual(f.graphics.get(f.project.id).versions, versions);
  assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.downloads.length, 1);
});

test("valid FBX and its hash-bound local preview register together after restart", async t => {
  const f = await fixture(t, true), task = await f.prepare("T01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const [job] = await settled(f.store, f.project.id); f.complete(); await f.engine.poll(f.project.id, job.id);
  const restarted = new GraphicsEngine(f.store, f.engine, { resources: path.resolve("integrations") }); restarted.sync();
  const state = restarted.get(f.project.id), version = state.versions.find(item => item.provenance.jobId === job.id)!;
  assert.equal(state.tasks[0].status, "review"); assert.equal(version.files.length, 3);
  assert.deepEqual(version.files.map(file => path.extname(file.path)), [".fbx", ".glb", ".json"]);
  assert.equal(version.files[0].sha256, sha(f.nativeOutput)); assert.equal(version.files[1].sha256, sha(glb()));
  const report = version.files.find(file => file.kind === "report")!;
  const reportBytes = fs.readFileSync(f.store.file(f.project.id, report.path)); assert.equal(report.sha256, sha(reportBytes));
  assert.deepEqual([JSON.parse(reportBytes.toString()).faces, JSON.parse(reportBytes.toString()).triangles], [6, 12]);
  assert.deepEqual(restarted.get(f.project.id).versions, state.versions);
  assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.downloads.length, 1);
});

test("missing, legacy or mismatched FBX statistics remain unmeasured without rebuilding or rejecting the native result", async t => {
  for (const mode of ["missing", "legacy", "source-hash", "invalid-count"]) await t.test(mode, async t => {
    const f = await fixture(t, true), task = await f.prepare("T01");
    await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
    const [job] = await settled(f.store, f.project.id); f.complete(); await f.engine.poll(f.project.id, job.id);
    const asset = f.store.project(f.project.id).assets.find(asset => asset.jobId === job.id)!;
    const file = f.store.file(f.project.id, asset.file.replace(/\.glb$/, ".report.json")), report = JSON.parse(fs.readFileSync(file, "utf8"));
    if (mode === "missing") fs.unlinkSync(file);
    else {
      if (mode === "legacy") delete report.nativeSourceSha256;
      if (mode === "source-hash") report.nativeSourceSha256 = "0".repeat(64);
      if (mode === "invalid-count") report.triangles = 1;
      fs.writeFileSync(file, JSON.stringify(report));
    }
    f.graphics.sync(); const state = f.graphics.get(f.project.id), version = state.versions.find(version => version.provenance.jobId === job.id)!;
    assert.equal(state.tasks[0].status, "review"); assert.equal(version.files.length, 2);
    assert.equal(version.files[0].sha256, sha(f.nativeOutput)); assert.equal(f.calls.submits.length, 1); assert.equal(f.calls.downloads.length, 1);
  });
});

const previewBlender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
test("native FBX preview reports original polygons and tessellated triangles without changing its source", { skip: !fs.existsSync(previewBlender) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-preview-counts-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const script = path.join(root, "fixture.py"), native = path.join(root, "source.fbx"), output = path.join(root, "model");
  fs.writeFileSync(script, `import bpy, runpy, hashlib, json\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nmesh=bpy.data.meshes.new('MixedPolygons')\nmesh.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(2,0,0),(3,0,0),(2,1,0),(4,0,0),(5,0,0),(5.5,1,0),(4.5,2,0),(3.5,1,0)],[],[(0,1,2,3),(4,5,6),(7,8,9,10,11)])\nobj=bpy.data.objects.new('MixedPolygons',mesh)\nbpy.context.collection.objects.link(obj)\nobj.select_set(True)\nbpy.context.view_layer.objects.active=obj\nnative=${JSON.stringify(native)}\nbpy.ops.export_scene.fbx(filepath=native,use_selection=True,object_types={'MESH'},use_triangles=False)\nbefore=hashlib.sha256(open(native,'rb').read()).hexdigest()\nrunpy.run_path(${JSON.stringify(path.resolve("integrations/blender/pipeline.py"))})['main']({'mode':'convert','source':native,'output':${JSON.stringify(output)},'previewOnly':True})\nassert hashlib.sha256(open(native,'rb').read()).hexdigest()==before\nassert sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')==3\n`);
  const result = spawnSync(previewBlender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(output + ".report.json", "utf8"));
  assert.deepEqual([report.faces, report.triangles, report.vertices], [3, 6, 12]); assert.equal(report.nativeSourceSha256, sha(fs.readFileSync(native)));
  const bytes = fs.readFileSync(output + ".glb"), gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  assert.equal(gltf.meshes.flatMap((mesh: any) => mesh.primitives).reduce((total: number, primitive: any) => total + gltf.accessors[primitive.indices].count / 3, 0), report.triangles);
  assert(!fs.existsSync(output + ".fbx")); assert(!fs.existsSync(output + ".blend"));
});

test("one corrupted candidate holds the entire new batch without partially registering valid siblings", async t => {
  const f = await fixture(t);
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { settings: { count: 2 } } });
  const task = await f.prepare("M03"); await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const jobs = await settled(f.store, f.project.id); f.complete();
  for (const job of jobs) await f.engine.poll(f.project.id, job.id);
  const second = f.store.project(f.project.id).jobs[1]; fs.appendFileSync(f.store.file(f.project.id, second.nativeFiles![0]), "changed");
  f.graphics.sync(); const state = f.graphics.get(f.project.id);
  assert.equal(state.tasks[0].status, "failed"); assert.equal(state.versions.length, 1); assert.deepEqual(state.tasks[0].outputVersionIds, []);
  assert.deepEqual(f.store.project(f.project.id).jobs.map(job => job.status), ["success", "success"]);
  assert.equal(f.calls.submits.length, 2); assert.equal(f.calls.downloads.length, 2);
});
