import type { GraphicsFile } from "./graphics";
export type PlanarMaterialPolicy = "preserve" | "reuse-existing-pattern";
export type PlanarBoundary = {
  id: string;
  number: number;
  vertexIndices: number[];
  worldVertices: number[][];
  polyline?: number[][];
  status: "eligible" | "blocked";
  reasons: string[];
  materialOptions: unknown[];
  addedFaces?: number;
  addedQuads?: number;
  addedTriangles?: number;
};
export type PlanarInspection = {
  schemaVersion: 1;
  mode: "inspect";
  passed: true;
  inspectionId: string;
  identity: string;
  sourceVersionId: string;
  sourceSha256: string;
  algorithmVersion: "planar-v1";
  meshes: { meshId: string; name: string; boundaries: PlanarBoundary[] }[];
  warnings?: string[];
  reportFile?: GraphicsFile;
  localOnly: true;
  modelTurns: 0;
  paidSubmissions: 0;
};
export type PlanarSelection = {
  versionId: string;
  inspectionId: string;
  meshId: string;
  selectedBoundaryIds: string[];
  keptBoundaryIds: string[];
  materialPolicy: PlanarMaterialPolicy;
};
export type PlanarRepairProvenance = PlanarSelection & {
  schemaVersion: 1;
  sourceSha256: string;
  identity: string;
  algorithmVersion: "planar-v1";
  reportPath: string;
};
export function validatePlanarSelection(
  report: PlanarInspection,
  selection: PlanarSelection,
) {
  const mesh = report.meshes.find((item) => item.meshId === selection.meshId);
  const selected = selection.selectedBoundaryIds,
    kept = selection.keptBoundaryIds;
  if (
    mesh &&
    Array.isArray(selected) &&
    selected.some((id) => {
      const b = mesh.boundaries.find((b) => b.id === id);
      return b && !b.materialOptions.includes(selection.materialPolicy);
    })
  )
    throw Error("선택한 경계에서 이 재질 처리 방식은 지원되지 않습니다.");
  if (
    report.sourceVersionId !== selection.versionId ||
    report.inspectionId !== selection.inspectionId ||
    !mesh ||
    !Array.isArray(selected) ||
    !selected.length ||
    !Array.isArray(kept) ||
    !["preserve", "reuse-existing-pattern"].includes(
      selection.materialPolicy,
    ) ||
    new Set([...selected, ...kept]).size !== selected.length + kept.length ||
    selected.some(
      (id) =>
        !mesh.boundaries.some((b) => b.id === id && b.status === "eligible"),
    ) ||
    kept.some((id) => !mesh.boundaries.some((b) => b.id === id)) ||
    mesh.boundaries.some(
      (b) => !selected.includes(b.id) && !kept.includes(b.id),
    )
  )
    throw Error(
      "검사 결과와 선택한 경계가 다릅니다. 다시 검사하고 보완·유지할 경계를 확인하세요.",
    );
}
