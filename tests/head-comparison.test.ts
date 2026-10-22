import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { headComparisonScene, headComparisonTransform, headComparisonViewportSize, renderHeadComparison } from '../src/head-comparison';
import { frameModelBounds, loadedModelBounds } from '../src/viewport-framing';

test('comparison uses uniform display parents with equal height without changing source geometry or transforms', () => {
  const models = [new THREE.Mesh(new THREE.BoxGeometry(2, 4, 3)), new THREE.Mesh(new THREE.BoxGeometry(20, 30, 25))];
  models[0].position.set(0, 18, -4); models[1].position.set(12, -7, 10); models[1].scale.setScalar(3);
  for (const model of models) {
    const positions = [...model.geometry.attributes.position.array], position = model.position.toArray(), scale = model.scale.toArray();
    const bounds = loadedModelBounds([model]), originalSize = bounds.getSize(new THREE.Vector3());
    const transform = headComparisonTransform(bounds), parent = new THREE.Group();
    parent.scale.setScalar(transform.scale); parent.position.copy(transform.translation); parent.add(model);
    const displayBounds = loadedModelBounds([parent]), displaySize = displayBounds.getSize(new THREE.Vector3());
    assert.ok(Math.abs(displaySize.y - 1) < 1e-10);
    assert.ok(displayBounds.getCenter(new THREE.Vector3()).length() < 1e-10);
    assert.ok(Math.abs(displaySize.x / displaySize.y - originalSize.x / originalSize.y) < 1e-10);
    assert.deepEqual([...model.geometry.attributes.position.array], positions);
    assert.deepEqual(model.position.toArray(), position); assert.deepEqual(model.scale.toArray(), scale);
  }
  assert.throws(() => headComparisonTransform(new THREE.Box3()));
  assert.throws(() => headComparisonTransform(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 0, 1))));
});

test('both comparison passes have identical camera, projection, viewport size and lighting at every width', () => {
  const environment = new THREE.Texture(), scenes: [THREE.Scene, THREE.Scene] = [headComparisonScene(environment), headComparisonScene(environment)];
  assert.equal(scenes[0].environment, scenes[1].environment);
  assert.deepEqual(scenes[0].children.map(light => [light.type, light.position.toArray(), (light as THREE.Light).color.toArray(), (light as THREE.Light).intensity]), scenes[1].children.map(light => [light.type, light.position.toArray(), (light as THREE.Light).color.toArray(), (light as THREE.Light).intensity]));
  const common = headComparisonTransform(new THREE.Box3(new THREE.Vector3(-2, -2, -1), new THREE.Vector3(2, 2, 1))).bounds;
  common.union(headComparisonTransform(new THREE.Box3(new THREE.Vector3(-6, -3, -2), new THREE.Vector3(6, 3, 2))).bounds);
  for (const width of [1600, 801, 480]) {
    const camera = new THREE.PerspectiveCamera(35, headComparisonViewportSize(width, 400)!.aspect, .001, 100);
    frameModelBounds(camera, common, new THREE.Vector3(0, 0, 1), 1.2);
    const viewports: number[][] = [], renders: { camera: THREE.Camera; projection: number[]; matrix: number[] }[] = [];
    const renderer = { setScissorTest() {}, clear() {}, setViewport: (...args: number[]) => { viewports.push(args); }, setScissor() {}, render: (_scene: THREE.Object3D, view: THREE.Camera) => { renders.push({ camera: view, projection: view.projectionMatrix.toArray(), matrix: view.matrixWorld.toArray() }); } };
    renderHeadComparison(renderer as unknown as THREE.WebGLRenderer, scenes, camera, width, 400);
    assert.equal(renders.length, 2); assert.equal(renders[0].camera, renders[1].camera);
    assert.deepEqual(renders[0].projection, renders[1].projection); assert.deepEqual(renders[0].matrix, renders[1].matrix);
    assert.deepEqual(viewports[0].slice(2), viewports[1].slice(2));
    for (const x of [common.min.x, common.max.x]) for (const y of [common.min.y, common.max.y]) for (const z of [common.min.z, common.max.z]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1);
    }
  }
});
