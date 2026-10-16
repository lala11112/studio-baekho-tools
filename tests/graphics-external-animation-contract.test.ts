import test from 'node:test';
import assert from 'node:assert/strict';
import { externalAnimationRigContract } from '../engine/graphics-astra';
import { humanoidBoneMap, type UnityRigContract } from '../shared/graphics-rig';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';

function fixture() {
  const contract: UnityRigContract = {schemaVersion:2,versionId:'rig',producerVersionId:'rig',producerTaskId:'handoff',rigType:'humanoid',fingers:false,hairBinding:'head',requiredParts:[],humanBones:humanoidBoneMap().map(b=>({...b,boneName:'External_'+b.boneName}))};
  const rig = {id:'rig',objectId:'human',role:'rig',slot:'main',sourceVersionIds:[],externalRig:{schemaVersion:1,handoffId:'handoff',reportPath:'report.json',contract}} as unknown as AssetVersion;
  const animation = {id:'clip',objectId:'human',role:'animation',sourceVersionIds:['rig']} as AssetVersion;
  const workspace = {objects:[{id:'human',accepted:{'rig:main':'rig'},settings:{rigType:'generic'}}],versions:[rig,animation],tasks:[]} as unknown as GraphicsWorkspace;
  return {rig,animation,workspace,contract};
}
test('external animation and weight revision freeze adopted exact names through clip lineage',()=>{
  const {rig,animation,workspace,contract}=fixture();
  assert.deepEqual(externalAnimationRigContract(workspace,rig),contract);
  const frozen=externalAnimationRigContract(workspace,animation)!;
  assert.deepEqual(frozen,contract);frozen.humanBones[0].boneName='changed';
  assert.equal(contract.humanBones[0].boneName,'External_pelvis');
});
test('external animation rejects unadopted, incomplete and ambiguous external lineage',()=>{
  for(const kind of ['unadopted','missing','ambiguous']){
    const {rig,animation,workspace}=fixture();
    if(kind==='unadopted')workspace.objects[0].accepted={};
    if(kind==='missing')animation.sourceVersionIds.push('missing');
    if(kind==='ambiguous'){const other=structuredClone(rig);other.id='other';workspace.versions.push(other);animation.sourceVersionIds.push('other');}
    assert.throws(()=>externalAnimationRigContract(workspace,animation));
  }
});
test('legacy imported animation retains existing behavior without external metadata',()=>{
  const {rig,workspace}=fixture();delete rig.externalRig;rig.sourceVersionIds=['historical-unavailable'];
  assert.equal(externalAnimationRigContract(workspace,rig),undefined);
});
