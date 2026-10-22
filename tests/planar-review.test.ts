import test from "node:test";
import assert from "node:assert/strict";
import type {
  PlanarBoundary,
  PlanarInspection,
} from "../shared/graphics-planar";
import {
  currentPlanarInspection,
  planarBoundaryCanRepair,
  planarBoundaryLabel,
  planarBoundaryOverlay,
  planarSelectionConflict,
} from "../src/planar-review";
const boundary = (values: Partial<PlanarBoundary> = {}): PlanarBoundary => ({
  id: "loop",
  number: 1,
  vertexIndices: [1, 2, 3, 4],
  worldVertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  status: "eligible",
  reasons: [],
  materialOptions: ["preserve"],
  ...values,
});
test("v2 subcycle is a closed repair choice; leftover open chains are never repairable", () => {
  assert.equal(
    currentPlanarInspection({
      algorithmVersion: "planar-v1",
    } as PlanarInspection),
    false,
  );
  assert.equal(
    currentPlanarInspection({
      algorithmVersion: "planar-v2",
    } as PlanarInspection),
    true,
  );
  assert.equal(planarBoundaryCanRepair(boundary({ kind: "subcycle" })), true);
  assert.match(
    planarBoundaryLabel(boundary({ kind: "subcycle" })),
    /닫힌 고리/,
  );
  assert.equal(
    planarBoundaryCanRepair(boundary({ kind: "open-chain" })),
    false,
  );
  const tree = boundary({
    kind: "open-chain",
    vertexIndices: [10, 11, 12, 13],
    worldVertices: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ],
    edgeVertexPairs: [
      [10, 12],
      [12, 11],
      [12, 13],
    ],
  });
  const overlay = planarBoundaryOverlay(tree, "#ffffff");
  assert.equal(overlay.closed, false);
  assert.deepEqual(overlay.segments, [
    [
      [1, 3, -2],
      [7, 9, -8],
    ],
    [
      [7, 9, -8],
      [4, 6, -5],
    ],
    [
      [7, 9, -8],
      [10, 12, -11],
    ],
  ]);
});
test("subcycle selections reject declared conflicts in either direction and actual shared edges", () => {
  const a = boundary({
    id: "a",
    kind: "subcycle",
    edgeVertexPairs: [
      [1, 2],
      [2, 3],
    ],
  });
  const b = boundary({
    id: "b",
    kind: "subcycle",
    edgeVertexPairs: [
      [2, 1],
      [8, 9],
    ],
  });
  assert.equal(planarSelectionConflict([a, b], ["a", "b"]), true);
  assert.equal(planarSelectionConflict([a, b], ["a"]), false);
  const c = boundary({ id: "c", conflictsWith: ["a"] });
  assert.equal(planarSelectionConflict([a, c], ["a", "c"]), true);
  assert.equal(planarSelectionConflict([a, b], []), false);
});
test("ordered patch winding chooses outward view direction without moving source points", async () => {
  const { planarLoopNormal } = await import("../src/planar-review");
  const points = [
    [-1, -1, -1],
    [-1, -1, 1],
    [-1, 1, 1],
    [-1, 1, -1],
  ];
  const original = structuredClone(points);
  assert.deepEqual(planarLoopNormal(points), [-1, 0, 0]);
  assert.deepEqual(points, original);
  assert.deepEqual(planarLoopNormal([...points].reverse()), [1, 0, 0]);
  assert.equal(
    planarLoopNormal([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ]),
    undefined,
  );
});
test("candidate report is bound to frozen source, algorithm and exact ordered selection", async () => {
  const { validatePlanarCandidateReport } =
    await import("../src/planar-review");
  const provenance = {
    schemaVersion: 1,
    versionId: "source",
    sourceSha256: "a".repeat(64),
    identity: "b".repeat(64),
    inspectionId: "inspection",
    algorithmVersion: "planar-v2",
    meshId: "mesh",
    selectedBoundaryIds: ["one"],
    keptBoundaryIds: ["two", "chain"],
    materialPolicy: "preserve",
    reportPath: "report.json",
  };
  const candidate = {
    planarRepair: provenance,
  } as unknown as import("../shared/graphics").AssetVersion;
  const report = {
    ...provenance,
    schemaVersion: 1,
    mode: "repair",
    passed: true,
    sourceVersionId: "source",
  };
  assert.doesNotThrow(() =>
    validatePlanarCandidateReport(report, candidate, "source"),
  );
  for (const [key, value] of Object.entries({
    identity: "foreign",
    sourceVersionId: "other-source",
    sourceSha256: "c".repeat(64),
    inspectionId: "other-inspection",
    algorithmVersion: "planar-v1",
    meshId: "other-mesh",
    selectedBoundaryIds: ["two"],
    keptBoundaryIds: ["chain", "two"],
    materialPolicy: "reuse-existing-pattern",
    mode: "inspect",
    passed: false,
  })) {
    assert.throws(
      () =>
        validatePlanarCandidateReport(
          { ...report, [key]: value },
          candidate,
          "source",
        ),
      /일치하지 않습니다/,
      key,
    );
  }
});
