import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  validatePlanarSelection,
  type PlanarInspection,
  type PlanarSelection,
} from "../shared/graphics-planar";
import {
  validatePlanarReport,
  type PlanarArgs,
} from "../engine/graphics-planar";
import { GraphicsEngine } from "../engine/graphics";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import type { GraphicsWorkspace, AssetVersion } from "../shared/graphics";
import type { Tripo } from "../engine/tripo";
const boundary = (
  id: string,
  indices: number[],
  kind: "subcycle" | "open-chain" = "subcycle",
) => ({
  id,
  number: 1,
  vertexIndices: indices,
  edgeVertexPairs: indices
    .slice(0, kind === "open-chain" ? -1 : undefined)
    .map((v, index) => [v, indices[(index + 1) % indices.length]]),
  worldVertices: indices.map((_, index) => [index, index % 2, 0]),
  kind,
  componentId: "component",
  status: kind === "open-chain" ? ("blocked" as const) : ("eligible" as const),
  reasons: [],
  materialOptions: ["preserve"],
  conflictsWith: [] as string[],
});
const report = (): PlanarInspection => ({
  schemaVersion: 1,
  mode: "inspect",
  passed: true,
  identity: "identity",
  inspectionId: "inspect",
  sourceVersionId: "source",
  sourceSha256: "a".repeat(64),
  algorithmVersion: "planar-v2",
  meshes: [
    {
      meshId: "mesh",
      name: "box",
      boundaries: [
        boundary("cycle", [0, 1, 2, 3]),
        boundary("residual", [3, 4, 5], "open-chain"),
      ],
    },
  ],
  localOnly: true,
  modelTurns: 0,
  paidSubmissions: 0,
});
const selection: PlanarSelection = {
  versionId: "source",
  inspectionId: "inspect",
  meshId: "mesh",
  selectedBoundaryIds: ["cycle"],
  keptBoundaryIds: ["residual"],
  materialPolicy: "preserve",
};
const args: PlanarArgs = {
  projectRoot: "unused",
  resources: "unused",
  blenderPath: "unused",
  source: {
    path: "unused.blend",
    kind: "blend",
    bytes: 1,
    sha256: "a".repeat(64),
  },
  sourceVersionId: "source",
  signal: new AbortController().signal,
  mode: "inspect",
};
test("v2 subcycle selection retains a residual chain sharing only a vertex and rejects v1/stale/incomplete partitions", () => {
  const r = report();
  validatePlanarSelection(r, selection);
  validatePlanarReport(r, args, "identity");
  assert.throws(
    () =>
      validatePlanarSelection(
        { ...r, algorithmVersion: "planar-v1" },
        selection,
      ),
    /이전 평면 검사/,
  );
  assert.throws(
    () => validatePlanarSelection(r, { ...selection, keptBoundaryIds: [] }),
    /선택한 경계/,
  );
  assert.throws(
    () =>
      validatePlanarSelection(r, {
        ...selection,
        selectedBoundaryIds: ["residual"],
        keptBoundaryIds: ["cycle"],
      }),
    /선택한 경계/,
  );
});
test("shared-edge and declared conflicting cycle selections are rejected in either direction", () => {
  const r = report();
  r.meshes[0].boundaries = [
    boundary("cycle", [0, 1, 2, 3]),
    boundary("second", [3, 2, 6, 7]),
  ];
  const both = {
    ...selection,
    selectedBoundaryIds: ["cycle", "second"],
    keptBoundaryIds: [],
  };
  assert.throws(() => validatePlanarSelection(r, both), /공유/);
  r.meshes[0].boundaries[1] = boundary("second", [8, 9, 10, 11]);
  r.meshes[0].boundaries[1].conflictsWith = ["cycle"];
  assert.throws(() => validatePlanarSelection(r, both), /겹치/);
  r.meshes[0].boundaries[1].conflictsWith = [];
  validatePlanarSelection(r, both);
});
test("v2 malformed cycle metadata cannot become a registered inspection", () => {
  for (const mutate of [
    (r: PlanarInspection) => (r.meshes[0].boundaries[0].kind = "open-chain"),
    (r: PlanarInspection) =>
      (r.meshes[0].boundaries[0].edgeVertexPairs = [[0, 9]]),
    (r: PlanarInspection) =>
      (r.meshes[0].boundaries[0].edgeVertexPairs = [
        [0, 1],
        [1, 2],
        [2, 0],
      ]),
    (r: PlanarInspection) =>
      (r.meshes[0].boundaries[0].conflictsWith = ["foreign"]),
    (r: PlanarInspection) =>
      (r.meshes[0].boundaries[0].worldVertices[0][0] = NaN),
    (r: PlanarInspection) =>
      (r.meshes[0].boundaries[0].vertexIndices = [0, 1, 1, 3]),
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => validatePlanarReport(r, args, "identity"));
  }
});
test("new v2 inspection requires all boundary relationship metadata", () => {
  for (const key of [
    "kind",
    "componentId",
    "edgeVertexPairs",
    "conflictsWith",
  ] as const) {
    const r = report();
    delete r.meshes[0].boundaries[0][key];
    assert.throws(() => validatePlanarReport(r, args, "identity"));
  }
});
