/** Local, disposable inspection derivative. Never a production AssetVersion. */
export type NativeFaceCounts = { triangles: number; quads: number; ngons: number; polygons: number; edges: number; vertices: number };
export type NativeTopologyPrimitive = {
  node: number; mesh: number; primitive: number;
  /** Exact exporter-carried source POINT indices; duplicated UV/material vertices retain the same id. */
  sourceVertices: number[];
  /** Render-vertex endpoint indices for genuine native polygon edges only. */
  edges: number[];
  faces: number[];
  counts: NativeFaceCounts;
};
export type NativeTopologyMesh = {
  key: string; name: string; sourceId?: string; counts: NativeFaceCounts;
  primitives: NativeTopologyPrimitive[];
};
export type NativeTopologyMap = {
  schemaVersion: 1; sourceVersionId: string;
  source: { path: string; sha256: string };
  originalPreview: { path: string; sha256: string };
  dependencies: { path: string; sha256: string }[];
  previewSha256: string; exporterFingerprint: string;
  meshes: NativeTopologyMesh[];
};
export type NativeTopologyResult =
  | { status: "ready"; preview: { path: string; sha256: string; bytes: number }; map: NativeTopologyMap }
  | { status: "unavailable"; reason: string };

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** Treat derivative metadata as untrusted. Geometry/accessor validation follows at loader time. */
export function validateNativeTopologyMap(value: unknown): asserts value is NativeTopologyMap {
  const map = value as NativeTopologyMap;
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!map || map.schemaVersion !== 1 || typeof map.sourceVersionId !== "string" ||
    !digest(map.source?.sha256) || !digest(map.originalPreview?.sha256) || !digest(map.previewSha256) || !digest(map.exporterFingerprint) ||
    typeof map.source.path !== "string" || typeof map.originalPreview.path !== "string" ||
    !Array.isArray(map.dependencies) || map.dependencies.some(file => typeof file.path !== 'string' || !digest(file.sha256)) ||
    !Array.isArray(map.meshes) || !map.meshes.length || map.meshes.length > 10000) throw Error("원본 면 검사 명세가 올바르지 않습니다.");
  const locations = new Set<string>(), keys = new Set<string>();
  for (const mesh of map.meshes) {
    if (!mesh || typeof mesh.key !== "string" || keys.has(mesh.key) || typeof mesh.name !== "string" ||
      !mesh.counts || Object.values(mesh.counts).some(value => !integer(value)) || mesh.counts.vertices > 2_000_000 ||
      mesh.counts.polygons !== mesh.counts.triangles + mesh.counts.quads + mesh.counts.ngons ||
      !Array.isArray(mesh.primitives) || !mesh.primitives.length) throw Error("원본 메시 통계가 올바르지 않습니다.");
    keys.add(mesh.key); const faces = new Set<number>();
    for (const primitive of mesh.primitives) {
      const location = `${primitive.node}/${primitive.mesh}/${primitive.primitive}`;
      if (![primitive.node, primitive.mesh, primitive.primitive].every(integer) || locations.has(location) ||
        !Array.isArray(primitive.sourceVertices) || !primitive.sourceVertices.length || primitive.sourceVertices.length > 6_000_000 ||
        primitive.sourceVertices.some(index => !integer(index) || index >= mesh.counts.vertices) ||
        !Array.isArray(primitive.edges) || primitive.edges.length % 2 || primitive.edges.some(index => !integer(index) || index >= primitive.sourceVertices.length) ||
        !primitive.counts || Object.values(primitive.counts).some(value => !integer(value)) ||
        primitive.counts.polygons !== primitive.counts.triangles + primitive.counts.quads + primitive.counts.ngons ||
        primitive.counts.polygons !== primitive.faces?.length ||
        !Array.isArray(primitive.faces) || primitive.faces.some(index => !integer(index) || index >= mesh.counts.polygons || faces.has(index)))
        throw Error("원본 면과 미리보기 정점의 대응이 올바르지 않습니다.");
      locations.add(location); primitive.faces.forEach(index => faces.add(index));
    }
    if (faces.size !== mesh.counts.polygons) throw Error("일부 원본 면의 대응이 누락되었습니다.");
  }
}
