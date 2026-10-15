import type { GraphicsFile } from "./graphics";
export const CURRENT_PLANAR_ALGORITHM = "planar-v2" as const;
export type PlanarAlgorithmVersion =
  "planar-v1" | typeof CURRENT_PLANAR_ALGORITHM;
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
  kind?: "loop" | "subcycle" | "open-chain";
  componentId?: string;
  edgeVertexPairs?: number[][];
  conflictsWith?: string[];
};
export type PlanarInspection = {
  schemaVersion: 1;
  mode: "inspect";
  passed: true;
  inspectionId: string;
  identity: string;
  sourceVersionId: string;
  sourceSha256: string;
  algorithmVersion: PlanarAlgorithmVersion;
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
  algorithmVersion: PlanarAlgorithmVersion;
  reportPath: string;
};
export function validatePlanarSelection(
  report: PlanarInspection,
  selection: PlanarSelection,
) {
  if (report.algorithmVersion !== CURRENT_PLANAR_ALGORITHM)
    throw Error(
      "이전 평면 검사입니다. 새 경계 방식으로 명시적으로 다시 검사한 뒤 복구하세요. 이전 결과는 그대로 유지됩니다.",
    );
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
  const chosen = mesh.boundaries.filter((boundary) =>
    selected.includes(boundary.id),
  );
  const edges = (boundary: PlanarBoundary) =>
    new Set(
      (
        boundary.edgeVertexPairs ??
        boundary.vertexIndices.map((v, index) => [
          v,
          boundary.vertexIndices[(index + 1) % boundary.vertexIndices.length],
        ])
      ).map((pair) => [...pair].sort((a, b) => a - b).join(":")),
    );
  for (let a = 0; a < chosen.length; a++)
    for (let b = a + 1; b < chosen.length; b++) {
      if (
        chosen[a].conflictsWith?.includes(chosen[b].id) ||
        chosen[b].conflictsWith?.includes(chosen[a].id) ||
        [...edges(chosen[a])].some((edge) => edges(chosen[b]).has(edge))
      )
        throw Error(
          "겹치거나 같은 경계선을 공유하는 복구 후보를 동시에 선택할 수 없습니다. 하나씩 검토하세요.",
        );
    }
}
