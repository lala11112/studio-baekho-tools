import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { frameModelBounds, loadedModelBounds } from "../src/viewport-framing";
import { skeletonOverlay } from "../src/skeleton-overlay";

function assertFramed(camera: THREE.PerspectiveCamera, bounds: THREE.Box3) {
  let occupied = 0;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        assert.ok(Math.abs(projected.x) <= 1 / 1.3 + 1e-6, `horizontal clipping: ${projected.x}`);
        assert.ok(Math.abs(projected.y) <= 1 / 1.3 + 1e-6, `vertical clipping: ${projected.y}`);
        assert.ok(projected.z >= -1 && projected.z <= 1, `depth clipping: ${projected.z}`);
        occupied = Math.max(occupied, Math.abs(projected.x), Math.abs(projected.y));
      }
  // An entire model in a few pixels must fail even if all corners are in the frustum.
  assert.ok(occupied >= 0.7, `model occupies too little viewport: ${occupied}`);
  const center = bounds.getCenter(new THREE.Vector3()).project(camera);
  assert.ok(Math.abs(center.x) < 1e-6 && Math.abs(center.y) < 1e-6);
}

test("camera fits tiny, meter-scale, and large off-center swords without changing source transforms or vertices", () => {
  const distances: number[] = [];
  for (const scale of [0.001, 1, 10000]) {
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.28, 2, 0.06));
    sword.scale.setScalar(scale);
    sword.position.set(3 * scale, -7 * scale, 11 * scale);
    sword.rotation.set(0.1, 0.45, 0.2);
    const geometry = [...sword.geometry.getAttribute("position").array];
    const transform = [sword.position.toArray(), sword.quaternion.toArray(), sword.scale.toArray()];
    const bounds = loadedModelBounds([sword]);
    const camera = new THREE.PerspectiveCamera(35, 1.4, 0.01, 100);
    const framing = frameModelBounds(camera, bounds, new THREE.Vector3(3, 1.35, 4.7))!;
    assertFramed(camera, bounds);
    assert.ok(framing.minDistance < framing.distance && framing.maxDistance > framing.distance);
    assert.ok(framing.fogNear > framing.distance + bounds.getSize(new THREE.Vector3()).length() / 2);
    assert.deepEqual([sword.position.toArray(), sword.quaternion.toArray(), sword.scale.toArray()], transform);
    assert.deepEqual([...sword.geometry.getAttribute("position").array], geometry);
    distances.push(framing.distance / scale);
  }
  assert.ok(distances.every(value => Math.abs(value - distances[0]) < 1e-8));
});

test("resize and front/side/back/reset views frame all model corners in portrait and landscape viewports", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(97, -4, 6), new THREE.Vector3(100, -2, 7));
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  for (const aspect of [0.35, 1, 2.5]) {
    camera.aspect = aspect;
    for (const direction of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(3, 1.35, 4.7)]) {
      const framing = frameModelBounds(camera, bounds, direction)!;
      assertFramed(camera, bounds);
      const actual = camera.position.clone().sub(framing.center).normalize();
      assert.ok(actual.dot(direction.clone().normalize()) > 1 - 1e-12);
    }
  }
});

test("multipart bounds use nested world transforms and exclude scene guides and skeleton overlays", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.GridHelper(1000, 10), new THREE.AxesHelper(200));
  const models = [new THREE.Group(), new THREE.Group()];
  for (const [index, model] of models.entries()) {
    model.position.set(index * 4, index * 2, 0);
    const child = new THREE.Group();
    child.position.set(1, 2, 3);
    child.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3)));
    model.add(child);
    scene.add(model);
  }
  const bounds = loadedModelBounds(models);
  assert.deepEqual(bounds.min.toArray(), [0.5, 1, 1.5]);
  assert.deepEqual(bounds.max.toArray(), [5.5, 5, 4.5]);
  const camera = new THREE.PerspectiveCamera(35, 1.2, 0.01, 100);
  frameModelBounds(camera, bounds, new THREE.Vector3(3, 1.35, 4.7));
  assertFramed(camera, bounds);
});

test("posed skin bounds frame current deformed vertices while preserving bones, weights and overlay", () => {
  const root = new THREE.Group();
  const parent = new THREE.Bone(), child = new THREE.Bone();
  child.position.y = 1;
  parent.add(child);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.1, 0, 0, 0.1, 0, 0, 0, 2, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(parent);
  mesh.bind(new THREE.Skeleton([parent, child]));
  root.add(mesh);
  const restBounds = loadedModelBounds([root]);
  child.position.x = 3;
  child.rotation.z = Math.PI / 2;
  const overlay = skeletonOverlay(root)!;
  const transform = [child.position.toArray(), child.quaternion.toArray()];
  const vertices = [...geometry.getAttribute("position").array];
  const weights = [...geometry.getAttribute("skinWeight").array];
  const bounds = loadedModelBounds([root]);
  assert.ok(bounds.max.x > restBounds.max.x + 1);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  frameModelBounds(camera, bounds, new THREE.Vector3(0, 0, 1));
  assertFramed(camera, bounds);
  overlay.update();
  const points = overlay.overlay.children[1] as THREE.Points;
  assert.equal(points.geometry.getAttribute("position").getX(1), 3);
  assert.deepEqual([child.position.toArray(), child.quaternion.toArray()], transform);
  assert.deepEqual([...geometry.getAttribute("position").array], vertices);
  assert.deepEqual([...geometry.getAttribute("skinWeight").array], weights);
  assert.equal(overlay.count, 2);
});

test("missing or invalid model bounds retain the empty-workspace guide camera", () => {
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(3, 2.2, 4.7);
  const original = camera.toJSON();
  for (const bounds of [loadedModelBounds([]), new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
    new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1))]) {
    assert.equal(frameModelBounds(camera, bounds, new THREE.Vector3()), undefined);
    assert.deepEqual(camera.toJSON(), original);
  }
});
