import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import { validateSavedPlanarCandidate } from "../engine/graphics-planar";
import type { Tripo } from "../engine/tripo";
import type {
  GraphicsWorkspace,
  AssetVersion,
  GraphicsTask,
} from "../shared/graphics";
import type {
  PlanarAlgorithmVersion,
  PlanarInspection,
  PlanarSelection,
} from "../shared/graphics-planar";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function setup(t: any, algorithm: PlanarAlgorithmVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-planar-adopt-")),
    store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let worker = 0;
  const engine = new Engine(
      store,
      new Proxy(
        {},
        {
          get: () => () => {
            throw Error("remote forbidden");
          },
        },
      ) as Tripo,
    ),
    p = engine.create("saved");
  const file = (name: string, text = name) => {
    store.write(p.id, name, text);
    return {
      path: name,
      kind: name.endsWith(".json") ? "report" : "model",
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    };
  };
  const source: AssetVersion = {
    id: "source",
    objectId: "o",
    role: "model",
    slot: "main",
    createdAt: "old",
    label: "source",
    sourceVersionIds: [],
    files: [file("source.blend")],
    provenance: { type: "import" },
    warnings: [],
  };
  const selection: PlanarSelection = {
    versionId: "source",
    inspectionId: "inspection",
    meshId: "mesh",
    selectedBoundaryIds: ["loop"],
    keptBoundaryIds: [],
    materialPolicy: "preserve",
  };
  const inspection: PlanarInspection = {
    schemaVersion: 1,
    mode: "inspect",
    passed: true,
    identity: "inspection-identity",
    inspectionId: "inspection",
    sourceVersionId: "source",
    sourceSha256: source.files[0].sha256,
    algorithmVersion: algorithm,
    localOnly: true,
    modelTurns: 0,
    paidSubmissions: 0,
    meshes: [
      {
        meshId: "mesh",
        name: "box",
        boundaries: [
          {
            id: "loop",
            number: 1,
            vertexIndices: [0, 1, 2],
            worldVertices: [
              [0, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
            ],
            kind: "loop",
            componentId: "component",
            edgeVertexPairs: [
              [0, 1],
              [1, 2],
              [0, 2],
            ],
            conflictsWith: [],
            status: "eligible",
            reasons: [],
            materialOptions: ["preserve"],
          },
        ],
      },
    ],
  };
  inspection.reportFile = file("inspection.json", JSON.stringify(inspection));
  const checks = [
    "staticOnly",
    "appendOnly",
    "oldVerticesPreserved",
    "oldUVLayersPreserved",
    "oldCustomAttributesPreserved",
    "oldCustomNormalsPreserved",
    "otherMeshesPreserved",
    "materialsAndImagesPreserved",
    "intersectionValidation",
    "fbxRoundTrip",
    "glbRoundTrip",
    ...(algorithm === "planar-v2" ? ["keptBoundaryEdgesPreserved"] : []),
  ];
  const report = {
    schemaVersion: 1,
    mode: "repair",
    passed: true,
    identity: "repair-identity",
    sourceVersionId: "source",
    sourceSha256: source.files[0].sha256,
    algorithmVersion: algorithm,
    ...selection,
    localOnly: true,
    modelTurns: 0,
    paidSubmissions: 0,
    checks: Object.fromEntries(checks.map((key) => [key, true])),
    warnings: [],
  };
  const reportFile = file("result/report.json", JSON.stringify(report));
  const candidate: AssetVersion = {
    ...source,
    id: "candidate",
    label: "saved",
    sourceVersionIds: ["source"],
    provenance: { type: "local" },
    files: [
      file("result/asset.blend"),
      file("result/asset.fbx"),
      file("result/asset.glb"),
      reportFile,
    ],
    planarRepair: {
      schemaVersion: 1,
      ...selection,
      sourceSha256: source.files[0].sha256,
      identity: report.identity,
      algorithmVersion: algorithm,
      reportPath: reportFile.path,
    },
  };
  const task: GraphicsTask = {
    id: "producer",
    objectId: "o",
    taskId: "LOCAL_PLANAR_REPAIR",
    createdAt: "old",
    updatedAt: "old",
    status: "review",
    inputVersionIds: ["source"],
    outputVersionIds: ["candidate"],
    settings: {
      algorithmVersion: algorithm,
      sourceSha256: source.files[0].sha256,
    },
    instruction: "",
    requestHash: hash(
      JSON.stringify({
        source: "source",
        sha: source.files[0].sha256,
        selection,
        inspectionReportSha256: inspection.reportFile.sha256,
        inspectionIdentity: inspection.identity,
        algorithmVersion: algorithm,
      }),
    ),
    backendJobIds: [],
    message: "saved",
    localOnly: true,
    planarSelection: selection,
    planarInspection: inspection,
  };
  const workspace: GraphicsWorkspace = {
    schemaVersion: 1,
    id: p.id,
    projectId: p.id,
    revision: 0,
    objects: [
      {
        id: "o",
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
    versions: [source, candidate],
    tasks: [task],
    deliveries: [],
  };
  store.put("graphics", p.id, workspace);
  const graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    planar: async () => {
      worker++;
      throw Error("must never execute");
    },
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
  return {
    root,
    store,
    p,
    workspace,
    candidate,
    source,
    task,
    report,
    graphics,
    worker: () => worker,
    file,
  };
}
test("v1 completed eleven-check candidate and v2 twelve-check candidate adopt only saved own reports without a worker", async (t) => {
  for (const algorithm of ["planar-v1", "planar-v2"] as const) {
    const s = await setup(t, algorithm);
    await s.graphics.action(s.p.id, {
      kind: "accept",
      objectId: "o",
      versionId: "candidate",
    });
    const after = s.graphics.get(s.p.id);
    assert.equal(after.objects[0].accepted["model:main"], "candidate");
    assert.deepEqual(after.versions, s.workspace.versions);
    assert.deepEqual(after.tasks, s.workspace.tasks);
    assert.equal(s.worker(), 0);
    s.task.status = "failed";
    s.store.put("graphics", s.p.id, { ...s.workspace, tasks: [s.task] });
    if (algorithm === "planar-v1")
      await assert.rejects(
        s.graphics.action(s.p.id, { kind: "recover", taskId: s.task.id }),
        /이전 평면 작업/,
      );
    assert.equal(s.worker(), 0);
  }
});
test("adoption rejects foreign report paths, source/selection/hash/provenance mismatch, failed checks before changing accepted state", async (t) => {
  const s = await setup(t, "planar-v2");
  for (const mutate of [
    (w: GraphicsWorkspace) =>
      (w.versions[1].planarRepair!.reportPath = "inspection.json"),
    (w: GraphicsWorkspace) => (w.versions[1].planarRepair!.identity = "other"),
    (w: GraphicsWorkspace) =>
      (w.versions[1].planarRepair!.sourceSha256 = "0".repeat(64)),
    (w: GraphicsWorkspace) =>
      (w.versions[1].planarRepair!.selectedBoundaryIds = ["other"]),
    (w: GraphicsWorkspace) => (w.tasks[0].requestHash = "wrong"),
    (w: GraphicsWorkspace) => (w.tasks[0].planarInspection!.identity = "wrong"),
    (w: GraphicsWorkspace) => (w.tasks[0].backendJobIds = ["remote"]),
    (w: GraphicsWorkspace) => w.tasks.push({ ...w.tasks[0], id: "duplicate" }),
  ]) {
    const bad = structuredClone(s.workspace);
    mutate(bad);
    s.store.put("graphics", s.p.id, bad);
    await assert.rejects(
      s.graphics.action(s.p.id, {
        kind: "accept",
        objectId: "o",
        versionId: "candidate",
      }),
    );
    assert.equal(
      s.graphics.get(s.p.id).objects[0].accepted["model:main"],
      "source",
    );
    assert.equal(s.worker(), 0);
  }
  const bad = structuredClone(s.workspace),
    failed = {
      ...s.report,
      checks: { ...s.report.checks, keptBoundaryEdgesPreserved: false },
    },
    changed = s.file("result/report.json", JSON.stringify(failed));
  bad.versions[1].files[3] = changed;
  s.store.put("graphics", s.p.id, bad);
  await assert.rejects(
    s.graphics.action(s.p.id, {
      kind: "accept",
      objectId: "o",
      versionId: "candidate",
    }),
  );
  assert.equal(
    s.graphics.get(s.p.id).objects[0].accepted["model:main"],
    "source",
  );
});
test("actual historical preview29 v1 candidate still validates read-only after v2 upgrade", (t) => {
  if (!fs.existsSync("artifacts/runtime/graphics-planar-app.json"))
    return t.skip("Saved local app fixture unavailable");
  const app = JSON.parse(
    fs.readFileSync("artifacts/runtime/graphics-planar-app.json", "utf8"),
  );
  if (
    !app.candidate ||
    app.candidate.planarRepair?.algorithmVersion !== "planar-v1"
  )
    return t.skip("No historical v1 fixture");
  const root = path.join(
      app.fixture.profile,
      "projects",
      app.fixture.projectId,
    ),
    workspace: GraphicsWorkspace = JSON.parse(
      fs.readFileSync(path.join(root, "graphics/workspace.json"), "utf8"),
    );
  const candidate = workspace.versions.find((v) => v.id === app.candidate.id)!;
  assert(candidate);
  const before = fs.readFileSync(path.join(root, "graphics/workspace.json"));
  validateSavedPlanarCandidate(root, workspace, candidate);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "graphics/workspace.json")),
    before,
  );
});
