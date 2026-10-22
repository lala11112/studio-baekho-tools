import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { GraphicsWorkspace, AssetVersion } from "../shared/graphics";
import type { Tripo } from "../engine/tripo";
import type { runGraphicsPlanar } from "../engine/graphics-planar";
test("opening existing models is idle; only a newly imported static model gets one local report-only inspection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planar-auto-")),
    store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let calls = 0,
    remote = 0,
    holdUntilCancelled = false;
  const engine = new Engine(
      store,
      new Proxy(
        {},
        {
          get: () => () => {
            remote++;
            throw Error("remote forbidden");
          },
        },
      ) as Tripo,
    ),
    project = engine.create("auto");
  const source = path.join(root, "import.fbx");
  fs.writeFileSync(source, "immutable-source");
  const existing: AssetVersion = {
    id: "old",
    objectId: "o",
    role: "model",
    slot: "main",
    label: "old",
    files: [],
    sourceVersionIds: [],
    createdAt: "old",
    provenance: { type: "import" },
    warnings: [],
  };
  const initial: GraphicsWorkspace = {
    schemaVersion: 1,
    id: project.id,
    projectId: project.id,
    revision: 0,
    objects: [
      {
        id: "o",
        name: "box",
        kind: "prop",
        createdAt: "old",
        selectedTasks: [],
        settings: {},
        instruction: "",
        references: [],
        accepted: { "model:main": "old" },
      },
    ],
    versions: [existing],
    tasks: [],
    deliveries: [],
  };
  store.put("graphics", project.id, initial);
  const local: typeof runGraphicsPlanar = async (args) => {
    calls++;
    if (holdUntilCancelled)
      await new Promise<void>((_resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
      });
    const report = {
      schemaVersion: 1,
      mode: "inspect",
      passed: true,
      identity: "auto",
      inspectionId: "auto",
      algorithmVersion: "planar-v2",
      sourceVersionId: args.sourceVersionId,
      sourceSha256: args.source.sha256,
      localOnly: true,
      modelTurns: 0,
      paidSubmissions: 0,
      meshes: [],
    };
    const data = JSON.stringify(report),
      rel = "graphics/auto-report.json";
    store.write(project.id, rel, data);
    return {
      report,
      files: [
        {
          path: rel,
          kind: "report",
          bytes: Buffer.byteLength(data),
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ],
      cached: false,
    };
  };
  const graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    planar: local,
  });
  t.after(() => {
    graphics.shutdown();
    store.db.close();
    assert.equal(
      path.dirname(fs.realpathSync(root)),
      fs.realpathSync(os.tmpdir()),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls, 0);
  assert.deepEqual(graphics.get(project.id), initial);
  graphics.importFiles(project.id, "o", "model", [source]);
  for (let i = 0; i < 30; i++) {
    if (calls && !graphics.isActive(project.id)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(calls, 1);
  const after = graphics.get(project.id);
  assert.equal(after.versions.length, 2);
  assert.deepEqual(after.versions[0], existing);
  assert.deepEqual(after.objects, initial.objects);
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].taskId, "LOCAL_PLANAR_INSPECT");
  assert.deepEqual(after.tasks[0].outputVersionIds, []);
  assert.equal(after.tasks[0].localOnly, true);
  assert.equal(remote, 0);
  assert.equal(fs.readFileSync(source, "utf8"), "immutable-source");

  // A manual inspection can start while the new-version auto queue is pending.
  holdUntilCancelled = true;
  graphics.importFiles(project.id, "o", "model", [source]);
  const imported = graphics.get(project.id).versions.at(-1)!;
  await graphics.action(project.id, { kind: "inspect-planar", versionId: imported.id });
  const manual = graphics.get(project.id).tasks.at(-1)!;
  assert.equal(calls, 2);
  await graphics.action(project.id, { kind: "cancel", taskId: manual.id });
  holdUntilCancelled = false;
  await new Promise((r) => setTimeout(r, 1100));
  const cancelled = graphics.get(project.id);
  assert.equal(calls, 2, "pending automatic inspection must not retry a cancelled manual inspection");
  assert.equal(cancelled.tasks.filter((task) => task.inputVersionIds.includes(imported.id)).length, 1);
  assert.equal(cancelled.tasks.find((task) => task.id === manual.id)!.status, "cancelled");
  assert.equal(cancelled.planarInspections?.[imported.id], undefined);
  await graphics.action(project.id, { kind: "inspect-planar", versionId: imported.id });
  for (let i = 0; i < 30 && graphics.isActive(project.id); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 3, "explicit reinspection remains allowed after cancellation");
  const reinspected = graphics.get(project.id);
  assert(reinspected.planarInspections?.[imported.id]);
  assert.deepEqual(reinspected.objects, initial.objects);
  assert.deepEqual(reinspected.versions[0], existing);
  assert.equal(remote, 0);
  assert.equal(store.project(project.id).jobs.length, 0);
  assert.equal(fs.readFileSync(source, "utf8"), "immutable-source");
});
test("planar inspection and repair preserve old records, deduplicate, remain unadopted and recover saved-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planar-coordinator-")),
    store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let remote = 0,
    runs = 0,
    fail = false,
    recoveries = 0,
    failInspect = false;
  const callsSeen: any[] = [];
  const engine = new Engine(
      store,
      new Proxy(
        {},
        {
          get: () => () => {
            remote++;
            throw Error("paid forbidden");
          },
        },
      ) as Tripo,
    ),
    project = engine.create("static");
  const file = (name: string, content = name, kind = "model") => {
    store.write(project.id, name, content);
    return {
      path: name,
      kind,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
  };
  const v: AssetVersion = {
    id: "source",
    objectId: "obj",
    role: "model",
    slot: "main",
    label: "box",
    createdAt: "old",
    files: [file("source.blend")],
    sourceVersionIds: [],
    provenance: { type: "import" },
    warnings: [],
  };
  const initial: GraphicsWorkspace = {
    schemaVersion: 1,
    id: project.id,
    projectId: project.id,
    revision: 1,
    objects: [
      {
        id: "obj",
        name: "box",
        kind: "prop",
        createdAt: "old",
        selectedTasks: [],
        instruction: "",
        settings: {},
        references: [],
        accepted: { "model:main": "source" },
      },
    ],
    versions: [v],
    tasks: [],
    deliveries: [],
  };
  store.put("graphics", project.id, initial);
  const local: typeof runGraphicsPlanar = async (args) => {
    runs++;
    callsSeen.push({
      mode: args.mode,
      recoveryOnly: args.recoveryOnly,
      inspectionAttempt: args.inspectionAttempt,
      inspectionIdentity: args.inspection?.identity,
    });
    if (args.mode === "inspect" && failInspect)
      throw Error("inspect interrupted");
    if (args.recoveryOnly) recoveries++;
    if (args.mode === "repair" && fail) throw Error("interrupted saved output");
    const report: any = {
      schemaVersion: 1,
      mode: args.mode,
      passed: true,
      identity:
        args.mode === "inspect"
          ? "native-" + args.inspectionAttempt
          : "native-id",
      sourceVersionId: args.sourceVersionId,
      sourceSha256: args.source.sha256,
      algorithmVersion: "planar-v2",
      inspectionId: "inspect1",
      localOnly: true,
      modelTurns: 0,
      paidSubmissions: 0,
      meshes: [
        {
          meshId: "m1",
          name: "box",
          boundaries: [
            {
              id: "b1",
              number: 1,
              vertexIndices: [0, 1, 2],
              kind:'loop',componentId:'component',edgeVertexPairs:[[0,1],[1,2],[2,0]],conflictsWith:[],
              worldVertices: [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
              ],
              status: "eligible",
              reasons: [],
              materialOptions: ["preserve"],
            },
          ],
        },
      ],
      warnings: [],
    };
    if (args.selection)
      Object.assign(report, args.selection, {
        checks: Object.fromEntries(
          [
            "staticOnly",
            "appendOnly",
            "oldVerticesPreserved",
            "oldUVLayersPreserved",
            "oldCustomAttributesPreserved",
            "oldCustomNormalsPreserved",
          "keptBoundaryEdgesPreserved",
            "otherMeshesPreserved",
            "materialsAndImagesPreserved",
            "intersectionValidation",
            "fbxRoundTrip",
            "glbRoundTrip",
          ].map((k) => [k, true]),
        ),
      });
    return {
      cached: !!args.recoveryOnly,
      report,
      files: [
        ...(args.mode === "repair"
          ? ["asset.blend", "asset.fbx", "asset.glb"].map((n) =>
              file("out/" + n),
            )
          : []),
        file(
          "out/" +
            args.mode +
            "-" +
            (args.inspectionAttempt ?? args.inspection?.identity ?? "result") +
            "-report.json",
          JSON.stringify(report),
          "report",
        ),
      ],
    };
  };
  let graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    planar: local,
  });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      if (!graphics.isActive(project.id)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("not settled");
  };
  t.after(async () => {
    graphics.shutdown();
    await settle();
    store.db.close();
    const full = fs.realpathSync(root);
    assert.equal(path.dirname(full), fs.realpathSync(os.tmpdir()));
    fs.rmSync(full, { recursive: true, force: true });
  });
  assert.equal(runs, 0, "opening existing versions does not run inspection");
  await graphics.action(project.id, {
    kind: "inspect-planar",
    versionId: "source",
  });
  await settle();
  let state = graphics.get(project.id);
  assert.equal(state.versions.length, 1);
  assert(state.planarInspections?.source);
  assert.deepEqual(state.objects, initial.objects);
  await assert.rejects(
    graphics.action(project.id, {
      kind: "repair-planar",
      versionId: "source",
      inspectionId: "inspect1",
      meshId: "m1",
      selectedBoundaryIds: null,
      keptBoundaryIds: [],
      materialPolicy: "preserve",
    } as any),
    /잘못/,
  );
  await assert.rejects(
    graphics.action(project.id, {
      kind: "prepare",
      objectId: "obj",
      taskId: "LOCAL_PLANAR_REPAIR",
    }),
    /경계 검사/,
  );
  const selection = {
    kind: "repair-planar" as const,
    versionId: "source",
    inspectionId: "inspect1",
    meshId: "m1",
    selectedBoundaryIds: ["b1"],
    keptBoundaryIds: [],
    materialPolicy: "preserve" as const,
  };
  await assert.rejects(
    graphics.action(project.id, { ...selection, inspectionId: "stale" }),
    /선택/,
  );
  fail = true;
  await graphics.action(project.id, selection);
  await settle();
  state = graphics.get(project.id);
  const repair = state.tasks.at(-1)!;
  assert.equal(repair.status, "failed");
  const calls = runs;
  await graphics.action(project.id, selection);
  assert.equal(runs, calls, "duplicate does not replay failed task");
  const oldHash = repair.requestHash,
    oldIdentity = repair.planarInspection!.identity;
  await graphics.action(project.id, {
    kind: "inspect-planar",
    versionId: "source",
  });
  await settle();
  assert.notEqual(
    graphics.get(project.id).planarInspections!.source.identity,
    oldIdentity,
  );
  await graphics.action(project.id, selection);
  await settle();
  state = graphics.get(project.id);
  const newRepair = state.tasks.at(-1)!;
  assert.notEqual(newRepair.requestHash, oldHash);
  assert.equal(newRepair.status, "failed");
  assert.equal(
    runs,
    calls + 2,
    "explicit new frozen inspection permits one new request",
  );
  graphics.shutdown();
  graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    planar: local,
  });
  const beforeRecovery = runs;
  assert.equal(runs, beforeRecovery);
  fail = false;
  await graphics.action(project.id, { kind: "recover", taskId: repair.id });
  await settle();
  state = graphics.get(project.id);
  assert.equal(recoveries, 1);
  assert.equal(
    callsSeen.at(-1).inspectionIdentity,
    oldIdentity,
    "recovery uses original inspection, not latest",
  );
  assert.equal(state.versions.length, 2, JSON.stringify(state.tasks.at(-1)));
  assert.deepEqual(state.versions[0], v);
  assert.deepEqual(state.objects, initial.objects);
  assert.equal(state.versions[1].planarRepair?.versionId, "source");
  assert.equal(remote, 0);
  assert.equal(store.project(project.id).jobs.length, 0);
  failInspect = true;
  await graphics.action(project.id, {
    kind: "inspect-planar",
    versionId: "source",
  });
  await settle();
  state = graphics.get(project.id);
  const interruptedInspect = state.tasks.at(-1)!;
  assert.equal(interruptedInspect.status, "failed");
  interruptedInspect.status = "cancelled";
  store.put("graphics", project.id, state);
  failInspect = false;
  await graphics.action(project.id, {
    kind: "recover",
    taskId: interruptedInspect.id,
  });
  await settle();
  assert.equal(callsSeen.at(-1).mode, "inspect");
  assert.equal(callsSeen.at(-1).recoveryOnly, true);
  assert.equal(callsSeen.at(-1).inspectionAttempt, interruptedInspect.id);
  assert.equal(
    graphics.get(project.id).tasks.find((t) => t.id === interruptedInspect.id)!
      .status,
    "review",
  );
  assert.equal(remote, 0);
  state = graphics.get(project.id);
  const restarted = state.tasks.find((t) => t.id === interruptedInspect.id)!;
  restarted.status = "running";
  store.put("graphics", project.id, state);
  const backend = store.project(project.id);
  backend.jobs.push({ id: "unrelated-legacy-job", status: "success" } as any);
  store.save(backend);
  graphics.shutdown();
  graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    planar: local,
  });
  const resumed = graphics
    .get(project.id)
    .tasks.find((t) => t.id === interruptedInspect.id)!;
  assert.equal(resumed.status, "failed");
  assert.deepEqual(
    resumed.backendJobIds,
    [],
    "undefined quote IDs must never associate unrelated backend jobs with local inspection",
  );
  let backendCancels = 0;
  engine.cancel = (() => {
    backendCancels++;
  }) as any;
  state = graphics.get(project.id);
  state.tasks.find((t) => t.id === interruptedInspect.id)!.backendJobIds = [
    "unrelated-legacy-job",
  ];
  store.put("graphics", project.id, state);
  await graphics.action(project.id, {
    kind: "cancel",
    taskId: interruptedInspect.id,
  });
  assert.equal(
    backendCancels,
    0,
    "local inspection cancellation must never reach remote cancellation",
  );
  assert.equal(remote, 0);
  await graphics.action(project.id, {
    kind: "accept",
    objectId: "obj",
    versionId: state.versions[1].id,
  });
  state = graphics.get(project.id);
  assert.equal(state.objects[0].accepted["model:main"], state.versions[1].id);
  assert.deepEqual(state.versions[0], v);
  assert.equal(remote, 0);
});
