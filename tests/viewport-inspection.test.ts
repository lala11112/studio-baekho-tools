import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { meshEntries, gltfMeshIdentities, inspectMeshes, showMeshAppearance, syncMeshWire, disposeMeshInspection } from "../src/viewport-inspection";

test("inspection enumerates actual meshes, preserves native IDs, counts primitives and freezes whole/selected baseline bounds", () => {
  const root = new THREE.Group(), first = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3)), second = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
  first.name = "ActualBody"; first.userData.partsmith_id = "native-body-id"; first.position.y = 1;
  second.name = "ActualLid"; second.position.set(3, 2, 0); root.add(first, second);
  const entries = meshEntries(root, "asset");
  assert.equal(entries.length, 2); assert.equal(entries[0].sourceId, "native-body-id"); assert.equal(entries[1].sourceId, undefined);
  const baseline = inspectMeshes(entries);
  assert.equal(baseline.triangles, 24); assert.equal(baseline.vertices, 48); assert.equal(baseline.materials, 2);
  assert.deepEqual(baseline.measurement?.size, [4.5, 2.5, 3]);
  first.position.y = 20; first.visible = false; second.scale.setScalar(3);
  assert.deepEqual(inspectMeshes(entries).measurement, baseline.measurement, "animation/hidden changes cannot redefine physical dimensions");
  const sized = inspectMeshes(entries, { scale: [2, 2, 2], translation: [0, 1, 0] });
  assert.deepEqual(sized.measurement?.size, [9, 5, 6]);
  assert.deepEqual(inspectMeshes([entries[1]]).measurement?.size, [2, 1, 1]);
  entries.forEach(disposeMeshInspection);
});

test("material/solid/highlight modes do not alter native materials, maps, geometry, or disposal ownership", () => {
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, color: "#365489", roughness: 0.2 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [material, material]);
  const [entry] = meshEntries(mesh, "asset");
  const original = mesh.material, json = material.toJSON(), geometry = mesh.geometry;
  let sourceDisposed = 0, textureDisposed = 0, geometryDisposed = 0;
  material.addEventListener("dispose", () => sourceDisposed++); texture.addEventListener("dispose", () => textureDisposed++);
  geometry.addEventListener("dispose", () => geometryDisposed++);
  for (const [solid, selected] of [[false, true], [true, false], [true, true], [false, false]]) {
    showMeshAppearance(entry, solid, selected);
    assert.deepEqual(material.toJSON(), json); assert.equal(mesh.geometry, geometry);
  }
  assert.equal(mesh.material, original);
  disposeMeshInspection(entry);
  assert.deepEqual([sourceDisposed, textureDisposed, geometryDisposed], [0, 0, 0]);
});

test("wire render shares the animated skin and morph deformation exactly across translated/scaled hierarchy", () => {
  const root = new THREE.Group(), scene = new THREE.Scene(); scene.add(root);
  root.position.set(3, -2, 4); root.scale.setScalar(0.25);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 2, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 3, 0.5], 3)];
  const parent = new THREE.Bone(), child = new THREE.Bone(); child.position.y = 1; parent.add(child);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial()); mesh.add(parent); root.add(mesh);
  scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([parent, child]));
  const [entry] = meshEntries(root, "rig"), wire = entry.wire as THREE.SkinnedMesh; scene.add(wire);
  const baseline = inspectMeshes([entry]).measurement;
  assert.equal(wire.geometry, mesh.geometry); assert.equal(wire.skeleton, mesh.skeleton);
  for (const t of [0, 0.3, 0.9, 1.4, 2]) {
    child.rotation.z = t; child.position.x = t * 0.5;
    mesh.morphTargetInfluences![0] = t / 2;
    root.rotation.y = t * 0.2;
    scene.updateMatrixWorld(true); syncMeshWire(entry, true); scene.updateMatrixWorld(true);
    for (let i = 0; i < 3; i++) {
      const originalPoint = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      const overlayPoint = wire.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(wire.matrixWorld);
      assert.ok(originalPoint.distanceTo(overlayPoint) < 1e-10, `pose ${t}, vertex ${i}: wire detached`);
    }
    assert.deepEqual(inspectMeshes([entry]).measurement, baseline);
  }
  mesh.visible = false; syncMeshWire(entry, true); assert.equal(wire.visible, false);
  mesh.visible = true; root.visible = false; syncMeshWire(entry, true); assert.equal(wire.visible, false);
  root.visible = true; syncMeshWire(entry, false); assert.equal(wire.visible, false);
  disposeMeshInspection(entry);
  assert.equal(mesh.visible, true); assert.equal(mesh.material, entry.original);
});

test("distinct duplicate names remain separately selectable; no guessed anatomical part or original polygon count", () => {
  const root = new THREE.Group();
  for (const value of [0, 1]) { const mesh = new THREE.Mesh(new THREE.SphereGeometry()); mesh.name = "Body"; mesh.position.x = value; root.add(mesh); }
  const entries = meshEntries(root, "asset");
  assert.notEqual(entries[0].id, entries[1].id);
  assert.ok(entries.every(entry => entry.name === "Body" && entry.sourceId === undefined));
  assert.equal("polygons" in inspectMeshes(entries), false);
  entries.forEach(disposeMeshInspection);
});

test("GLTF canonical node names prevent sanitized Body.Mesh selection from editing the different BodyMesh object", () => {
  const root = new THREE.Group(), first = new THREE.Mesh(new THREE.BoxGeometry()), second = new THREE.Mesh(new THREE.BoxGeometry());
  first.name = "BodyMesh"; second.name = "BodyMesh_1"; root.add(first, second);
  first.userData.name = "BodyMesh"; // Even extra metadata cannot override parser JSON identity.
  const parser = { associations: new Map([[first, { nodes: 0, meshes: 0 }], [second, { nodes: 1, meshes: 1 }]]),
    json: { nodes: [{ name: "Body.Mesh", mesh: 0 }, { name: "BodyMesh", mesh: 1 }] } };
  const entries = meshEntries(root, "asset", gltfMeshIdentities(root, parser));
  assert.equal(entries[0].sourceName, "Body.Mesh"); assert.equal(entries[1].sourceName, "BodyMesh");
  assert.equal(entries[0].sourceId, undefined);
  entries.forEach(disposeMeshInspection);
  parser.json.nodes[1].name = "Body.Mesh";
  const duplicate = meshEntries(root, "asset", gltfMeshIdentities(root, parser));
  assert.ok(duplicate.every(entry => entry.sourceName === "" && !entry.sourceId));
  duplicate.forEach(disposeMeshInspection);
});

test("GLTF multi-primitive inspection resolves native parent name instead of a generated primitive suffix", () => {
  const root = new THREE.Group(), parent = new THREE.Group(), primitive = new THREE.Mesh(new THREE.BoxGeometry());
  parent.name = "BodyMesh"; primitive.name = "SharedMesh_1"; parent.add(primitive); root.add(parent);
  const parser = { associations: new Map<THREE.Object3D, { nodes?: number; meshes?: number; primitives?: number }>([
    [parent, { nodes: 0 }], [primitive, { meshes: 0, primitives: 1 }]]),
    json: { nodes: [{ name: "Body.Mesh", mesh: 0, extras: { partsmith_id: "native-body" } }] } };
  const [entry] = meshEntries(root, "asset", gltfMeshIdentities(root, parser));
  assert.equal(entry.sourceName, "Body.Mesh"); assert.equal(entry.sourceId, "native-body");
  assert.match(entry.name, /표면 2/);
  disposeMeshInspection(entry);
  parser.associations.delete(parent);
  const [unresolved] = meshEntries(root, "asset", gltfMeshIdentities(root, parser));
  assert.equal(unresolved.sourceName, ""); assert.equal(unresolved.sourceId, undefined);
  disposeMeshInspection(unresolved);
});
