import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type { GraphicsAction, GraphicsTask, GraphicsWorkspace, UnityDelivery } from "../shared/graphics";
import { defaultCreation } from "../shared/graphics-creation";
import type { Workbench, WorkbenchArtifact, WorkbenchJob } from "../shared/workbench";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const createdAt = "2026-10-13T00:00:00.000Z";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

function filesUnder(root: string): Record<string, { sha256: string; bytes: number }> {
  const result: Record<string, { sha256: string; bytes: number }> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const bytes = fs.readFileSync(absolute);
        result[path.relative(root, absolute).replaceAll("\\", "/")] = { sha256: sha(bytes), bytes: bytes.length };
      }
    }
  };
  visit(root);
  return result;
}

async function fixture(t: TestContext, withSources = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-legacy-"));
  let store = new Store(root); await store.open(wasm);
  const calls: string[] = [];
  const forbidden = async (name: string): Promise<never> => { calls.push(name); throw Error(`Unexpected execution in legacy metadata test: ${name}`); };
  const tripo = {
    balance: () => forbidden("balance"), upload: () => forbidden("upload"), submit: () => forbidden("submit"),
    task: () => forbidden("poll"), download: () => forbidden("download"),
  } as unknown as Tripo;
  let engine = new Engine(store, tripo);
  const project = engine.create("Preserved legacy project");
  let legacyActive = false;
  const options = {
    resources: path.resolve("integrations"), legacyActive: () => legacyActive,
    native: () => forbidden("native"), astra: () => forbidden("astra"), prepareUnity: () => forbidden("unity"),
  };
  let graphics = new GraphicsEngine(store, engine, options);
  const initial = await graphics.action(project.id, { kind: "create-object", name: "Independent current object", objectKind: "weapon" });
  const objectId = initial.objects[0].id;
  const external = path.join(root, "modern-original.png"); fs.writeFileSync(external, png);
  const imported = graphics.importFiles(project.id, objectId, "design", [external]);
  const modernVersionId = imported.versions[0].id;
  await graphics.action(project.id, { kind: "accept", objectId, versionId: modernVersionId });

  const artifact = (relative: string, kind: WorkbenchArtifact["kind"], bytes: Uint8Array | string): WorkbenchArtifact => {
    store.write(project.id, relative, bytes);
    return { path: relative, kind, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const reviewedJob = (id: string, artifacts: WorkbenchArtifact[], status: WorkbenchJob["status"] = "review"): WorkbenchJob => ({
    id, step: "animation", slot: "Rabbit_Idle", request: { step: "animation", prompt: "Preserve original animation" },
    status, createdAt, updatedAt: createdAt, summary: "Existing history", dependencies: {},
    approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
    candidates: [{ id: "candidate", label: id, artifacts }], checks: [],
  });
  const bench: Workbench = {
    schemaVersion: 1, id: "historical-bench", projectId: project.id, createdAt, updatedAt: createdAt,
    jobs: [], selections: {}, message: "Original history must remain unchanged",
  };
  if (withSources) {
    artifact("legacy/reference.png", "image", png);
    artifact("legacy/preview.glb", "model", "original model preview");
    artifact("legacy/native.fbx", "model", "original native model");
    const p = store.project(project.id);
    p.assets.push(
      { id: "design", kind: "image", file: "legacy/reference.png", label: "Original concept", origin: "import", createdAt },
      { id: "model", kind: "model", file: "legacy/preview.glb", nativeFile: "legacy/native.fbx", label: "Original model", origin: "tripo", createdAt, jobId: "original-tripo-job" },
      { id: "missing", kind: "image", file: "legacy/missing.png", label: "Missing old image", origin: "import", createdAt },
      { id: "graphics-owned", kind: "image", file: "legacy/reference.png", label: "Already managed by graphics", origin: "import", createdAt },
    );
    p.selectedImageId = "design"; store.save(p);
    const animation = [artifact("legacy/idle.blend", "blend", "immutable old animated blend"), artifact("legacy/idle.glb", "model", "immutable old animation preview")];
    const changed = artifact("legacy/tampered.blend", "blend", "original hash-bound data");
    fs.appendFileSync(store.file(project.id, changed.path), "changed after original receipt");
    bench.jobs = [
      reviewedJob("animation", animation), reviewedJob("tampered", [changed]),
      reviewedJob("empty", []), reviewedJob("failed", animation, "failed"),
      reviewedJob("missing", [{ path: "legacy/missing.blend", kind: "blend", sha256: sha("missing"), bytes: 7 }]),
    ];
    bench.selections["animation:Rabbit_Idle"] = { jobId: "animation", candidateId: "candidate" };
  }
  store.put("workbench", bench.id, bench);
  store.put("workbench", "unrelated-bench", { ...bench, id: "unrelated-bench", projectId: "different-project", jobs: [reviewedJob("foreign", [])] });
  t.after(() => {
    graphics.shutdown(); store.db.close();
    const resolved = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert(path.basename(resolved).startsWith("graphics-legacy-"));
    fs.rmSync(resolved, { recursive: true, force: true });
    assert.deepEqual(calls, [], "Legacy metadata operations must never call workers, providers or Unity");
  });
  return {
    root, project, objectId, modernVersionId, calls,
    get store() { return store; }, get engine() { return engine; }, get graphics() { return graphics; },
    state: () => graphics.get(project.id),
    snapshot: () => ({ state: graphics.get(project.id), files: filesUnder(root) }),
    sources: () => ({ project: store.project(project.id), benches: store.all<Workbench>("workbench"), files: Object.fromEntries(Object.entries(filesUnder(root)).filter(([relative]) => relative !== "workbench.db" && !relative.endsWith("graphics/workspace.json"))) }),
    setLegacyActive(value: boolean) { legacyActive = value; },
    saveWorkspace(w: GraphicsWorkspace) { store.put("graphics", project.id, w); store.write(project.id, "graphics/workspace.json", JSON.stringify(w, null, 2)); },
    async inspect() {
      const w = await graphics.action(project.id, { kind: "inspect-legacy" });
      assert(w.legacyPreview, "Explicit inspection must return a transient preview");
      return w.legacyPreview;
    },
    async link(versionIds?: string[]) {
      const preview = await this.inspect();
      return graphics.action(project.id, { kind: "import-legacy", versionIds: versionIds ?? preview.versions.map(v => v.id), fingerprint: preview.fingerprint });
    },
    unlink(objectId = "legacy") { return graphics.action(project.id, { kind: "unlink-legacy", objectId }); },
    async reopen() {
      graphics.shutdown(); store.db.close(); store = new Store(root); await store.open(wasm);
      engine = new Engine(store, tripo); graphics = new GraphicsEngine(store, engine, options);
      return graphics.get(project.id);
    },
  };
}

function task(objectId: string, patch: Partial<GraphicsTask> = {}): GraphicsTask {
  return {
    id: "preserved-task", objectId, taskId: "I01", createdAt, updatedAt: createdAt, status: "review",
    inputVersionIds: [], outputVersionIds: [], backendJobIds: [], settings: {}, instruction: "Existing task",
    requestHash: "frozen-existing-request", message: "Preserve this task", localOnly: false, ...patch,
  };
}
function delivery(objectId: string, versionIds: string[] = []): UnityDelivery {
  return { id: "preserved-delivery", objectId, versionIds, profileFingerprint: "unchanged", converterVersion: "fixture", createdAt, destination: "Assets/Existing", status: "imported", files: [], warnings: [], errors: [], playbackVerified: false };
}

test("legacy inspection verifies originals without changing workspace, database, original records or files", async t => {
  const f = await fixture(t), before = f.snapshot();
  const preview = await f.inspect();
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(preview.versions.map(v => v.id).sort(), ["legacy-animation-candidate", "legacy-design", "legacy-model"]);
  assert.equal(typeof preview.fingerprint, "string"); assert(preview.fingerprint.length > 0);
  assert(preview.objectName.includes(f.project.name));
  assert(preview.versions.every(v => v.objectId === "legacy" && v.provenance.type === "legacy"));
  assert.equal(preview.versions.find(v => v.id === "legacy-animation-candidate")?.slot, "Rabbit_Idle");
  assert.deepEqual(preview.versions.find(v => v.id === "legacy-model")?.files.map(file => file.path).sort(), ["legacy/native.fbx", "legacy/preview.glb"]);
  for (const version of preview.versions) for (const file of version.files) {
    const bytes = fs.readFileSync(f.store.file(f.project.id, file.path));
    assert.equal(sha(bytes), file.sha256); assert.equal(bytes.length, file.bytes);
  }
  assert.deepEqual(await f.inspect(), preview, "Repeated read-only inspection should have the same fingerprint");
  assert.equal(f.state().legacyPreview, undefined, "Preview must not become persisted workspace state");
  assert.deepEqual(await f.reopen(), before.state);
});

test("inspection of a project without a graphics workspace does not create one", async t => {
  const f = await fixture(t, false), project = f.engine.create("No linked results yet");
  const before = filesUnder(f.root);
  const result = await f.graphics.action(project.id, { kind: "inspect-legacy" });
  assert.deepEqual(result.legacyPreview?.versions, []);
  assert.deepEqual(result.objects, []); assert.deepEqual(result.versions, []); assert.equal(result.revision, 0);
  assert.equal(f.store.get("graphics", project.id), undefined);
  assert.equal(fs.existsSync(f.store.file(project.id, "graphics/workspace.json")), false);
  assert.deepEqual(filesUnder(f.root), before);
});

test("legacy import links only the explicit selection and excludes linked results from later inspections", async t => {
  const f = await fixture(t), before = f.state(), sources = f.sources();
  const first = await f.link(["legacy-model"]);
  assert.deepEqual(first.versions.filter(v => v.objectId === "legacy").map(v => v.id), ["legacy-model"]);
  assert.deepEqual(first.objects.find(o => o.id === "legacy")?.accepted, {}, "Linking never automatically adopts historical results");
  assert.deepEqual(first.objects.filter(o => o.id !== "legacy"), before.objects);
  assert.deepEqual(first.versions.filter(v => v.objectId !== "legacy"), before.versions);
  assert.deepEqual(first.tasks, before.tasks); assert.deepEqual(first.deliveries, before.deliveries);
  assert.equal(first.legacyPreview, undefined); assert.deepEqual(f.sources(), sources);
  const preview = await f.inspect();
  assert.deepEqual(preview.versions.map(v => v.id).sort(), ["legacy-animation-candidate", "legacy-design"]);
  const second = await f.link(["legacy-design"]);
  assert.equal(second.objects.filter(o => o.id === "legacy").length, 1);
  assert.deepEqual(second.versions.filter(v => v.objectId === "legacy").map(v => v.id).sort(), ["legacy-design", "legacy-model"]);
  assert.deepEqual(await f.reopen(), second); assert.deepEqual(f.sources(), sources);
});

test("legacy import rejects empty, uninspected, invalid and stale selections without partial registration", async t => {
  for (const mode of ["empty", "missing-fingerprint", "wrong-fingerprint", "unknown-id", "already-linked", "source-changed", "source-missing", "metadata-changed"] as const) {
    await t.test(mode, async t => {
      const f = await fixture(t), preview = await f.inspect();
      if (mode === "already-linked") await f.link(["legacy-model"]);
      if (mode === "source-changed") fs.appendFileSync(f.store.file(f.project.id, "legacy/native.fbx"), "changed");
      if (mode === "source-missing") fs.unlinkSync(f.store.file(f.project.id, "legacy/native.fbx"));
      if (mode === "metadata-changed") {
        const p = f.store.project(f.project.id); p.assets.find(a => a.id === "model")!.label = "Changed source label"; f.store.save(p);
      }
      const before = f.snapshot();
      const request = {
        kind: "import-legacy", versionIds: mode === "empty" ? [] : ["legacy-design", mode === "unknown-id" ? "does-not-exist" : "legacy-model"],
        ...(mode === "missing-fingerprint" ? {} : { fingerprint: mode === "wrong-fingerprint" ? "stale" : preview.fingerprint }),
      } as GraphicsAction;
      await assert.rejects(f.graphics.action(f.project.id, request));
      assert.deepEqual(f.snapshot(), before, "A rejected multi-selection must not register its otherwise-valid first result");
      if (mode !== "already-linked") assert(!f.state().objects.some(o => o.id === "legacy"));
    });
  }
});

test("an empty or unverifiable legacy history never creates an empty legacy object", async t => {
  for (const mode of ["empty", "unverifiable"] as const) await t.test(mode, async t => {
    const f = await fixture(t, mode === "unverifiable");
    if (mode === "unverifiable") {
      for (const relative of ["legacy/reference.png", "legacy/native.fbx", "legacy/idle.blend"]) fs.unlinkSync(f.store.file(f.project.id, relative));
    }
    const before = f.snapshot(), preview = await f.inspect();
    assert.deepEqual(preview.versions, []);
    await assert.rejects(f.graphics.action(f.project.id, { kind: "import-legacy", versionIds: [], fingerprint: preview.fingerprint }));
    assert.deepEqual(f.snapshot(), before); assert(!f.state().objects.some(o => o.id === "legacy"));
  });
});

test("unlink removes only legacy metadata, survives restart, and permits reconnecting the original files", async t => {
  const f = await fixture(t), original = f.state(), sources = f.sources();
  const linked = await f.link();
  await f.graphics.action(f.project.id, { kind: "accept", objectId: "legacy", versionId: "legacy-design" });
  const unlinked = await f.unlink();
  assert.deepEqual(unlinked.objects, original.objects); assert.deepEqual(unlinked.versions, original.versions);
  assert.deepEqual(unlinked.tasks, original.tasks); assert.deepEqual(unlinked.deliveries, original.deliveries);
  assert.deepEqual(f.sources(), sources); assert.equal(unlinked.legacyPreview, undefined);
  assert.deepEqual(await f.reopen(), unlinked); assert.deepEqual(f.sources(), sources);
  const preview = await f.inspect();
  assert.deepEqual(preview.versions, linked.versions.filter(v => v.objectId === "legacy"));
  const reconnected = await f.link(["legacy-design"]);
  assert.deepEqual(reconnected.objects.find(o => o.id === "legacy")?.accepted, {});
  assert.deepEqual(reconnected.versions.filter(v => v.objectId === "legacy").map(v => v.id), ["legacy-design"]);
  assert.deepEqual(f.sources(), sources);
});

test("unlink protects normal objects and a legacy object containing non-legacy versions", async t => {
  for (const mode of ["normal-object", "mixed-provenance", "missing-object"] as const) await t.test(mode, async t => {
    const f = await fixture(t); await f.link();
    if (mode === "mixed-provenance") {
      const w = f.state(); w.versions.find(v => v.objectId === "legacy")!.provenance.type = "import"; f.saveWorkspace(w);
    }
    const before = f.snapshot();
    await assert.rejects(f.unlink(mode === "normal-object" ? f.objectId : mode === "missing-object" ? "missing" : "legacy"));
    assert.deepEqual(f.snapshot(), before);
  });
});

test("unlink blocks active graphics, API, legacy workers and unresolved workspace executions", async t => {
  for (const mode of ["graphics-active", "api-active", "legacy-active", "running", "submission_unknown"] as const) await t.test(mode, async t => {
    const f = await fixture(t); await f.link();
    if (mode === "graphics-active") t.mock.method(f.graphics, "isActive", () => true);
    if (mode === "api-active") t.mock.method(f.engine, "isProjectActive", () => true);
    if (mode === "legacy-active") f.setLegacyActive(true);
    if (mode === "running" || mode === "submission_unknown") {
      const w = f.state(); w.tasks.push(task(f.objectId, { status: mode })); f.saveWorkspace(w);
    }
    const before = f.snapshot(); await assert.rejects(f.unlink()); assert.deepEqual(f.snapshot(), before);
  });
});

test("unlink refuses legacy-owned tasks or deliveries and references from other workspace records", async t => {
  const changes: [string, (w: GraphicsWorkspace, objectId: string) => void][] = [
    ["own task", w => w.tasks.push(task("legacy"))],
    ["own delivery", w => w.deliveries.push(delivery("legacy"))],
    ["object reference", (w, id) => w.objects.find(o => o.id === id)!.references.push({ versionId: "legacy-design", role: "appearance" })],
    ["object acceptance", (w, id) => { w.objects.find(o => o.id === id)!.accepted["design:other"] = "legacy-design"; }],
    ["object version setting", (w, id) => { w.objects.find(o => o.id === id)!.settings.frontVersionId = "legacy-design"; }],
    ["creation version setting", (w, id) => { const o = w.objects.find(o => o.id === id)!; o.creation = defaultCreation(o.kind); o.creation.stageSettings.model!.values.frontVersionId = "legacy-design"; }],
    ["version ancestry", (w, id) => { w.versions.find(v => v.objectId === id)!.sourceVersionIds.push("legacy-design"); }],
    ["task input", (w, id) => w.tasks.push(task(id, { inputVersionIds: ["legacy-design"] }))],
    ["task output", (w, id) => w.tasks.push(task(id, { outputVersionIds: ["legacy-design"] }))],
    ["task setting", (w, id) => w.tasks.push(task(id, { settings: { frontVersionId: "legacy-design" } }))],
    ["task frozen reference", (w, id) => w.tasks.push(task(id, { objectSnapshot: { name: "Frozen", kind: "weapon", references: [{ versionId: "legacy-design", role: "appearance" }], accepted: {} } }))],
    ["task frozen acceptance", (w, id) => w.tasks.push(task(id, { objectSnapshot: { name: "Frozen", kind: "weapon", references: [], accepted: { "design:main": "legacy-design" } } }))],
    ["task frozen clip", (w, id) => w.tasks.push(task(id, { unityClipSettings: [{ versionId: "legacy-design", name: "Idle", loop: true, rootMotion: false, fps: 30 }] }))],
    ["delivery version", (w, id) => w.deliveries.push(delivery(id, ["legacy-design"]))],
  ];
  for (const [name, change] of changes) await t.test(name, async t => {
    const f = await fixture(t); await f.link();
    const w = f.state(); change(w, f.objectId); f.saveWorkspace(w);
    const before = f.snapshot(); await assert.rejects(f.unlink()); assert.deepEqual(f.snapshot(), before);
  });
});
