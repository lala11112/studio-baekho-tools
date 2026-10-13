import * as THREE from "three";

export type MeshSelection = { id: string; name: string; sourceId?: string; sourceName: string };
export type ModelMeasurement = {
  min: [number, number, number]; max: [number, number, number]; size: [number, number, number];
  hasSkin: boolean; hasMorph: boolean; hasAnimation: boolean;
};
export type PreviewTransform = { scale: [number, number, number]; translation?: [number, number, number] };
type MeshNativeIdentity = { name?: string; id?: string; label?: string };
/** GLTFLoader sanitizes/uniquifies Object3D.name for animation bindings. Never use
 * that display alias as a native Blender edit target (Body.Mesh != BodyMesh). */
export function gltfMeshIdentities(root: THREE.Object3D, parser: {
  associations: { get(object: THREE.Object3D): { nodes?: number; meshes?: number; primitives?: number } | undefined };
  json: { nodes?: { name?: string; mesh?: number; extras?: Record<string, unknown> }[]; meshes?: { extras?: Record<string, unknown> }[] };
}) {
  const identities = new WeakMap<THREE.Object3D, MeshNativeIdentity>();
  const nodes = parser.json.nodes ?? [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const association = parser.associations.get(object);
    let node: typeof nodes[number] | undefined;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      const index = parser.associations.get(parent)?.nodes;
      if (index !== undefined && nodes[index]?.mesh !== undefined && nodes[index].mesh === association?.meshes) {
        node = nodes[index]; break;
      }
      if (parent === root) break;
    }
    if (!node) { identities.set(object, {}); return; }
    const name = typeof node.name === "string" && node.name.trim() ? node.name : undefined;
    const ids = [node.extras?.partsmith_id, parser.json.meshes?.[node.mesh!]?.extras?.partsmith_id]
      .filter((id): id is string => typeof id === "string" && !!id.trim());
    const id = new Set(ids).size === 1 ? ids[0] : undefined;
    const primitive = association?.primitives;
    identities.set(object, { label: name ? `${name}${primitive && primitive > 0 ? ` · 표면 ${primitive + 1}` : ""}` : undefined,
      name: name && nodes.filter(candidate => candidate.mesh !== undefined && candidate.name === name).length === 1 ? name : undefined,
      id: id && nodes.filter(candidate => candidate.mesh !== undefined &&
        (candidate.extras?.partsmith_id ?? parser.json.meshes?.[candidate.mesh]?.extras?.partsmith_id) === id).length === 1 ? id : undefined });
  });
  return identities;
}
export type MeshEntry = MeshSelection & {
  nativeCounts?: import('../shared/native-topology').NativeFaceCounts;
  mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; originallyVisible: boolean;
  assetId: string;
  restBounds: THREE.Box3; vertices: number; triangles: number; materials: Set<THREE.Material>;
  wire: THREE.Mesh; displayMaterials: THREE.Material[];
};

const tuple = (v: THREE.Vector3) => v.toArray() as [number, number, number];
export function meshEntries(root: THREE.Object3D, sourceId: string, identities?: WeakMap<THREE.Object3D, MeshNativeIdentity>): MeshEntry[] {
  root.updateWorldMatrix(true, true);
  const entries: MeshEntry[] = [];
  function visit(node: THREE.Object3D, path: string) {
    if (node instanceof THREE.Mesh && node.geometry.getAttribute("position")) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const wireMaterial = new THREE.MeshBasicMaterial({ color: "#9dddc6", wireframe: true, transparent: true,
        opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      // Clone the render object, NOT a static WireframeGeometry: the very same geometry,
      // skeleton/bind matrices and current morph weights drive both render passes.
      const wire = node.clone(false) as THREE.Mesh;
      wire.material = wireMaterial;
      wire.matrixAutoUpdate = false;
      wire.frustumCulled = false;
      wire.renderOrder = 3;
      wire.visible = false;
      const restBounds = new THREE.Box3();
      const point = new THREE.Vector3();
      const position = node.geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++) {
        node.getVertexPosition(i, point);
        restBounds.expandByPoint(point.applyMatrix4(node.matrixWorld));
      }
      if (node instanceof THREE.InstancedMesh) {
        node.computeBoundingBox();
        if (node.boundingBox) restBounds.copy(node.boundingBox).applyMatrix4(node.matrixWorld);
      }
      const instances = node instanceof THREE.InstancedMesh ? node.count : 1;
      const identity = identities?.get(node);
      entries.push({ id: `${sourceId}:${path}`, assetId: sourceId,
        sourceId: identities ? identity?.id : typeof node.userData.partsmith_id === "string" ? node.userData.partsmith_id : undefined,
        sourceName: identities ? identity?.name ?? "" : node.name,
        name: identity?.label || node.name || `메시 ${entries.length + 1}`,
        mesh: node, original: node.material, originallyVisible: node.visible, restBounds,
        vertices: position.count * instances,
        triangles: Math.floor((node.geometry.index?.count ?? position.count) / 3) * instances,
        materials: new Set(materials), wire, displayMaterials: [] });
    }
    node.children.forEach((child, index) => visit(child, `${path}/${index}`));
  }
  visit(root, "0");
  return entries;
}

export function inspectMeshes(entries: MeshEntry[], transform?: PreviewTransform) {
  const bounds = new THREE.Box3();
  const materials = new Set<THREE.Material>();
  let vertices = 0, triangles = 0;
  for (const entry of entries) {
    bounds.union(entry.restBounds); vertices += entry.vertices; triangles += entry.triangles;
    for (const material of entry.materials) materials.add(material);
  }
  if (transform) bounds.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(transform.translation ?? [0, 0, 0]), new THREE.Quaternion(),
    new THREE.Vector3().fromArray(transform.scale)));
  const measurement = bounds.isEmpty() ? undefined : {
    min: tuple(bounds.min), max: tuple(bounds.max), size: tuple(bounds.getSize(new THREE.Vector3())),
    hasSkin: entries.some(entry => entry.mesh instanceof THREE.SkinnedMesh),
    hasMorph: entries.some(entry => !!entry.mesh.morphTargetInfluences?.length),
  };
  return { bounds, vertices, triangles, materials: materials.size, measurement };
}

export function showMeshAppearance(entry: MeshEntry, solid: boolean, selected: boolean) {
  for (const material of entry.displayMaterials) material.dispose();
  entry.displayMaterials = [];
  if (!solid && !selected) { entry.mesh.material = entry.original; return; }
  const originals = Array.isArray(entry.original) ? entry.original : [entry.original];
  entry.displayMaterials = originals.map(original => {
    const material = solid ? new THREE.MeshStandardMaterial({ color: selected ? "#bfe69f" : "#c8d0cf",
      roughness: 0.75, metalness: 0, side: original.side }) : original.clone();
    if (!solid && "emissive" in material && material.emissive instanceof THREE.Color)
      material.emissive.add(new THREE.Color("#284620"));
    return material;
  });
  entry.mesh.material = Array.isArray(entry.original) ? entry.displayMaterials : entry.displayMaterials[0];
}

export function syncMeshWire(entry: MeshEntry, enabled: boolean) {
  const source = entry.mesh;
  let visible = true;
  for (let parent: THREE.Object3D | null = source; parent; parent = parent.parent) visible &&= parent.visible;
  entry.wire.visible = enabled && visible;
  source.updateWorldMatrix(true, false);
  entry.wire.matrix.copy(source.matrixWorld);
  entry.wire.matrixWorld.copy(source.matrixWorld);
  entry.wire.morphTargetInfluences = source.morphTargetInfluences;
  if (source instanceof THREE.SkinnedMesh && entry.wire instanceof THREE.SkinnedMesh) {
    entry.wire.skeleton = source.skeleton;
    entry.wire.bindMatrix.copy(source.bindMatrix);
    entry.wire.bindMatrixInverse.copy(source.bindMatrixInverse);
  }
}

export function disposeMeshInspection(entry: MeshEntry) {
  entry.mesh.material = entry.original;
  entry.mesh.visible = entry.originallyVisible;
  entry.displayMaterials.forEach(material => material.dispose());
  // The wire shares source geometry and textures. Never dispose those here.
  (entry.wire.material as THREE.Material).dispose();
  entry.wire.removeFromParent();
}

export function formatLength(value: number, unitsKnown: boolean) {
  return `${Number(value.toPrecision(5)).toLocaleString("ko-KR", { maximumFractionDigits: 6 })}${unitsKnown ? " m" : " 단위"}`;
}

/** Guides use a whole-model baseline; animation and inspection visibility never resize them. */
export function measurementGuides(bounds: THREE.Box3, unitsKnown: boolean) {
  const group = new THREE.Group();
  if (bounds.isEmpty()) return group;
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 0.001);
  const rawStep = extent / 8;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= rawStep)!;
  const grid = new THREE.GridHelper(step * 20, 20, 0x607b70, 0x34453f);
  grid.position.set(center.x, bounds.min.y - extent * 0.004, center.z);
  group.add(grid);
  const textSize = extent * 0.045;
  function label(text: string, position: THREE.Vector3) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgba(16,24,20,0.85)"; context.fillRect(0, 0, 512, 80);
    context.fillStyle = "#e1ebd9"; context.font = "48px sans-serif"; context.textAlign = "center";
    context.fillText(text, 256, 56);
    const map = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, depthWrite: false }));
    // Labels stay legible as the camera backs up to compare a tiny asset to 1 m.
    sprite.position.copy(position); sprite.scale.set(0.028 * 6.4, 0.028, 1); sprite.renderOrder = 20;
    group.add(sprite);
  }
  function line(a: THREE.Vector3, b: THREE.Vector3, text: string, offset: THREE.Vector3) {
    const points = [a, b];
    const tick = new THREE.Vector3(0, extent * 0.018, 0);
    if (Math.abs(a.y - b.y) > 1e-8) tick.set(extent * 0.018, 0, 0);
    for (const p of [a, b]) points.push(p.clone().sub(tick), p.clone().add(tick));
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: "#b8d7a9", depthTest: false, transparent: true, opacity: 0.85 })));
    label(text, a.clone().add(b).multiplyScalar(0.5).add(offset));
  }
  const margin = extent * 0.12, y = bounds.min.y, front = bounds.max.z + margin;
  line(new THREE.Vector3(bounds.min.x, y, front), new THREE.Vector3(bounds.max.x, y, front),
    `X ${formatLength(size.x, unitsKnown)}`, new THREE.Vector3(0, -textSize, 0));
  line(new THREE.Vector3(bounds.max.x + margin, bounds.min.y, front), new THREE.Vector3(bounds.max.x + margin, bounds.max.y, front),
    `Y ${formatLength(size.y, unitsKnown)}`, new THREE.Vector3(textSize * 2.8, 0, 0));
  line(new THREE.Vector3(bounds.min.x - margin, y, bounds.min.z), new THREE.Vector3(bounds.min.x - margin, y, bounds.max.z),
    `Z ${formatLength(size.z, unitsKnown)}`, new THREE.Vector3(-textSize * 2.7, textSize, 0));
  label(`격자 ${formatLength(step, unitsKnown)}`, new THREE.Vector3(center.x, y, bounds.min.z - margin));
  // When uncalibrated, do not pretend one source unit is a real-world meter.
  if (unitsKnown) line(new THREE.Vector3(bounds.min.x, y, front + margin),
    new THREE.Vector3(bounds.min.x + 1, y, front + margin), "1 m 기준자", new THREE.Vector3(0, textSize, 0));
  return group;
}

export function disposeGuides(group: THREE.Group) {
  group.traverse(node => {
    if (node instanceof THREE.Line || node instanceof THREE.Mesh) node.geometry.dispose();
    const material = (node as THREE.Sprite).material;
    for (const value of Array.isArray(material) ? material : [material]) if (value) {
      if ("map" in value && value.map instanceof THREE.Texture) value.map.dispose();
      value.dispose();
    }
  });
  group.removeFromParent();
}
