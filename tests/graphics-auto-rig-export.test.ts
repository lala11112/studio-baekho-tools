import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createGraphicsNativeExecutor,type GraphicsNativeArgs} from '../engine/graphics-native';
import {humanoidBoneMap} from '../shared/graphics-rig';
import type {AssetVersion,GraphicsFile} from '../shared/graphics';
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-copy-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(name:string,kind:string):GraphicsFile=>{const bytes=Buffer.from('exact original '+name);fs.writeFileSync(path.join(root,name),bytes);return {path:name,kind,bytes:bytes.length,sha256:sha(bytes)};};
 const files=[put('rig.blend','blend'),put('game.fbx','fbx'),put('poses.glb','glb')],report=put('inspection.json','report');
 const source:AssetVersion={id:'rig-source',objectId:'human',role:'rig',slot:'main',label:'Rig',createdAt:'',sourceVersionIds:['model'],files,provenance:{type:'local',jobId:'arp-run'},warnings:[],autoRig:{schemaVersion:1,runId:'arp-run',reportFile:report,sourceSha256:'original-model-sha',exportFbx:files[1],contract:{schemaVersion:2,versionId:'rig-source',producerVersionId:'rig-source',producerTaskId:'arp-run',rigType:'humanoid',fingers:false,hairBinding:'head',requiredParts:[],humanBones:humanoidBoneMap(false),exportPolicy:'auto-rig-fbx'}}};
 const args:GraphicsNativeArgs={projectRoot:root,workspacePath:path.join(root,'workspace.json'),resources:path.resolve('integrations'),blenderPath:'missing-blender',signal:new AbortController().signal,onProgress:()=>{},object:{id:'human',name:'Human',kind:'character',createdAt:'',settings:{},selectedTasks:[],references:[],instruction:'',accepted:{'rig:main':source.id}},task:{id:'export-one',objectId:'human',taskId:'X04',status:'running',createdAt:'',updatedAt:'',settings:{exportFormat:'both'},inputVersionIds:[source.id],outputVersionIds:[],requestHash:'frozen',instruction:'',backendJobIds:[],message:'',localOnly:true,unityRigContract:structuredClone(source.autoRig!.contract)},inputs:[source]};
 let dispatch=0;const execute=createGraphicsNativeExecutor({runBlender:async()=>{dispatch++;throw Error('Blender forbidden');},workerFactory:()=>{dispatch++;throw Error('GPT forbidden');}});
 return {root,args,source,execute,get dispatch(){return dispatch;}};
}
test('auto rig X04 copies exact game FBX and editable source; GLB is diagnostic, cached recovery has no dispatch',async t=>{
 const f=fixture(t),originals=f.source.files.map(file=>sha(fs.readFileSync(path.join(f.root,file.path))));
 const result=await f.execute(f.args);assert.equal(result.role,'rig');assert.equal(result.autoRigSourceVersionId,f.source.id);assert.match(result.warnings.join(' '),/검사용/);
 for(const [suffix,index] of [['asset.blend',0],['asset.fbx',1],['diagnostic.glb',2]] as const){const file=result.files.find(x=>x.path.endsWith(suffix))!;assert.equal(sha(fs.readFileSync(path.join(f.root,file.path))),f.source.files[index].sha256);}
 assert.deepEqual(await f.execute({...f.args,recoveryOnly:true}),result);assert.equal(f.dispatch,0);assert.ok(!fs.existsSync(path.join(f.root,'graphics/jobs/export-one/dispatch.json')));assert.deepEqual(f.source.files.map(file=>sha(fs.readFileSync(path.join(f.root,file.path)))),originals);
});
test('FBX format omits diagnostic GLB; changing frozen format cannot reuse a completed checkpoint',async t=>{
 const f=fixture(t);f.args.task.settings.exportFormat='fbx';const result=await f.execute(f.args);assert.ok(!result.files.some(x=>x.path.endsWith('.glb')));f.args.task.settings.exportFormat='both';await assert.rejects(f.execute({...f.args,recoveryOnly:true}),/要求|요청/);assert.equal(f.dispatch,0);
});
test('registered contract key order is normalized before authoritative validation',async t=>{
 const f=fixture(t);f.source.autoRig!.contract.humanBones=f.source.autoRig!.contract.humanBones.map(({humanName,boneName})=>({humanName,boneName}));f.args.task.unityRigContract=structuredClone(f.source.autoRig!.contract);assert.equal((await f.execute(f.args)).autoRigSourceVersionId,f.source.id);assert.equal(f.dispatch,0);
});
test('complete report without checkpoint recovers exact files without copying; stale report and partial output stay untouched',async t=>{
 const f=fixture(t);f.args.task.settings.lodEnabled=true;f.args.task.settings.collider='stale-hidden-setting';const result=await f.execute(f.args);const checkpoint=path.join(f.root,'graphics/jobs/export-one/checkpoint.json');fs.unlinkSync(checkpoint);assert.deepEqual(await f.execute({...f.args,recoveryOnly:true}),result);assert.equal(f.dispatch,0);
 fs.unlinkSync(checkpoint);const report=path.join(f.root,'graphics/jobs/export-one/outputs/report.json'),original=fs.readFileSync(report,'utf8');const tampered=JSON.parse(original);tampered.policy='obsolete';fs.writeFileSync(report,JSON.stringify(tampered));await assert.rejects(f.execute({...f.args,recoveryOnly:true}),/보고서/);assert.equal(fs.readFileSync(report,'utf8'),JSON.stringify(tampered));
});
test('diagnostic output is preview-only and derived recognized diagnostic can be copied again',async t=>{
 const f=fixture(t);const result=await f.execute(f.args);assert.equal(result.files.find(x=>x.path.endsWith('diagnostic.glb'))!.kind,'preview');const glb=f.source.files.find(x=>x.path.endsWith('.glb'))!;const renamed='nested/diagnostic.glb';fs.mkdirSync(path.join(f.root,'nested'));fs.copyFileSync(path.join(f.root,glb.path),path.join(f.root,renamed));glb.path=renamed;glb.kind='preview';f.source.autoRig!.derivedFromVersionId='parent';f.args.task.id='derived-second';assert.equal((await f.execute(f.args)).autoRigSourceVersionId,f.source.id);assert.equal(f.dispatch,0);
});
test('unsupported size/pivot/GLB-only and missing or mutated metadata are blocked before output directories',async t=>{
 const cases=[(f:ReturnType<typeof fixture>)=>{f.args.task.settings.physicalSize=JSON.stringify({mode:'uniform',lengthMeters:2});},(f:ReturnType<typeof fixture>)=>{f.args.task.settings.pivot='bottom';},(f:ReturnType<typeof fixture>)=>{f.args.task.settings.scale=2;},(f:ReturnType<typeof fixture>)=>{f.args.task.settings.exportFormat='glb';},(f:ReturnType<typeof fixture>)=>{delete f.source.autoRig;},(f:ReturnType<typeof fixture>)=>{f.source.autoRig!.contract.humanBones.pop();},(f:ReturnType<typeof fixture>)=>{fs.writeFileSync(path.join(f.root,'game.fbx'),'changed');},(f:ReturnType<typeof fixture>)=>{fs.writeFileSync(path.join(f.root,'inspection.json'),'changed');},(f:ReturnType<typeof fixture>)=>{f.source.files=f.source.files.filter(x=>!x.path.endsWith('.blend'));}];
 for(const [i,change] of cases.entries())await t.test(String(i),async c=>{const f=fixture(c);change(f);await assert.rejects(f.execute(f.args));assert.equal(f.dispatch,0);assert.ok(!fs.existsSync(path.join(f.root,'graphics')));});
});
test('saved-only missing checkpoint never copies or dispatches; unsafe legacy checkpoint never reused',async t=>{
 const f=fixture(t);await assert.rejects(f.execute({...f.args,recoveryOnly:true}),/복구/);assert.equal(fs.readdirSync(path.join(f.root,'graphics/jobs/export-one/outputs')).length,0);
 const checkpoint=path.join(f.root,'graphics/jobs/export-one/checkpoint.json');fs.writeFileSync(checkpoint,JSON.stringify({identity:'legacy-unsafe',files:[],result:{role:'rig'}}));await assert.rejects(f.execute(f.args),/요청/);assert.equal(f.dispatch,0);
});
test('fresh auto-rig A05 is blocked before output; saved-only still follows existing checkpoint policy',async t=>{
 const f=fixture(t);f.args.task.taskId='A05';await assert.rejects(f.execute(f.args),/모델 단계/);assert.ok(!fs.existsSync(path.join(f.root,'graphics')));await assert.rejects(f.execute({...f.args,recoveryOnly:true}),/저장된 완전한/);assert.equal(f.dispatch,0);
});
