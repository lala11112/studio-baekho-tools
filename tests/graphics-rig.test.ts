import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeUnityRigContract, humanoidBoneMap, validateUnityRigContract } from '../shared/graphics-rig';
import type { GraphicsWorkspace, AssetVersion, GraphicsTask } from '../shared/graphics';
const version=(id:string,role:AssetVersion['role']='rig',sourceVersionIds:string[]=[]):AssetVersion=>({id,objectId:'human',role,slot:'main',label:id,sourceVersionIds,provenance:{type:'codex'},files:[],warnings:[],createdAt:''});
const producer=(taskId='R01'):GraphicsTask=>({id:'rig-task',objectId:'human',taskId,createdAt:'',updatedAt:'',status:'review',inputVersionIds:[],settings:{rigFingers:true,rigHair:false},instruction:'',requestHash:'frozen',outputVersionIds:['original'],backendJobIds:[],message:'',localOnly:false});
function fixture():GraphicsWorkspace{return {schemaVersion:1,id:'workspace',projectId:'project',revision:1,objects:[{id:'human',name:'human',kind:'character',createdAt:'',selectedTasks:[],instruction:'',settings:{rigType:'generic',unityRigType:'generic',rigFingers:false},references:[],accepted:{'rig:main':'fitted'}}],versions:[version('original'),version('fitted','rig',['original'])],tasks:[producer()],deliveries:[]};}
test('X05 freezes Humanoid and fingers from the exact accepted rig ancestry despite changed controls',()=>{
 const w=fixture(),contract=freezeUnityRigContract(w,[w.versions[1]])!;
 assert.equal(contract.rigType,'humanoid');assert.equal(contract.fingers,true);assert.equal(contract.hairBinding,'head');assert.equal(contract.producerVersionId,'original');assert.equal(contract.versionId,'fitted');assert.equal(contract.humanBones.length,47);
 assert.deepEqual(validateUnityRigContract([w.versions[1]],contract),contract);
 const wrong=structuredClone(contract);wrong.humanBones[0].humanName='Head';assert.throws(()=>validateUnityRigContract([w.versions[1]],wrong),/본 매핑/);
 assert.throws(()=>validateUnityRigContract([w.versions[0]],contract),/정확한 버전/);
});
test('missing or ambiguous producer evidence never falls back from app Humanoid to Generic',()=>{
 const w=fixture();w.tasks=[];assert.throws(()=>freezeUnityRigContract(w,[w.versions[1]]),/추정하지/);
 w.tasks=[producer(),{...producer(),id:'duplicate'}];assert.throws(()=>freezeUnityRigContract(w,[w.versions[1]]),/중복/);
 w.objects[0].accepted={};assert.throws(()=>freezeUnityRigContract(w,[w.versions[1]]),/먼저 채택/);
});
test('Generic rabbit remains Generic and optional fingers are required only when frozen true',()=>{
 const w=fixture();w.tasks=[producer('R02')];const contract=freezeUnityRigContract(w,[w.versions[1]])!;assert.equal(contract.rigType,'generic');assert.equal(contract.fingers,false);assert.deepEqual(contract.humanBones,[]);
 w.tasks=[producer()];w.tasks[0].settings.rigFingers=false;assert.equal(freezeUnityRigContract(w,[w.versions[1]])!.humanBones.length,17);
 assert.equal(new Set(humanoidBoneMap(true).map(bone=>bone.boneName)).size,47);
});
