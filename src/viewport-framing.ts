import * as THREE from "three";

/** Bounds of loaded models only. Scene guides and skeleton overlays are not inputs. */
export function loadedModelBounds(models: Iterable<THREE.Object3D>) {
  const bounds = new THREE.Box3();
  for (const model of models) {
    model.updateWorldMatrix(true, true);
    bounds.expandByObject(model, true);
  }
  return bounds;
}

/** Fit the camera, never normalize or recenter the immutable model itself. */
export function frameModelBounds(
  camera: THREE.PerspectiveCamera,
  bounds: THREE.Box3,
  direction: THREE.Vector3,
  padding = 1.3,
) {
  const values = [...bounds.min.toArray(), ...bounds.max.toArray()];
  if (bounds.isEmpty() || !values.every(Number.isFinite) || !Number.isFinite(camera.aspect) || camera.aspect <= 0)
    return undefined;
  const center = bounds.getCenter(new THREE.Vector3());
  const diagonal = bounds.getSize(new THREE.Vector3()).length();
  if (!(diagonal > 0) || !Number.isFinite(diagonal)) return undefined;
  const back = direction.clone();
  if (!back.toArray().every(Number.isFinite) || back.lengthSq() < 1e-20) back.set(3, 1.35, 4.7);
  back.normalize();
  camera.position.copy(center).add(back);
  camera.lookAt(center);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  // Use the actual camera basis, including lookAt's handling of pole directions.
  back.set(0, 0, 1).applyQuaternion(camera.quaternion);
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
  const horizontal = vertical * camera.aspect;
  let distance = diagonal * 0.01;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).sub(center);
        const depth = point.dot(back);
        distance = Math.max(distance,
          depth + Math.abs(point.dot(right)) * padding / horizontal,
          depth + Math.abs(point.dot(up)) * padding / vertical);
      }
  // Scale clipping and orbit limits with the source, including sub-centimeter assets.
  camera.near = Math.max(diagonal / 1000, Number.EPSILON);
  camera.far = Math.max(distance + diagonal * 100, camera.near * 1000);
  camera.position.copy(center).addScaledVector(back, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return {
    center, distance,
    minDistance: Math.max(diagonal * 0.02, camera.near * 2),
    maxDistance: Math.max(distance * 20, diagonal * 20),
    fogNear: distance + diagonal * 4,
    fogFar: distance + diagonal * 20,
  };
}
