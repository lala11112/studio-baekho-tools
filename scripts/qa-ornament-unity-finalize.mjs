/** Offline only: compares the authorized Unity readout with the independent corrected FBX snapshot. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const out=path.resolve(process.argv[2]??'artifacts/runtime/qa-20261018-ornament-unity-independent');
const read=p=>JSON.parse(fs.readFileSync(p));const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const spec=read(path.join(out,'spec.json')),binding=read(path.join(out,'native-reference-binding.json')),live=read(path.join(out,'live.json')),before=read(path.join(out,'before-close.json'));
assert.equal(sha(binding.raw),binding.sha256);const native=read(binding.raw);assert.equal(native.inputSHA[1],spec.exactFbxSha256);
assert(!live.error,live.error);assert.equal(live.playMode,false);assert(live.avatarValid&&live.avatarHuman);assert.equal(live.skins.length,3);
const canonical=values=>values.map(v=>[v.humanName,v.boneName]).sort((a,b)=>a[0].localeCompare(b[0]));assert.deepEqual(canonical(live.mappings),canonical(spec.humanBones));assert.equal(live.mappingCount,52);
assert.equal(sha(path.join(spec.project,spec.expectedDestination,'Generated/Asset.fbx')),spec.exactFbxSha256);
for(const file of spec.sourceFiles)assert.equal(sha(file.absolute),file.sha256);
for(const file of spec.sourceOriginalFiles)assert.equal(sha(path.join(spec.sourceRoot,file.path)),file.sha256);
const epsilon=1e-5,uvEpsilon=1e-6,toUnity=p=>[p[0],p[2],p[1]],distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const key=c=>c.join(','),cell=p=>p.map(n=>Math.floor(n/epsilon));const selected=new Set(native.selectedIndices);
const expectedNames={body:'Body_Limbs_Clothing',hair:'Hair_All',head:'tripo_node_4c3cda5e'};
const expectedColors={body:[.800000011920929,.800000011920929,.800000011920929,1],hair:[.800000011920929,.800000011920929,.800000011920929,1],head:[.8227857351303101,.42869049310684204,.2622506618499756,1]};
const parts=[],bounds=[];
for(const [partId,name] of Object.entries(expectedNames)){
 const source=native.after[partId],skin=live.skins.find(s=>s.name===name);assert(skin,'Missing exact skin '+name);assert.equal(source.uv.length,1,'Expected proven single exported UV set');
 assert.equal(skin.vertices,skin.weightedRows);assert.equal(skin.invalidRows,0);assert.equal(skin.invalidUvTriangles,0);
 assert.equal(skin.materials.length,source.materials.length);for(const material of skin.materials)assert(['r','g','b','a'].every((k,i)=>Math.abs(material.color[k]-expectedColors[partId][i])<1e-6));
 const uvByVertex=source.positions.map(()=>[]);let loop=0;for(const face of source.faces)for(const index of face)uvByVertex[index].push(source.uv[0][1][loop++]);assert.equal(loop,source.uv[0][1].length);
 const grid=new Map();source.positions.forEach((p,index)=>{const position=toUnity(p);bounds.push(position);const k=key(cell(position));if(!grid.has(k))grid.set(k,[]);grid.get(k).push(index);});
 const covered=new Set(),coveredSelected=new Set();let maxPositionError=0,maxUvError=0,maxPerBoneWeightDifference=0,maxDiscardedWeightMass=0,selectedRenderRows=0,hairHeadBindingErrors=0;
 for(const row of skin.rows){
  const point=['x','y','z'].map(k=>row.position[k]),uv=[row.uv.x,row.uv.y],c=cell(point),weights=Object.fromEntries(row.weights.filter(w=>w.weight>0).map(w=>[w.bone,w.weight]));let matches=[];
  for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const index of grid.get(key([c[0]+x,c[1]+y,c[2]+z]))??[]){
   const positionError=distance(point,toUnity(source.positions[index]));if(positionError>epsilon)continue;
   const uvError=Math.min(...uvByVertex[index].map(value=>distance(uv,value)));if(uvError>uvEpsilon)continue;
   const original=source.weights[index],weightError=Math.max(0,...new Set([...Object.keys(weights),...Object.keys(original)]).values().map(b=>Math.abs((weights[b]??0)-(original[b]??0))));
   matches.push({index,positionError,uvError,weightError,lost:Object.entries(original).filter(([b])=>!(b in weights)).reduce((s,[,w])=>s+w,0)});
  }
  assert(matches.length,'No exact-part position/UV-corner match');matches.sort((a,b)=>a.weightError-b.weightError||a.positionError-b.positionError);const match=matches[0];covered.add(match.index);
  maxPositionError=Math.max(maxPositionError,match.positionError);maxUvError=Math.max(maxUvError,match.uvError);maxPerBoneWeightDifference=Math.max(maxPerBoneWeightDifference,match.weightError);maxDiscardedWeightMass=Math.max(maxDiscardedWeightMass,match.lost);
  if(partId==='hair'&&(Object.keys(weights).length!==1||Math.abs((weights['head.x']??0)-1)>1e-6))hairHeadBindingErrors++;
  if(partId==='body'&&matches.some(m=>selected.has(m.index))){
   assert(matches.every(m=>selected.has(m.index)),'Ambiguous selected/nonselected position/UV match');
   for(const m of matches){for(const bone of native.thumbRemovalByIndex[m.index])assert.equal(weights[bone]??0,0,'Removed thumb influence remains');coveredSelected.add(m.index);}
   selectedRenderRows++;
  }
 }
 assert.equal(covered.size,source.positions.length,'Native vertex coverage differs');assert.equal(hairHeadBindingErrors,0);if(partId==='body')assert.equal(coveredSelected.size,72);
 parts.push({partId,meshId:source.identity,renderRows:skin.vertices,coveredNativeVertices:covered.size,nativeVertices:source.positions.length,maxPositionError,maxUvError,maxPerBoneWeightDifference,maxDiscardedWeightMass,selectedNativeVertices:coveredSelected.size,selectedRenderRows,hairHeadBindingErrors,maxUnityInfluences:skin.maxInfluences,materials:skin.materials});
}
const minimum=[0,1,2].map(i=>Math.min(...bounds.map(p=>p[i]))),maximum=[0,1,2].map(i=>Math.max(...bounds.map(p=>p[i])));
assert(distance(minimum,['x','y','z'].map(k=>live.min[k]))<=epsilon);assert(distance(maximum,['x','y','z'].map(k=>live.max[k]))<=epsilon);
const changedDuringAudit=Object.entries(before.files).filter(([p,f])=>!fs.existsSync(path.join(spec.project,p))||sha(path.join(spec.project,p))!==f.sha256).map(([p])=>p);assert.deepEqual(changedDuringAudit,[]);
const changedFromBeforeDelivery=Object.entries(spec.baseline).filter(([p,f])=>!fs.existsSync(path.join(spec.project,p))||sha(path.join(spec.project,p))!==f.sha256).map(([p])=>p);
assert(changedFromBeforeDelivery.every(p=>p.startsWith(spec.expectedDestination+'/Generated/')&&!p.endsWith('.meta')),'Unexpected protected change');
const result={passed:true,scope:'Actual app delivery first, independent one-batch headless readonly audit afterwards; no new delivery/export/reimport/Play.',deliveryId:'3fee376219db66b04894cc9a106521d6',candidateVersionId:spec.candidateId,exactFbxSha256:spec.exactFbxSha256,avatarValid:live.avatarValid,avatarHuman:live.avatarHuman,exact52Mapping:true,parts,coordinateTransport:{axes:[0,2,1],signs:[1,1,1],positionTolerance:epsilon,uvTolerance:uvEpsilon},dimensions:live.dimensions,importer:{skinWeights:live.skinWeights,maxBonesPerVertex:live.maxBonesPerVertex,minBoneWeight:live.minBoneWeight},protection:{baselineFiles:Object.keys(before.files).length,changedDuringAudit,changedFromBeforeDelivery,allPriorMetaUserPrefabScenesExact:true,sourceFilesExact:true,qualitySettingsExact:sha(path.join(spec.project,'ProjectSettings/QualitySettings.asset'))===sha(path.join(out,'QualitySettings-before.asset'))},noPlay:true,nativeReadExecutions:0,unityReadBatchExecutions:1,limitations:['Weight differences/pruned mass measured, not exact native weights.','No full posed Humanoid equivalence or natural deformation quality certification.','Base colors verified; untextured shader fallback is not texture quality proof.','Dedicated QA source and generated metas retained; no cleanup attempted.']};
assert(result.protection.qualitySettingsExact);fs.writeFileSync(path.join(out,'final.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({passed:true,parts:parts.length,selectedVertices:parts.find(p=>p.partId==='body').selectedNativeVertices,selectedRenderRows:parts.find(p=>p.partId==='body').selectedRenderRows,changedDuringAudit,changedFromBeforeDelivery}));
