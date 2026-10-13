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
import type { GraphicsNativeArgs, GraphicsNativeResult } from "../engine/graphics-native";
import type { GraphicsRole, GraphicsTask } from "../shared/graphics";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function idle(graphics: GraphicsEngine, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!graphics.isActive(id)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error("Test native worker did not settle");
}
async function apiSettled(store: Store, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const jobs = store.project(id).jobs;
    if (jobs.length && jobs.every(job => !["queued", "submitting"].includes(job.status))) return jobs;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error("Test API boundary did not settle");
}
async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-workspace-"));
  const opened = new Set<Store>(), controllers: GraphicsEngine[] = [];
  let store = new Store(root); await store.open(wasm); opened.add(store);
  const calls = { native: [] as GraphicsNativeArgs[], uploads: [] as string[], submissions: [] as { endpoint: string; body: unknown }[], polls: 0 };
  const tripo = {
    balance: async () => ({ balance: 1000 }),
    upload: async (file: string) => { calls.uploads.push(file); return "test-upload-token"; },
    submit: async (endpoint: string, body: unknown) => { calls.submissions.push({ endpoint, body }); return { task_id: "test-remote-" + calls.submissions.length }; },
    task: async () => { calls.polls++; return { status: "running", progress: 10 }; },
    download: async () => { throw Error("No network downloads in coordinator tests"); },
  } as unknown as Tripo;
  let engine = new Engine(store, tripo);
  const project = engine.create("Isolated graphics tests");
  let nativeImplementation = async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    const rel = `graphics/test-results/${args.task.id}.png`;
    store.write(project.id, rel, png);
    return { files: [{ path: rel, kind: "image" }], role: "design", slot: "main", label: "Test output", warnings: [] };
  };
  const executeFixture = async (args: GraphicsNativeArgs) => { calls.native.push(args); return nativeImplementation(args); };
  const options = { resources: path.resolve("integrations"), native: executeFixture, astra: executeFixture };
  let graphics = new GraphicsEngine(store, engine, options); controllers.push(graphics);
  const initial = await graphics.action(project.id, { kind: "create-object", name: "Greatsword", objectKind: "weapon" });
  const objectId = initial.objects[0].id;
  await graphics.action(project.id, { kind: "update-object", objectId, patch: { instruction: "A greatsword that matches the reference", selectedTasks: ["I01"] } });
  t.after(async () => {
    for (const controller of controllers) controller.shutdown();
    for (const controller of controllers) await idle(controller, project.id);
    for (const current of opened) current.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, project, objectId, calls,
    get store() { return store; }, get engine() { return engine; }, get graphics() { return graphics; },
    setNative: (implementation: typeof nativeImplementation) => { nativeImplementation = implementation; },
    state: () => graphics.get(project.id),
    async importSource(role: GraphicsRole = "design", name = "reference.png") {
      const source = path.join(root, name); fs.writeFileSync(source, role === "design" ? png : Buffer.from("synthetic model bytes for coordinator boundary"));
      const w = graphics.importFiles(project.id, objectId, role, [source]);
      return { source, version: w.versions.at(-1)! };
    },
    async prepare(taskId: string): Promise<GraphicsTask> {
      return (await graphics.action(project.id, { kind: "prepare", objectId, taskId })).tasks.at(-1)!;
    },
    async reopen() {
      assert.equal(graphics.isActive(project.id), false, "Only reopen after the injected worker is idle");
      graphics.shutdown(); controllers.splice(controllers.indexOf(graphics), 1); store.db.close(); opened.delete(store);
      store = new Store(root); await store.open(wasm); opened.add(store);
      engine = new Engine(store, tripo);
      graphics = new GraphicsEngine(store, engine, options); controllers.push(graphics);
      return graphics.get(project.id);
    },
  };
}

test("missing-surface repair freezes an unaccepted same-object candidate without replacing adopted geometry", async t => {
  const f = await fixture(t), adopted = await f.importSource("model", "accepted.blend"), candidate = await f.importSource("model", "candidate.blend");
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: adopted.version.id });
  const update = (settings: Record<string, string | number>) => f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { selectedTasks: ["M09"], instruction: "Fill the missing scalp only, retain the original face and neck opening", settings: { partId: '', ...settings } } });
  await update({ sourceVersionId: "missing" });
  await assert.rejects(f.prepare("M09"), /모델 후보/);
  await update({ sourceVersionId: candidate.version.id, partId: "head" });
  await assert.rejects(f.prepare("M09"), /현재 파츠/);
  await update({ sourceVersionId: candidate.version.id, meshSelectionVersionId: adopted.version.id });
  await assert.rejects(f.prepare("M09"), /원본과 현재/);
  await update({ sourceVersionId: candidate.version.id, meshSelectionVersionId: candidate.version.id });
  const task = await f.prepare("M09");
  assert.equal(task.cost?.provider, "Codex"); assert.equal(task.cost?.credits, null);
  assert.deepEqual(task.inputVersionIds, [candidate.version.id]);
  assert.equal(task.settings.sourceVersionId, candidate.version.id);
  assert.equal(f.state().objects[0].accepted["model:main"], adopted.version.id);
  assert.equal(f.calls.native.length + f.calls.uploads.length + f.calls.submissions.length, 0);
  await update({ sourceVersionId: adopted.version.id });
  f.setNative(async args => {
    assert.equal(args.task.settings.sourceVersionId, candidate.version.id);
    assert.equal(args.inputs[0].id, candidate.version.id);
    assert.equal(args.task.objectSnapshot?.accepted["model:main"], adopted.version.id);
    const rel = "graphics/test-results/repaired.blend"; f.store.write(f.project.id, rel, Buffer.from("repaired fixture"));
    return { files: [{ path: rel, kind: "blend" }], role: "model", slot: "main", label: "repair", warnings: [] };
  });
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().tasks.at(-1)!.status, "review");
  assert.equal(f.state().objects[0].accepted["model:main"], adopted.version.id);
  assert.equal(digest(candidate.source), candidate.version.files[0].sha256);
  assert.equal(f.calls.uploads.length + f.calls.submissions.length, 0);
});

test("completed parts refresh is explicit, local-only, preserves adoption/history and deduplicates unchanged derivatives", async t => {
  const f = await fixture(t), source = await f.importSource("model", "source.blend");
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: source.version.id });
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { selectedTasks: ["M07"], settings: { requestedParts: JSON.stringify([{ id: "a", label: "A" }, { id: "b", label: "B" }]) } } });
  let revision = 1, fail = false;
  f.setNative(async args => {
    if (args.refreshDerivatives) assert.equal(args.recoveryOnly, true);
    if (fail) throw Error("local export failed");
    const candidates = ["a", "b"].map(slot => {
      const rel = `graphics/test-results/${revision}-${slot}.glb`;
      if (!fs.existsSync(f.store.file(f.project.id, rel))) f.store.write(f.project.id, rel, Buffer.from(`fixture ${revision} ${slot}`));
      return { files: [{ path: rel, kind: "model" }], role: "model" as const, slot: `part-${slot}`, label: slot, warnings: [] };
    });
    return { candidates, files: candidates.flatMap(c => c.files), role: "model", slot: "main", label: "parts", warnings: [] };
  });
  const task = await f.prepare("M07");
  await assert.rejects(f.graphics.action(f.project.id, { kind: "refresh-parts", taskId: task.id }), /완료된 파츠/);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await idle(f.graphics, f.project.id);
  const original = structuredClone(f.state().versions), adopted = original.at(-1)!;
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: adopted.id });
  const accepted = structuredClone(f.state().objects[0].accepted);
  revision = 2;
  await f.graphics.action(f.project.id, { kind: "refresh-parts", taskId: task.id });
  await assert.rejects(f.graphics.action(f.project.id, { kind: "refresh-parts", taskId: task.id }));
  await idle(f.graphics, f.project.id);
  assert.equal(f.state().versions.length, original.length + 2);
  assert.deepEqual(f.state().versions.slice(0, original.length), original);
  assert.deepEqual(f.state().objects[0].accepted, accepted);
  assert.equal(f.state().tasks[0].requestHash, task.requestHash);
  assert.equal(f.state().tasks[0].derivativeRefreshRequested, undefined);
  await f.graphics.action(f.project.id, { kind: "refresh-parts", taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().versions.length, original.length + 2);
  fail = true;
  await f.graphics.action(f.project.id, { kind: "refresh-parts", taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().tasks[0].status, "failed");
  assert.equal(f.state().tasks[0].derivativeRefreshRequested, true);
  await f.reopen(); fail = false;
  await f.graphics.action(f.project.id, { kind: "recover", taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().tasks[0].status, "review");
  assert.equal(f.state().versions.length, original.length + 2);
  assert.deepEqual(f.state().objects[0].accepted, accepted);
  assert(f.calls.native.slice(1).every(args => args.recoveryOnly && args.refreshDerivatives));
  assert.equal(f.calls.uploads.length + f.calls.submissions.length, 0);
  for (const version of original) for (const file of version.files) assert.equal(digest(f.store.file(f.project.id, file.path)), file.sha256);
});

test("pending approval survives 31 minutes and Store/GraphicsEngine restart without native or paid execution", async t => {
  const f = await fixture(t);
  const pending = await f.prepare("I01");
  assert.equal(pending.status, "awaiting_approval");
  const saved = structuredClone(f.state());
  const future = Date.now() + 31 * 60_000;
  t.mock.method(Date, "now", () => future);
  const reopened = await f.reopen();
  assert.deepEqual(reopened, saved);
  assert.equal(reopened.tasks[0].requestHash, pending.requestHash);
  assert.equal(f.calls.native.length, 0);
  assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.calls.submissions.length, 0);
  f.graphics.sync();
  assert.equal(f.calls.native.length, 0);
});

test("settings, task selection, import and acceptance never execute; explicit approval calls the frozen native request once", async t => {
  const f = await fixture(t), imported = await f.importSource();
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: imported.version.id });
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { selectedTasks: ["I03", "A05"], settings: { count: 1 }, instruction: "Preserve shape; recolor hilt" } });
  const task = await f.prepare("I03");
  await f.graphics.action(f.project.id, { kind: "update-object", objectId: f.objectId, patch: { selectedTasks: ["I01"], settings: { count: 4 }, instruction: "Unapproved later text" } });
  assert.equal(f.calls.native.length, 0);
  assert.equal(f.calls.submissions.length, 0);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  await idle(f.graphics, f.project.id);
  assert.equal(f.calls.native.length, 1);
  const dispatched = f.calls.native[0];
  assert.equal(dispatched.task.instruction, "Preserve shape; recolor hilt");
  assert.equal(dispatched.task.settings.count, 1);
  assert.deepEqual(dispatched.inputs.map(version => version.id), [imported.version.id]);
  assert.equal(f.state().tasks[0].status, "review");
  assert.equal(f.state().objects[0].accepted["design:main"], imported.version.id, "result review must not auto-adopt");
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }), /승인 대기/);
  await f.reopen();
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.submissions.length, 0);
});

test("failed image revision preserves accepted version, original bytes and complete result history", async t => {
  const f = await fixture(t), imported = await f.importSource();
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: imported.version.id });
  const first = await f.prepare("I03");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: first.id }); await idle(f.graphics, f.project.id);
  const firstVersion = f.state().versions.find(version => version.id === f.state().tasks[0].outputVersionIds[0])!;
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: firstVersion.id });
  const preserved = structuredClone(f.state().versions);
  f.setNative(async () => { throw Error("Native capability unavailable; no output"); });
  const revision = await f.prepare("I03");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: revision.id }); await idle(f.graphics, f.project.id);
  const state = f.state();
  assert.equal(state.tasks.at(-1)!.status, "failed");
  assert.deepEqual(state.tasks.at(-1)!.outputVersionIds, []);
  assert.deepEqual(state.versions, preserved);
  assert.equal(state.objects[0].accepted["design:main"], firstVersion.id);
  for (const version of preserved) for (const file of version.files) assert.equal(digest(f.store.file(f.project.id, file.path)), file.sha256);
  assert.deepEqual((await f.reopen()).versions, preserved);
  assert.equal(f.calls.native.length, 2);
});

test("cancelled native task persists through restart and cannot be approved or recovered", async t => {
  const f = await fixture(t);
  f.setNative(args => new Promise((_resolve, reject) => args.signal.addEventListener("abort", () => reject(Error("Stopped injected worker")), { once: true })));
  const task = await f.prepare("I01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  assert.equal(f.calls.native.length, 1);
  await f.graphics.action(f.project.id, { kind: "cancel", taskId: task.id }); await idle(f.graphics, f.project.id);
  const reopened = await f.reopen();
  assert.equal(reopened.tasks[0].status, "cancelled");
  assert.equal(reopened.versions.length, 0);
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }));
  await assert.rejects(f.graphics.action(f.project.id, { kind: "recover", taskId: task.id }));
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.submissions.length, 0);
});

test("Tripo quote expiry refreshes only; renewed explicit approval consumes its quote exactly once", async t => {
  const f = await fixture(t);
  const pending = await f.prepare("M03"), oldQuote = f.store.get<Quote>("quote", pending.quoteId!)!;
  assert.equal(oldQuote.consumed, false);
  assert.equal(f.calls.submissions.length, 0);
  const future = Date.now() + 31 * 60_000; t.mock.method(Date, "now", () => future);
  await f.reopen();
  const refreshed = await f.graphics.action(f.project.id, { kind: "approve", taskId: pending.id });
  const task = refreshed.tasks[0], quote = f.store.get<Quote>("quote", task.quoteId!)!;
  assert.equal(task.status, "awaiting_approval");
  assert.notEqual(task.quoteId, oldQuote.id);
  assert.equal(quote.consumed, false);
  assert(quote.expiresAt > future);
  assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.calls.submissions.length, 0);
  assert.equal(f.calls.native.length, 0);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id });
  const jobs = await apiSettled(f.store, f.project.id);
  assert.equal(f.store.get<Quote>("quote", quote.id)!.consumed, true);
  assert.equal(f.store.get<Quote>("quote", oldQuote.id)!.consumed, false);
  assert.equal(f.calls.submissions.length, 1);
  assert.equal(f.calls.submissions[0].endpoint, "/generation/text-to-model");
  assert.equal(jobs.length, 1);
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }));
  assert.throws(() => f.engine.approve(quote.id, false), /이미 사용/);
  await f.reopen(); f.graphics.sync();
  assert.equal(f.calls.submissions.length, 1);
  assert.equal(f.state().tasks[0].backendJobIds[0], jobs[0].id);
});

test("import hashes bind copied originals and changed bytes stop acceptance and approval before upload", async t => {
  const f = await fixture(t), imported = await f.importSource();
  const copied = f.store.file(f.project.id, imported.version.files[0].path);
  assert.notEqual(copied, imported.source);
  assert.equal(digest(copied), digest(imported.source));
  assert.equal(fs.statSync(copied).size, imported.version.files[0].bytes);
  fs.appendFileSync(imported.source, "external source changed");
  assert.equal(digest(copied), imported.version.files[0].sha256, "imported project copy remains immutable when outside source changes");
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: imported.version.id });
  const task = await f.prepare("M01");
  fs.appendFileSync(copied, "tampered project copy");
  await assert.rejects(f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }), /원본 해시/);
  await assert.rejects(f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: imported.version.id }), /원본 해시/);
  assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.calls.submissions.length, 0);
  assert.equal(f.calls.native.length, 0);
});

test("static prop model can enter local export directly without rig or animation tasks", async t => {
  const f = await fixture(t), imported = await f.importSource("model", "static-prop.glb");
  await f.graphics.action(f.project.id, { kind: "accept", objectId: f.objectId, versionId: imported.version.id });
  f.setNative(async args => {
    assert.equal(args.task.taskId, "X04");
    assert.deepEqual(args.inputs.map(version => version.id), [imported.version.id]);
    const rel = `graphics/test-results/${args.task.id}.glb`; f.store.write(f.project.id, rel, "test local export boundary");
    return { files: [{ path: rel, kind: "model" }], role: "model", slot: "main", label: "Static export", warnings: ["Synthetic boundary only"] };
  });
  const task = await f.prepare("X04");
  assert.equal(task.localOnly, true);
  assert.equal(task.cost?.credits, 0);
  assert.deepEqual(task.inputVersionIds, [imported.version.id]);
  assert.equal(f.state().tasks.length, 1);
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await idle(f.graphics, f.project.id);
  const state = f.state();
  assert.equal(state.tasks[0].status, "review");
  assert(!state.tasks.some(item => /^R|^N/.test(item.taskId)));
  assert(!state.versions.some(version => ["rig", "animation"].includes(version.role)));
  assert.equal(f.calls.submissions.length, 0);
});

test("running native job found on restart becomes uncertain and never launches automatically", async t => {
  const f = await fixture(t), task = await f.prepare("I01");
  const saved = f.state(); saved.tasks[0].status = "running";
  f.store.put("graphics", f.project.id, saved);
  const reopened = await f.reopen();
  assert.equal(reopened.tasks[0].id, task.id);
  assert.equal(reopened.tasks[0].status, "submission_unknown");
  assert.equal(f.calls.native.length, 0);
  assert.equal(f.calls.submissions.length, 0);
  assert.equal(f.calls.uploads.length, 0);
});

test("saved native recovery waits while an existing API job owns the project", async t => {
  const f = await fixture(t);
  f.setNative(async () => { throw Error("Previous native task stopped"); });
  const native = await f.prepare("I01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: native.id }); await idle(f.graphics, f.project.id);
  const api = await f.prepare("M03");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: api.id }); await apiSettled(f.store, f.project.id);
  assert.equal(f.engine.isProjectActive(f.project.id), true);
  await assert.rejects(f.graphics.action(f.project.id, { kind: "recover", taskId: native.id }), /다른 제작/);
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.submissions.length, 1);
});

test("usage audit includes native usage from failed registration and excludes unexecuted cost cards", async t => {
  const f = await fixture(t);
  f.setNative(async args => {
    f.store.write(f.project.id, `graphics/jobs/${args.task.id}/usage.json`, JSON.stringify({ input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 50 }));
    throw Error("Saved original needs registration recovery");
  });
  const task = await f.prepare("I01");
  await f.graphics.action(f.project.id, { kind: "approve", taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.deepEqual(f.state().tasks[0].usage, { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 50 });
  await f.prepare("I01");
  const audit = (await f.graphics.action(f.project.id, { kind: "audit-usage" })).usage!;
  assert.equal(audit.sampledJobs, 1); assert.equal(audit.measuredWorkers, 1);
  assert.equal(audit.inputTokens, 1500); assert.equal(audit.cachedInputTokens, 1000);
  assert.equal(audit.uncachedInputTokens, 500); assert.equal(audit.outputTokens, 50);
  assert.equal(f.calls.native.length, 1); assert.equal(f.calls.submissions.length, 0);
});
