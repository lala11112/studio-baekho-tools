import * as THREE from "three";

/** Display the loaded skin's real bones without editing the rig or materials. */
export function skeletonOverlay(root: THREE.Object3D) {
  const bones = new Set<THREE.Bone>();
  root.traverse((node) => {
    if (node instanceof THREE.SkinnedMesh)
      node.skeleton.bones.forEach(bone => bones.add(bone));
  });
  if (!bones.size) return undefined;
  const overlay = new THREE.Group();
  const lines = new THREE.SkeletonHelper(root);
  const material = lines.material as THREE.LineBasicMaterial;
  material.depthTest = false; material.depthWrite = false;
  material.vertexColors = false; material.color.set("#65f5df");
  lines.renderOrder = 100;
  const positions = new THREE.BufferAttribute(new Float32Array(bones.size * 3), 3);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", positions);
  const joints = new THREE.Points(geometry, new THREE.PointsMaterial({color: "#ffdb75", size: 5, sizeAttenuation: false, depthTest: false, depthWrite: false}));
  joints.renderOrder = 101; joints.frustumCulled = false;
  overlay.add(lines, joints);
  const position = new THREE.Vector3();
  return {overlay, count: bones.size, update() {
    root.updateWorldMatrix(true, true);
    let index = 0;
    for (const bone of bones) { bone.getWorldPosition(position); positions.setXYZ(index++, position.x, position.y, position.z); }
    positions.needsUpdate = true;
  }};
}
