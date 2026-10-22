import * as THREE from 'three';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
type SkinSet = { joints: Attribute; weights: Attribute };
export type FullSkinPreview = { mesh: THREE.SkinnedMesh; influences: number; update: () => void };

/** Evaluate every stored influence. Input attributes and source files are never edited. */
export function fullSkinPreview(mesh: THREE.SkinnedMesh, sets: SkinSet[]): FullSkinPreview {
  if (mesh.morphTargetInfluences?.length) throw Error('이 다중 가중치 모델의 표정·모프 미리보기는 지원하지 않습니다.');
  if (!sets.length || sets.some(set => set.joints.itemSize !== 4 || set.weights.itemSize !== 4)) throw Error('다중 가중치 미리보기 속성이 올바르지 않습니다.');
  const original = mesh.geometry;
  const sourcePosition = original.getAttribute('position');
  const sourceNormal = original.getAttribute('normal');
  const sourceTangent = original.getAttribute('tangent');
  if (sets.some(set => set.joints.count !== sourcePosition.count || set.weights.count !== sourcePosition.count)) throw Error('다중 가중치의 정점 개수가 다릅니다.');
  const geometry = original.clone();
  // GLTFLoader's four-weight normalization is deliberately discarded here.
  geometry.setAttribute('skinWeight', sets[0].weights.clone());
  mesh.geometry = geometry;
  (mesh as unknown as { isSkinnedMesh: boolean }).isSkinnedMesh = false;
  mesh.userData.partsmithFullSkin = true;
  // SkinnedMesh raycasts/bounds use this method, while the geometry is already posed.
  mesh.applyBoneTransform = (_index, target) => target;
  mesh.frustumCulled = false;
  const point = new THREE.Vector3(), normal = new THREE.Vector3(), tangent = new THREE.Vector3();
  const skin = new THREE.Matrix4(), bone = new THREE.Matrix4(), bound = new THREE.Matrix4();
  const position = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), tangents = geometry.getAttribute('tangent');
  const update = () => {
    mesh.updateWorldMatrix(true, false);
    for (const bone of mesh.skeleton.bones) bone.updateWorldMatrix(true, false);
    mesh.skeleton.update();
    for (let vertex = 0; vertex < sourcePosition.count; vertex++) {
      skin.elements.fill(0);
      let total = 0;
      for (const set of sets) for (let component = 0; component < 4; component++) {
        const weight = set.weights.getComponent(vertex, component);
        if (!Number.isFinite(weight) || weight < 0) throw Error('유효하지 않은 가중치가 있어 동작 미리보기를 중단했습니다.');
        if (!weight) continue;
        const index = set.joints.getComponent(vertex, component);
        if (!Number.isInteger(index) || index < 0 || index >= mesh.skeleton.bones.length) throw Error('유효하지 않은 뼈 번호가 있어 동작 미리보기를 중단했습니다.');
        bone.fromArray(mesh.skeleton.boneMatrices, index * 16);
        for (let entry = 0; entry < 16; entry++) skin.elements[entry] += bone.elements[entry] * weight;
        total += weight;
      }
      if (Math.abs(total - 1) > 0.002) throw Error('전체 가중치 합이 1이 아니어서 동작 미리보기를 중단했습니다.');
      bound.multiplyMatrices(mesh.bindMatrixInverse, skin).multiply(mesh.bindMatrix);
      point.fromBufferAttribute(sourcePosition, vertex);
      const e = bound.elements, x = point.x, y = point.y, z = point.z;
      point.set(e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]);
      position.setXYZ(vertex, point.x, point.y, point.z);
      if (sourceNormal && normals) {
        normal.fromBufferAttribute(sourceNormal, vertex).transformDirection(bound);
        normals.setXYZ(vertex, normal.x, normal.y, normal.z);
      }
      if (sourceTangent && tangents) {
        tangent.fromBufferAttribute(sourceTangent, vertex).transformDirection(bound);
        tangents.setXYZW(vertex, tangent.x, tangent.y, tangent.z, sourceTangent.getW(vertex));
      }
    }
    position.needsUpdate = true;
    if (normals) normals.needsUpdate = true;
    if (tangents) tangents.needsUpdate = true;
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    if (geometry.boundingBox) mesh.boundingBox = geometry.boundingBox.clone();
    if (geometry.boundingSphere) mesh.boundingSphere = geometry.boundingSphere.clone();
  };
  return { mesh, influences: sets.length * 4, update };
}

/** Snapshot accessor values before GLTFLoader normalizes WEIGHTS_0 in place. */
export function registerFullSkinPreview(loader: GLTFLoader, previews: FullSkinPreview[]) {
  loader.register((parser: GLTFParser) => {
    const snapshots = new Map<number, Attribute>();
    return {
      name: 'PARTSMITH_full_influence_preview',
      beforeRoot: async () => {
        const accessors = new Set<number>();
        for (const mesh of parser.json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
          if (primitive.attributes?.JOINTS_1 == null) continue;
          for (const [name, index] of Object.entries(primitive.attributes)) if (/^(JOINTS|WEIGHTS)_\d+$/.test(name)) accessors.add(index as number);
        }
        await Promise.all([...accessors].map(async index => snapshots.set(index, (await parser.getDependency('accessor', index) as Attribute).clone())));
      },
      afterRoot: async (result: GLTF) => {
        result.scene.updateMatrixWorld(true);
        result.scene.traverse(node => {
          if (!(node instanceof THREE.SkinnedMesh)) return;
          const association = parser.associations.get(node) as { meshes?: number; primitives?: number } | undefined;
          if (association?.meshes == null || association.primitives == null) return;
          const attributes = parser.json.meshes[association.meshes].primitives[association.primitives].attributes;
          if (attributes.JOINTS_1 == null) return;
          const sets: SkinSet[] = [];
          for (let index = 0; attributes[`JOINTS_${index}`] != null; index++) {
            const joints = snapshots.get(attributes[`JOINTS_${index}`]), weights = snapshots.get(attributes[`WEIGHTS_${index}`]);
            if (!joints || !weights) throw Error('다중 가중치 원본을 복원하지 못해 동작 미리보기를 중단했습니다.');
            sets.push({ joints, weights });
          }
          const preview = fullSkinPreview(node, sets); preview.update(); previews.push(preview);
        });
      },
    };
  });
}
