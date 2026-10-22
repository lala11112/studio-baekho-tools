import {test} from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {skeletonOverlay} from "../src/skeleton-overlay";
test("overlay uses actual skin bones and follows transformed/posed joints without changing mesh materials",()=>{
  const root=new THREE.Group(), parent=new THREE.Bone(), child=new THREE.Bone();
  parent.add(child); child.position.y=1; root.add(parent); root.position.x=2;
  const material=new THREE.MeshBasicMaterial(), mesh=new THREE.SkinnedMesh(new THREE.BufferGeometry(),material);
  mesh.bind(new THREE.Skeleton([parent,child]));root.add(mesh);
  const overlay=skeletonOverlay(root)!;assert.equal(overlay.count,2);overlay.update();
  const points=overlay.overlay.children[1] as THREE.Points;
  const position=points.geometry.getAttribute("position");
  assert.equal(position.getX(0),2);assert.equal(position.getY(1),1);
  child.position.y=2;overlay.update();assert.equal(position.getY(1),2);
  overlay.overlay.visible=false;assert.equal(mesh.material,material);assert.equal(mesh.visible,true);
  assert.equal(skeletonOverlay(new THREE.Group()),undefined);
});
