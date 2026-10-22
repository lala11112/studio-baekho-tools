import * as THREE from 'three';
import type { MeshEntry } from './viewport-inspection';

export type RigRegion = { mesh: string; islandId: string; vertexIndices: number[] };
export function rigRegionOverlay(entries: MeshEntry[], region: RigRegion) {
  const selected = new Set(region.vertexIndices);
  if (!selected.size || selected.size !== region.vertexIndices.length || region.vertexIndices.some(index => !Number.isInteger(index) || index < 0)) throw Error('선택 부위의 원본 정점 정보가 올바르지 않습니다.');
  const matches: { mesh: THREE.Mesh; indices: number[] }[] = [];
  const covered = new Set<number>();
  for (const entry of entries) {
    if (entry.mesh.userData.partsmith_source_mesh !== region.mesh) continue;
    const ids = entry.mesh.geometry.getAttribute('_partsmith_vertex');
    if (!ids || ids.itemSize !== 1 || ids.count !== entry.mesh.geometry.getAttribute('position').count) continue;
    const indices: number[] = [];
    for (let index=0;index<ids.count;index++) { const id=ids.getX(index); if(selected.has(id)) { indices.push(index); covered.add(id); } }
    if(indices.length) matches.push({mesh:entry.mesh,indices});
  }
  if(!matches.length) throw Error('이 미리보기에는 선택 부위의 정확한 정점 표시가 없습니다. 최신 부위 검사를 실행하세요.');
  const positions = new THREE.Float32BufferAttribute(new Float32Array(matches.reduce((sum,item)=>sum+item.indices.length,0)*3),3);
  const geometry = new THREE.BufferGeometry().setAttribute('position',positions);
  const material = new THREE.PointsMaterial({color:'#ffb52e',size:5,sizeAttenuation:false,depthTest:false,depthWrite:false});
  const points = new THREE.Points(geometry,material); points.renderOrder=200;points.frustumCulled=false;
  const point = new THREE.Vector3();
  return { points, coveredVertices:covered.size, update() {
    let row=0;
    for(const {mesh,indices} of matches) for(const index of indices) { mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld); positions.setXYZ(row++,point.x,point.y,point.z); }
    positions.needsUpdate=true;
  }, dispose() { points.removeFromParent();geometry.dispose();material.dispose(); } };
}
