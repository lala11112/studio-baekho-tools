import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  createGraphicsPlanarRunner,
  validatePlanarReport,
} from "../engine/graphics-planar";
import {
  validatePlanarSelection,
  type PlanarInspection,
} from "../shared/graphics-planar";
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planar-test-"));
  t.after(() => {
    const full = fs.realpathSync(root);
    assert.equal(path.dirname(full), fs.realpathSync(os.tmpdir()));
    assert(path.basename(full).startsWith("planar-test-"));
    fs.rmSync(full, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "resources", "blender"), { recursive: true });
  for (const n of [
    "graphics_planar_repair.py",
    "graphics_glb.py",
    "tripo_part_preservation.py",
  ])
    fs.writeFileSync(path.join(root, "resources", "blender", n), n);
  fs.writeFileSync(path.join(root, "source.blend"), "source");
  fs.writeFileSync(path.join(root, "blender.exe"), "binary");
  return {
    root,
    args: {
      projectRoot: root,
      source: {
        path: "source.blend",
        bytes: 6,
        sha256: digest("source"),
        kind: "blend",
      },
      sourceVersionId: "v1",
      resources: path.join(root, "resources"),
      blenderPath: path.join(root, "blender.exe"),
      signal: new AbortController().signal,
      mode: "inspect" as const,
    },
  };
}
function report(q: any) {
  return {
    schemaVersion: 1,
    algorithmVersion:'planar-v2',
    ...q,
    passed: true,
    mode: q.mode,
    inspectionId: "inspect1",
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
    localOnly: true,
    modelTurns: 0,
    paidSubmissions: 0,
  };
}
test("inspection stays report-only, caches exact outputs and rejects stale source and tampered manifest", async (t) => {
  const f = fixture(t);
  let runs = 0;
  const runner = createGraphicsPlanarRunner({
    runBlender: async (_, cmd) => {
      runs++;
      const q = JSON.parse(fs.readFileSync(cmd.at(-1)!, "utf8"));
      fs.writeFileSync(q.report, JSON.stringify(report(q)));
    },
  });
  const result = await runner(f.args);
  assert.equal(result.files.length, 1);
  assert.equal(runs, 1);
  assert.equal((await runner(f.args)).cached, true);
  assert.equal(runs, 1);
  const manifest = path.join(
    f.root,
    path.dirname(path.dirname(result.files[0].path)),
    "manifest.json",
  );
  const saved = JSON.parse(fs.readFileSync(manifest, "utf8"));
  saved.files[0].kind = "model";
  fs.writeFileSync(manifest, JSON.stringify(saved));
  await assert.rejects(runner(f.args), /파일/);
  fs.appendFileSync(path.join(f.root, "source.blend"), "changed");
  await assert.rejects(runner(f.args), /변경/);
});
test("interrupted dispatch never reruns; saved complete output recovers after restart", async (t) => {
  const f = fixture(t);
  let runs = 0;
  const runner = createGraphicsPlanarRunner({
    runBlender: async (_, cmd) => {
      runs++;
      const q = JSON.parse(fs.readFileSync(cmd.at(-1)!, "utf8"));
      fs.writeFileSync(q.report, JSON.stringify(report(q)));
      throw Error("app interrupted before registration");
    },
  });
  await assert.rejects(runner(f.args), /interrupted/);
  await assert.rejects(runner(f.args), /이미 실행/);
  assert.equal(runs, 1);
  const recovered = await runner({ ...f.args, recoveryOnly: true });
  assert.equal(recovered.cached, true);
  assert.equal(runs, 1);
});
test("abort and invalid report cannot create adoptable files or retry", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let runs = 0;
  const runner = createGraphicsPlanarRunner({
    runBlender: async (_, cmd) => {
      runs++;
      const q = JSON.parse(fs.readFileSync(cmd.at(-1)!, "utf8"));
      const r = report(q);
      r.paidSubmissions = 1;
      fs.writeFileSync(q.report, JSON.stringify(r));
    },
  });
  await assert.rejects(runner(f.args), /기록/);
  await assert.rejects(runner(f.args), /이미 실행/);
  controller.abort();
  await assert.rejects(runner({ ...f.args, signal: controller.signal }));
  assert.equal(runs, 1);
});
test("selection binds source, inspection, mesh and complete explicit boundary partition", () => {
  const r = report({
    mode: "inspect",
    sourceVersionId: "v1",
  }) as PlanarInspection;
  const s = {
    versionId: "v1",
    inspectionId: "inspect1",
    meshId: "m1",
    selectedBoundaryIds: ["b1"],
    keptBoundaryIds: [],
    materialPolicy: "preserve" as const,
  };
  validatePlanarSelection(r, s);
  for (const change of [
    { versionId: "old" },
    { inspectionId: "old" },
    { meshId: "other" },
    { selectedBoundaryIds: [] },
    { keptBoundaryIds: ["b1"] },
  ])
    assert.throws(() => validatePlanarSelection(r, { ...s, ...change }));
});
test("repair validates required checks, freezes inspection, and cancelled recovery uses exact saved identity", async (t) => {
  const f = fixture(t);
  let runs = 0,
    invalid = false,
    interrupt = false;
  const runner = createGraphicsPlanarRunner({
    runBlender: async (_, cmd) => {
      runs++;
      const q = JSON.parse(fs.readFileSync(cmd.at(-1)!, "utf8"));
      const r: any = report(q);
      if (q.mode === "repair") {
        r.warnings = [];
        r.checks = invalid
          ? { unrelated: true }
          : Object.fromEntries(
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
            );
        for (const name of ["asset.blend", "asset.fbx", "asset.glb"])
          fs.writeFileSync(path.join(q.output, name), name);
      }
      fs.writeFileSync(q.report, JSON.stringify(r));
      if (interrupt) throw Error("cancelled after saved result");
    },
  });
  const inspected = await runner(f.args),
    inspection = { ...inspected.report, reportFile: inspected.files[0] },
    selection = {
      versionId: "v1",
      inspectionId: "inspect1",
      meshId: "m1",
      selectedBoundaryIds: ["b1"],
      keptBoundaryIds: [],
      materialPolicy: "preserve" as const,
    };
  const args = { ...f.args, mode: "repair" as const, inspection, selection };
  interrupt = true;
  await assert.rejects(runner(args), /cancelled/);
  assert.equal(runs, 2);
  await assert.rejects(runner(args), /이미 실행/);
  const recovered = await runner({ ...args, recoveryOnly: true });
  assert.equal(runs, 2);
  assert.equal(recovered.files.length, 4);
  assert.equal(recovered.report.identity, (await runner(args)).report.identity);
  assert.throws(
    () =>
      validatePlanarReport(
        {
          ...recovered.report,
          checks: {
            ...recovered.report.checks,
            oldCustomNormalsPreserved: false,
          },
        },
        args,
        recovered.report.identity,
      ),
    /보존 검사/,
  );
  assert.throws(
    () =>
      validatePlanarReport(
        {
          ...recovered.report,
          checks: {
            ...recovered.report.checks,
            oldCustomAttributesPreserved: undefined,
          },
        },
        args,
        recovered.report.identity,
      ),
    /보존 검사/,
  );
  const changed = { ...inspection, meshes: [] };
  assert.throws(()=>validatePlanarReport({...recovered.report,checks:{...recovered.report.checks,keptBoundaryEdgesPreserved:false}},args,recovered.report.identity),/보존 검사/);
  await assert.rejects(runner({ ...args, inspection: changed }), /경계/);
  fs.appendFileSync(
    path.join(f.root, "resources", "blender", "graphics_planar_repair.py"),
    "change",
  );
  await assert.rejects(runner({ ...args, recoveryOnly: true }), /이미 실행/);
  assert.equal(runs, 2);
  const f2 = fixture(t);
  interrupt = false;
  const i2 = await runner(f2.args);
  invalid = true;
  await assert.rejects(
    runner({
      ...f2.args,
      mode: "repair",
      selection,
      inspection: { ...i2.report, reportFile: i2.files[0] },
    }),
    /보존 검사/,
  );
});
