import * as THREE from 'three';

/** Display-only transform. Source geometry and each model's own transform stay untouched. */
export function headComparisonTransform(bounds: THREE.Box3) {
  const height = bounds.max.y - bounds.min.y;
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray(), height].every(Number.isFinite) || height <= 1e-12) throw Error('머리의 표시 높이를 확인할 수 없습니다.');
  const scale = 1 / height, translation = bounds.getCenter(new THREE.Vector3()).multiplyScalar(-scale);
  const matrix = new THREE.Matrix4().compose(translation, new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
  return { scale, translation, height, bounds: bounds.clone().applyMatrix4(matrix) };
}

export function headComparisonViewportSize(width: number, height: number) {
  const paneWidth = Math.floor((width - 1) / 2);
  if (paneWidth < 1 || height < 1) return undefined;
  return { paneWidth, height, right: width - paneWidth, aspect: paneWidth / height };
}

type SplitRenderer = Pick<THREE.WebGLRenderer, 'setScissorTest' | 'clear' | 'setViewport' | 'setScissor' | 'render'>;
/** Both passes use the same camera and equal pixel widths, with no per-model camera fit. */
export function renderHeadComparison(renderer: SplitRenderer, scenes: [THREE.Scene, THREE.Scene], camera: THREE.PerspectiveCamera, width: number, height: number) {
  const view = headComparisonViewportSize(width, height);
  if (!view) return;
  camera.aspect = view.aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  renderer.setScissorTest(false); renderer.clear(); renderer.setScissorTest(true);
  for (const [index, scene] of scenes.entries()) {
    const x = index === 0 ? 0 : view.right;
    renderer.setViewport(x, 0, view.paneWidth, view.height);
    renderer.setScissor(x, 0, view.paneWidth, view.height);
    renderer.render(scene, camera);
  }
  renderer.setScissorTest(false);
}

export function headComparisonScene(environment: THREE.Texture) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#151a1b'); scene.environment = environment; scene.environmentIntensity = .7;
  scene.add(new THREE.HemisphereLight(0xdce8df, 0x3d4844, .8));
  const key = new THREE.DirectionalLight(0xffebd4, 1.8); key.position.set(3, 5, 3); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8fbcff, .6); fill.position.set(-3, 3, -2); scene.add(fill);
  return scene;
}
