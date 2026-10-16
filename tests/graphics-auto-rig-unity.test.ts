import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRigUnityExport } from '../engine/graphics-unity';
import { externalAnimationRigContract } from '../engine/graphics-astra';
import { freezeUnityRigContract, humanoidBoneMap, type UnityRigContract } from '../shared/graphics-rig';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';

function fixture(){
  const fbx={path:'rig/game.fbx',sha256:'a'.repeat(64),bytes:12,kind:'fbx'};
  const contract:UnityRigContract={schemaVersion:2,versionId:'arp',producerVersionId:'arp',producerTaskId:'run',rigType:'humanoid',fingers:false,hairBinding:'head',requiredParts:[],humanBones:humanoidBoneMap().map(b=>({...b,boneName:'ARP_'+b.humanName}))};
  const rig={label:'ARP',createdAt:'',provenance:{type:'local'},warnings:[],id:'arp',objectId:'human',role:'rig',slot:'main',sourceVersionIds:[],files:[{...fbx,path:'rig/editable.blend'},fbx],autoRig:{schemaVersion:1,runId:'run',reportFile:{...fbx,path:'rig/report.json'},sourceSha256:'b'.repeat(64),contract,exportFbx:fbx}} as AssetVersion;
  const workspace={objects:[{id:'human',accepted:{'rig:main':'arp'},settings:{rigType:'generic'}}],versions:[rig],tasks:[]} as unknown as GraphicsWorkspace;
  return {rig,workspace,fbx,contract};
}
test('ARP freezes explicit export names and exact FBX instead of editable BLEND',()=>{
  const {rig,workspace,fbx}=fixture();const contract=freezeUnityRigContract(workspace,[rig])!;
  assert.equal(contract.exportPolicy,'auto-rig-fbx');assert.equal(contract.humanBones[0].boneName,'ARP_Hips');
  assert.deepEqual(autoRigUnityExport(rig,[rig],{},contract),fbx);
});
test('ARP correction ancestry preserves origin but cannot reuse ancestor FBX as new weights',()=>{
  const {rig,workspace}=fixture();const child={...rig,id:'corrected',autoRig:undefined,sourceVersionIds:[rig.id]};
  workspace.versions.push(child);workspace.objects[0].accepted['rig:main']=child.id;
  const contract=freezeUnityRigContract(workspace,[child])!;
  assert.equal(contract.versionId,child.id);assert.equal(contract.producerVersionId,rig.id);
  assert.throws(()=>autoRigUnityExport(child,[child],{},contract),/FBX/);
});
test('ARP rejects altered export binding, contract, clip baking and reencoding settings',()=>{
  for(const mode of ['file','map','clip','lod','scale','pivot']){
    const {rig,workspace}=fixture();const contract=freezeUnityRigContract(workspace,[rig])!;
    const settings:any={};let versions=[rig];
    if(mode==='file')rig.autoRig!.exportFbx={...rig.autoRig!.exportFbx,sha256:'c'.repeat(64)};
    if(mode==='map')contract.humanBones[0].boneName='pelvis';
    if(mode==='clip')versions=[rig,{...rig,id:'clip',role:'animation'}];
    if(mode==='lod')settings.lodEnabled=true;
    if(mode==='scale')settings.physicalSize={mode:'uniform'};
    if(mode==='pivot')settings.physicalSize={pivot:'center'};
    assert.throws(()=>autoRigUnityExport(rig,versions,settings,contract),Error,mode);
  }
});
test('malformed ARP metadata never falls back to a historical canonical R01 producer',()=>{
  const {rig,workspace}=fixture();rig.autoRig!.contract.producerVersionId='old';
  workspace.tasks=[{id:'legacy',objectId:'human',taskId:'R01',outputVersionIds:[rig.id],settings:{}}] as any;
  assert.throws(()=>freezeUnityRigContract(workspace,[rig]),/출처/);
});
test('ARP descendants require complete single-origin ancestry and preserve frozen part requirements',()=>{
  for(const kind of ['diamond','missing','ambiguous']){
    const {rig,workspace}=fixture();rig.autoRig!.contract.requiredParts=['body','hair'];
    const intermediate={...rig,id:'intermediate',autoRig:undefined,sourceVersionIds:[rig.id]};
    const child={...intermediate,id:'child',sourceVersionIds:[rig.id,intermediate.id]};
    workspace.versions.push(intermediate,child);workspace.objects[0].accepted['rig:main']=child.id;
    if(kind==='missing')child.sourceVersionIds.push('missing');
    if(kind==='ambiguous'){
      const other=structuredClone(rig);other.id='other';other.autoRig!.contract.versionId='other';other.autoRig!.contract.producerVersionId='other';
      workspace.versions.push(other);child.sourceVersionIds.push(other.id);
    }
    if(kind==='diamond'){
      const contract=freezeUnityRigContract(workspace,[child])!;
      assert.deepEqual(contract.requiredParts,['body','hair']);contract.requiredParts.push('changed');
      assert.deepEqual(rig.autoRig!.contract.requiredParts,['body','hair']);
    }else assert.throws(()=>freezeUnityRigContract(workspace,[child]),/출처/);
  }
});
test('legacy rig keeps existing native-source selection',()=>{
  const {rig}=fixture();delete rig.autoRig;
  assert.equal(autoRigUnityExport(rig,[rig],{}),undefined);
});
test('ARP ancestry cannot enter legacy AI animation or weight authoring',()=>{
  const {rig,workspace}=fixture();
  assert.throws(()=>externalAnimationRigContract(workspace,rig),/아직 검증/);
  const clip={...rig,id:'clip',role:'animation' as const,autoRig:undefined,sourceVersionIds:[rig.id]};workspace.versions.push(clip);
  assert.throws(()=>externalAnimationRigContract(workspace,clip),/아직 검증/);
});
test('a legacy R01 producer cannot shadow ARP source ancestry with canonical names',()=>{
 const {rig,workspace}=fixture();const child={...rig,id:'legacy-child',autoRig:undefined,sourceVersionIds:[rig.id]};
 workspace.versions.push(child);workspace.objects[0].accepted['rig:main']=child.id;
 workspace.tasks=[{id:'legacy',objectId:'human',taskId:'R01',outputVersionIds:[child.id],settings:{}}] as any;
 assert.throws(()=>freezeUnityRigContract(workspace,[child]),/R01/);
});

