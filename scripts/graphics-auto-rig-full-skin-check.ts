import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { registerFullSkinPreview, type FullSkinPreview } from '../src/viewport-full-skin';
import { meshEntries, gltfMeshIdentities } from '../src/viewport-inspection';
import { rigRegionOverlay } from '../src/viewport-rig-region';

const referencePath = path.resolve('artifacts/runtime/graphics-auto-rig-motion-reference.json');
const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
const glbPath = process.env.PARTSMITH_SKIN_GLB ?? path.join(path.dirname(reference.source), 'character.glb');
const bytes = fs.readFileSync(glbPath);
const loader = new GLTFLoader(), previews: FullSkinPreview[] = [];
registerFullSkinPreview(loader, previews);
const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
if (!previews.length) throw Error('Actual GLB did not use full-influence preview.');
const inspection=JSON.parse(fs.readFileSync(path.join(path.dirname(glbPath),'run-report.json'),'utf8')).inspection;
let overlayProof:object|undefined;
if(inspection?.islands?.some((island:any)=>island.vertexIndices?.length)) {
  const island=inspection.islands.find((item:any)=>item.vertexIndices?.length>0 && item.vertices<100);
  const entries=meshEntries(gltf.scene,'actual',gltfMeshIdentities(gltf.scene,gltf.parser));
  const overlay=rigRegionOverlay(entries,island);overlay.update();
  overlayProof={mesh:island.mesh,islandId:island.islandId,sourceVertices:island.vertices,coveredVertices:overlay.coveredVertices,renderPoints:overlay.points.geometry.getAttribute('position').count};overlay.dispose();
  if(overlay.coveredVertices!==island.vertices) throw Error('Actual bounded accessory island highlight incomplete');
}
const nativeRest = Object.values(reference.rest).flat() as number[][];
const posed = Object.fromEntries(Object.entries(reference.poses).map(([name, meshes]) => [name, Object.values(meshes as object).flat() as number[][]]));
const mappings = previews.map(preview => {
  const position = preview.mesh.geometry.getAttribute('position'), point = new THREE.Vector3();
  return Array.from({ length: position.count }, (_, index) => {
    point.fromBufferAttribute(position, index).applyMatrix4(preview.mesh.matrixWorld);
    let best = Infinity, match = -1;
    for (let native = 0; native < nativeRest.length; native++) {
      const xyz = nativeRest[native], distance = (point.x-xyz[0])**2 + (point.y-xyz[1])**2 + (point.z-xyz[2])**2;
      if (distance < best) { best = distance; match = native; }
    }
    if (Math.sqrt(best) > 1e-5) throw Error(`Rest correspondence mismatch ${Math.sqrt(best)}`);
    const matches: number[] = [];
    for (let native = 0; native < nativeRest.length; native++) { const xyz = nativeRest[native]; if (Math.hypot(point.x-xyz[0],point.y-xyz[1],point.z-xyz[2]) < 1e-6) matches.push(native); }
    return matches.length ? matches : [match];
  });
});
const mixer = new THREE.AnimationMixer(gltf.scene), results: object[] = [];
for (const clip of gltf.animations) {
  if (!posed[clip.name]) throw Error(`Missing independent reference ${clip.name}`);
  // Blender GLB retains absolute frame time: frame 13 is 13/24, not (13-1)/24.
  mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.setTime(reference.sampleFrame/reference.fps); gltf.scene.updateMatrixWorld(true);
  const start = performance.now(); previews.forEach(preview => preview.update()); const duration = performance.now() - start;
  let maximum = 0, rows = 0;
  previews.forEach((preview, meshIndex) => {
    const position = preview.mesh.geometry.getAttribute('position'), point = new THREE.Vector3();
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position,index).applyMatrix4(preview.mesh.matrixWorld);
      const error = Math.min(...mappings[meshIndex][index].map(native => { const target = posed[clip.name][native]; return Math.hypot(point.x-target[0],point.y-target[1],point.z-target[2]); }));
      maximum = Math.max(maximum, error); rows++;
    }
  });
  results.push({ clip: clip.name, maximumError: maximum, rows, cpuMilliseconds: duration });
  // Preserve all diagnostics before evaluating the independent comparison.
}
const durations: number[] = [];
for (let frame = 0; frame < 60; frame++) { mixer.update(1/30); gltf.scene.updateMatrixWorld(true); const start = performance.now(); previews.forEach(preview => preview.update()); durations.push(performance.now()-start); }
durations.sort((a,b)=>a-b);
const report = { glbPath, referencePath, fullSkinMeshes: previews.length, maximumInfluences: Math.max(...previews.map(preview=>preview.influences)), overlayProof, results, performance: { samples: durations.length, medianMs: durations[30], p95Ms: durations[57] }, passed: results.every((result:any)=>result.maximumError<2e-5) };
fs.writeFileSync(path.resolve('artifacts/runtime/graphics-auto-rig-full-skin-check.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if (!report.passed) process.exitCode=1;
