import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fullSkinPreview } from '../src/viewport-full-skin';
import { registerFullSkinPreview, type FullSkinPreview } from '../src/viewport-full-skin';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rigRegionOverlay } from '../src/viewport-rig-region';
import { meshEntries, syncMeshWire } from '../src/viewport-inspection';

test('CPU preview uses fifth influence for positions, normals, bounds, raycasts and wire without editing original geometry', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1],3));
  const a = new THREE.Bone(), b = new THREE.Bone(), root = new THREE.Group(); root.add(a,b);
  const mesh = new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})); root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([a,b]));
  const joints0 = new THREE.Uint16BufferAttribute([0,0,0,0,0,0,0,0,0,0,0,0],4), weights0 = new THREE.Float32BufferAttribute([.6,0,0,0,.6,0,0,0,.6,0,0,0],4);
  const joints1 = new THREE.Uint16BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0],4), weights1 = new THREE.Float32BufferAttribute([.4,0,0,0,.4,0,0,0,.4,0,0,0],4);
  const original = Array.from(geometry.getAttribute('position').array);
  const preview = fullSkinPreview(mesh,[{joints:joints0,weights:weights0},{joints:joints1,weights:weights1}]);
  b.position.x=10; b.rotation.x=Math.PI/2; root.updateMatrixWorld(true); preview.update();
  assert.ok(Math.abs(mesh.geometry.getAttribute('position').getX(0)-4)<1e-6);
  assert.deepEqual(Array.from(geometry.getAttribute('position').array),original);
  assert.ok(Math.abs(weights0.getX(0)-.6)<1e-6);
  const expected = new THREE.Vector3(0,-.4,.6).normalize();
  const actual = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('normal'),0);
  assert.ok(actual.distanceTo(expected)<1e-6);
  assert.ok(mesh.boundingBox.min.x>3.99);
  assert.ok(Math.abs(mesh.getVertexPosition(0,new THREE.Vector3()).x-4)<1e-6);
  const hits = new THREE.Raycaster(new THREE.Vector3(4.1,.1,5),new THREE.Vector3(0,0,-1)).intersectObject(mesh);
  assert.ok(hits.length>0);
  const entries = meshEntries(root,'source'); assert.equal(entries.length,1); syncMeshWire(entries[0],true);
  assert.equal(entries[0].wire.geometry,mesh.geometry);
  assert.equal((entries[0].wire as THREE.SkinnedMesh).isSkinnedMesh,false);
  mesh.userData.partsmith_source_mesh='jacket';
  mesh.geometry.setAttribute('_partsmith_vertex',new THREE.Int32BufferAttribute([12,13,14],1));
  const overlay=rigRegionOverlay(entries,{mesh:'jacket',islandId:'exact',vertexIndices:[12,14]});overlay.update();
  assert.equal(overlay.coveredVertices,2);assert.equal(overlay.points.geometry.getAttribute('position').count,2);
  assert.ok(Math.abs(overlay.points.geometry.getAttribute('position').getX(0)-4)<1e-6);
  assert.throws(()=>rigRegionOverlay(entries,{mesh:'different-native-name',islandId:'exact',vertexIndices:[12]}),/정점 표시/);
  overlay.dispose();
  preview.update(); assert.ok(Math.abs(mesh.geometry.getAttribute('position').getX(0)-4)<1e-6, 'No double skinning or accumulated deformation');
});

test('unsupported morphs and invalid weight rows fail explicitly', () => {
  const geometry = new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));
  const mesh = new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());
  mesh.morphTargetInfluences=[0];
  assert.throws(()=>fullSkinPreview(mesh,[]),/모프/);
});

test('loader snapshots WEIGHTS_0 before Three normalizes only its first four influences', async () => {
  const values = [new Float32Array([0,0,0,1,0,0,0,1,0]),new Uint16Array(12),new Float32Array([.6,0,0,0,.6,0,0,0,.6,0,0,0]),new Uint16Array([1,0,0,0,1,0,0,0,1,0,0,0]),new Float32Array([.4,0,0,0,.4,0,0,0,.4,0,0,0])];
  const views: {buffer:number;byteOffset:number;byteLength:number}[] = []; let offset=0;
  for (const value of values) { views.push({buffer:0,byteOffset:offset,byteLength:value.byteLength}); offset+=value.byteLength; }
  const buffer=Buffer.concat(values.map(value=>Buffer.from(value.buffer)));
  const json={asset:{version:'2.0'},buffers:[{byteLength:buffer.length,uri:'data:application/octet-stream;base64,'+buffer.toString('base64')}],bufferViews:views,
    accessors:values.map((value,index)=>({bufferView:index,componentType:value instanceof Uint16Array?5123:5126,count:3,type:index===0?'VEC3':'VEC4',...(index===0?{min:[0,0,0],max:[1,1,0]}:{})})),
    meshes:[{primitives:[{attributes:{POSITION:0,JOINTS_0:1,WEIGHTS_0:2,JOINTS_1:3,WEIGHTS_1:4}}]}],skins:[{joints:[1,2]}],nodes:[{mesh:0,skin:0},{name:'boneA'},{name:'boneB'}],scenes:[{nodes:[0,1,2]}],scene:0};
  const loader=new GLTFLoader(),previews:FullSkinPreview[]=[];registerFullSkinPreview(loader,previews);
  const prior=(globalThis as any).ProgressEvent;
  (globalThis as any).ProgressEvent=class{constructor(public type:string,public details:unknown){}};
  try {
    const gltf=await loader.parseAsync(JSON.stringify(json),''); assert.equal(previews.length,1);
    const mesh=previews[0].mesh; mesh.skeleton.bones[1].position.x=10;gltf.scene.updateMatrixWorld(true);previews[0].update();
    assert.ok(Math.abs(mesh.geometry.getAttribute('position').getX(0)-4)<1e-6);
    assert.ok(Math.abs(mesh.geometry.getAttribute('skinWeight').getX(0)-.6)<1e-6);
  } finally {(globalThis as any).ProgressEvent=prior;}
});
