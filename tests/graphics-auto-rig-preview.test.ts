import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectedRigPreview, autoRigPresentation, rigInspectionForCandidate } from '../src/graphics-auto-rig-preview';
import type { AssetVersion } from '../shared/graphics';
import type { AutoRigRun } from '../shared/graphics-auto-rig';

test('old candidate gets an ephemeral inspection GLB only from its exact verified native source',()=>{
  const candidate={id:'old-rig',objectId:'human',files:[{path:'old.blend',sha256:'exact-native'},{path:'old.glb',sha256:'old-preview'}]} as AssetVersion;
  const run={id:'inspect',objectId:'human',sourceVersionId:'old-rig',source:{path:'old.blend',sha256:'exact-native'},operation:'inspect',state:'review',files:[{path:'inspection/character.glb',sha256:'new-preview'}],inspection:{checks:[{id:'sourceHashBound',passed:true}]}} as AutoRigRun;
  const before=JSON.stringify(candidate);
  assert.equal(inspectedRigPreview(candidate,run)?.path,'inspection/character.glb');
  const repaired={...run,id:'repair-after-inspection',operation:'repair',candidateVersionId:'new-rig'} as AutoRigRun;
  const selected=rigInspectionForCandidate(candidate,[run,repaired]);
  assert.equal(selected?.id,'inspect','Historical source keeps its inspect run after a later repair from the same source');
  assert.equal(inspectedRigPreview(candidate,selected)?.path,'inspection/character.glb','Historical source remains inspectable and repairable without replay');
  assert.equal(rigInspectionForCandidate({...candidate,id:'new-rig'},[run,repaired]),undefined);
  assert.equal(JSON.stringify(candidate),before);
  for(const invalid of [{sourceVersionId:'other'},{objectId:'other'},{source:{...run.source,sha256:'changed'}},{state:'failed'},{operation:'repair'},{inspection:{checks:[{id:'sourceHashBound',passed:false}]}},{files:[...run.files,...run.files]}]) {
    assert.equal(inspectedRigPreview(candidate,{...run,...invalid} as AutoRigRun),undefined);
  }
});

test('presentation translates known motion and preservation messages without changing source reports',()=>{
  assert.equal(autoRigPresentation('Left knee bend'),'왼쪽 무릎 굽히기');
  assert.equal(autoRigPresentation('outsideWeights'),'선택 밖 가중치 보존');
  assert.equal(autoRigPresentation('unknown diagnostic'),'unknown diagnostic');
});
