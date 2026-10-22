import * as THREE from 'three';
import { validateNativeTopologyMap, type NativeTopologyMap, type NativeTopologyMesh, type NativeTopologyPrimitive } from '../shared/native-topology';
import type { MeshEntry } from './viewport-inspection';

export type NativeEdgeView = {
  entry: MeshEntry; native: NativeTopologyMesh; primitive: NativeTopologyPrimitive;
  lines: THREE.LineSegments; points: Map<number, THREE.Vector3>;
};
type Parser = { associations: { get(object: THREE.Object3D): { nodes?: number; meshes?: number; primitives?: number } | undefined }; json: { nodes?: { mesh?: number }[] } };

/** Exact primitive/node/attribute correspondence, never sanitized names or proximity. */
export function createNativeEdgeViews(entries: MeshEntry[], parser: Parser, map: NativeTopologyMap): NativeEdgeView[] {
  validateNativeTopologyMap(map);
  const views: NativeEdgeView[] = [], used = new Set<string>();
  try {
    for (const entry of entries) {
      const mesh = entry.mesh, association = parser.associations.get(mesh);
      let nodeIndex: number | undefined;
      for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) {
        const candidate = parser.associations.get(parent)?.nodes;
        if (candidate !== undefined && parser.json.nodes?.[candidate]?.mesh === association?.meshes) { nodeIndex = candidate; break; }
      }
      const native = map.meshes.find(value => value.primitives.some(primitive => primitive.node === nodeIndex && primitive.mesh === association?.meshes && primitive.primitive === association?.primitives));
      const primitive = native?.primitives.find(value => value.node === nodeIndex && value.mesh === association?.meshes && value.primitive === association?.primitives);
      if (!native || !primitive || mesh instanceof THREE.InstancedMesh) throw Error('원본 메시와 GLB 부품의 대응을 확인하지 못했습니다.');
      const location = `${primitive.node}/${primitive.mesh}/${primitive.primitive}`;
      if (used.has(location)) throw Error('원본 메시의 대응이 중복되어 선을 표시하지 않았습니다.');
      used.add(location);
      const attribute = mesh.geometry.getAttribute('_partsmith_source_vertex');
      if (!attribute || attribute.itemSize !== 1 || attribute.count !== primitive.sourceVertices.length ||
        attribute.count !== mesh.geometry.getAttribute('position').count ||
        primitive.sourceVertices.some((source, index) => attribute.getX(index) !== source))
        throw Error('원본 정점 속성이 검사 명세와 달라 선을 표시하지 않았습니다.');
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(primitive.edges.length * 3, 3).setUsage(THREE.DynamicDrawUsage));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#b4e7d2', transparent: true, opacity: 0.75, depthWrite: false }));
      lines.visible = false; lines.frustumCulled = false; lines.renderOrder = 4;
      entry.nativeCounts = primitive.counts;
      views.push({ entry, native, primitive, lines, points: new Map([...new Set(primitive.edges)].map(index => [index, new THREE.Vector3()])) });
    }
    if (used.size !== map.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0)) throw Error('일부 원본 메시를 불러오지 못했습니다.');
    return views;
  } catch (error) { views.forEach(disposeNativeEdgeView); throw error; }
}

/** CPU vertex sampling uses the exact same morph then skin calculation as Three's render mesh. */
export function syncNativeEdgeView(view: NativeEdgeView, enabled: boolean) {
  let visible = enabled;
  for (let parent: THREE.Object3D | null = view.entry.mesh; parent; parent = parent.parent) visible &&= parent.visible;
  view.lines.visible = visible;
  if (!visible) return;
  const mesh = view.entry.mesh; mesh.updateWorldMatrix(true, false);
  for (const [index, point] of view.points) mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
  const attribute = view.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
  view.primitive.edges.forEach((index, offset) => { const p = view.points.get(index)!; attribute.setXYZ(offset, p.x, p.y, p.z); });
  attribute.needsUpdate = true;
}
export function disposeNativeEdgeView(view: NativeEdgeView) {
  view.lines.removeFromParent(); view.lines.geometry.dispose(); (view.lines.material as THREE.Material).dispose();
}
export function nativeCounts(map: NativeTopologyMap, selection?: string, entries: MeshEntry[] = []) {
  const selected = selection ? entries.find(entry => entry.id === selection) : undefined;
  if (selection) return selected?.nativeCounts;
  const meshes = map.meshes;
  return meshes.length ? meshes.reduce((sum, mesh) => ({ vertices: sum.vertices + mesh.counts.vertices,
    edges: sum.edges + mesh.counts.edges, triangles: sum.triangles + mesh.counts.triangles,
    quads: sum.quads + mesh.counts.quads, ngons: sum.ngons + mesh.counts.ngons, polygons: sum.polygons + mesh.counts.polygons }),
  { vertices: 0, edges: 0, triangles: 0, quads: 0, ngons: 0, polygons: 0 }) : undefined;
}
