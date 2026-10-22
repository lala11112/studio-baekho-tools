import type {
  PlanarBoundary,
  PlanarInspection,
} from "../shared/graphics-planar";
import { CURRENT_PLANAR_ALGORITHM } from "../shared/graphics-planar";
import type { BoundaryOverlay } from "./Viewport";
export function currentPlanarInspection(report?: PlanarInspection) {
  return report?.algorithmVersion === CURRENT_PLANAR_ALGORITHM;
}
export function planarBoundaryLabel(boundary: PlanarBoundary) {
  return boundary.kind === "subcycle"
    ? "갈라진 경계 안의 닫힌 고리"
    : boundary.kind === "open-chain"
      ? "닫히지 않은 경계 · 유지"
      : "닫힌 경계";
}
export function planarSelectionConflict(
  boundaries: PlanarBoundary[],
  selectedIds: string[],
) {
  const selected = boundaries.filter((boundary) =>
    selectedIds.includes(boundary.id),
  );
  return selected.some((boundary, index) =>
    selected
      .slice(index + 1)
      .some(
        (other) =>
          boundary.conflictsWith?.includes(other.id) ||
          other.conflictsWith?.includes(boundary.id) ||
          boundary.edgeVertexPairs?.some((edge) =>
            other.edgeVertexPairs?.some(
              (pair) =>
                edge.length === 2 &&
                pair.length === 2 &&
                Math.min(...edge) === Math.min(...pair) &&
                Math.max(...edge) === Math.max(...pair),
            ),
          ),
      ),
  );
}
export function planarBoundaryCanRepair(boundary: PlanarBoundary) {
  return boundary.kind !== "open-chain" && boundary.status === "eligible";
}
export function planarBoundaryOverlay(
  boundary: PlanarBoundary,
  color: string,
): BoundaryOverlay {
  const toGlb = ([x, y, z]: number[]) => [x, z, -y];
  const byVertex = new Map(
    boundary.vertexIndices.map((id, index) => [
      id,
      boundary.worldVertices[index],
    ]),
  );
  const segments = boundary.edgeVertexPairs
    ?.map((edge) => edge.map((id) => byVertex.get(id)))
    .filter(
      (pair): pair is number[][] =>
        pair.length === 2 && pair.every((point) => !!point),
    )
    .map((pair) => pair.map(toGlb));
  return {
    id: boundary.id,
    number: boundary.number,
    points: (boundary.polyline ?? boundary.worldVertices).map(toGlb),
    color,
    closed: boundary.kind !== "open-chain",
    ...(segments?.length ? { segments } : {}),
  };
}
/** Ordered loop winding gives the new face's outward viewing direction. */
export function planarLoopNormal(
  points?: number[][],
): [number, number, number] | undefined {
  if (
    !points ||
    points.length < 3 ||
    points.some(
      (point) =>
        point.length !== 3 || point.some((value) => !Number.isFinite(value)),
    )
  )
    return;
  const normal = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(...normal);
  if (length < 1e-14) return;
  return normal.map((value) => value / length) as [number, number, number];
}
/** Report evidence must describe exactly the immutable candidate being shown. */
export function validatePlanarCandidateReport(
  value: unknown,
  candidate: import("../shared/graphics").AssetVersion,
  sourceVersionId: string,
) {
  const report = value as Record<string, unknown> | null,
    provenance = candidate.planarRepair;
  if (
    !report ||
    !provenance ||
    report.schemaVersion !== 1 ||
    report.mode !== "repair" ||
    report.passed !== true ||
    report.sourceVersionId !== sourceVersionId ||
    provenance.versionId !== sourceVersionId ||
    report.sourceSha256 !== provenance.sourceSha256 ||
    report.identity !== provenance.identity ||
    report.inspectionId !== provenance.inspectionId ||
    report.algorithmVersion !== provenance.algorithmVersion ||
    report.meshId !== provenance.meshId ||
    report.materialPolicy !== provenance.materialPolicy ||
    JSON.stringify(report.selectedBoundaryIds) !==
      JSON.stringify(provenance.selectedBoundaryIds) ||
    JSON.stringify(report.keptBoundaryIds) !==
      JSON.stringify(provenance.keptBoundaryIds)
  )
    throw Error(
      "검사 보고서와 이 복구본의 원본·영역·재질 기록이 일치하지 않습니다. 이 결과를 사용할 수 없습니다.",
    );
}
