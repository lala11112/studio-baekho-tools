import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {autoRigInspectionPreviewAllowed} from '../electron/auto-rig-preview';import type {GraphicsWorkspace} from '../shared/graphics';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
function fixture(t:any,current=false,multipart=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'auto-rig-preview-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(rel:string,value:string)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,value);return {path:rel,bytes:Buffer.byteLength(value),sha256:hash(value),kind:path.extname(rel).slice(1)};};
 const source=write('assets/source.blend','source'),folder='graphics/auto-rig/run';write(folder+'/source.blend','source');write(folder+'/worker.py','worker');
 const partPolicy={schemaVersion:1,requiredParts:['body','hair','head'],headBoundParts:['hair']},workerResources={'graphics_auto_rig_parts.py':hash('historical-parts-helper')};
 if(multipart)write(folder+'/graphics_auto_rig_parts.py','historical-parts-helper');
 const request={schemaVersion:1,operation:'inspect',sourceBlend:path.join(root,folder,'source.blend'),sourceSha256:source.sha256,fingers:true,repairs:[],...(multipart?{partPolicy,workerResources}:{})};
 const requestFile=write(folder+'/request.json',JSON.stringify(request));write(folder+'/dispatch.json',JSON.stringify({requestSha256:requestFile.sha256,toolSha256:hash('worker')}));
 const files=['rigged.blend','character.fbx','character.glb'].map(name=>write(folder+'/output/'+name,name.repeat(20)));
 const inspection={checks:['sourceHashBound','geometryAndUV','outsideWeights','attributes','materials','images','skeleton','exportedBoneNames'].map(id=>({id,passed:true})),humanBones:[],boneNames:[],islands:[],warnings:[]};
 if(multipart)inspection.checks.push(...['partIdentity','partExport','headBinding'].map(id=>({id,passed:true})));
 const report={schemaVersion:1,status:'exported-review-pending',operation:'inspect',sourceSha256:source.sha256,requestSha256:requestFile.sha256,osInputUsed:false,paidSubmissions:0,inspection,files:files.map(f=>({...f,path:path.join(root,f.path)})),...(multipart?{partPolicy,partChecks:partPolicy.requiredParts.map(partId=>({partId,meshIds:[partId+'-mesh'],present:true,headBound:partPolicy.headBoundParts.includes(partId)}))}:{})};
 const reportFile=write(folder+'/output/run-report.json',JSON.stringify(report));
 const run:any={id:'run',objectId:'human',sourceVersionId:'rig',source,operation:'inspect',state:'review',settings:{frontAxis:'neg-y',fingers:true},repairs:[],files,reportFile,inspection};
 if(current)run.toolSha256=hash('worker');
 if(multipart){run.partPolicy=partPolicy;run.toolDependencies=workerResources;}
 run.requestHash=fingerprint(run);
 const workspace={versions:[{id:'rig',objectId:'human',role:'rig',files:[source]}],autoRigRuns:[run]} as unknown as GraphicsWorkspace;
 return {root,workspace,run,source,files,glb:path.join(root,files[2].path),write};
}
const fingerprint=(run:any)=>hash(JSON.stringify({objectId:run.objectId,sourceVersionId:run.sourceVersionId,source:run.source,operation:run.operation,settings:run.settings,repairs:run.repairs,inspectionRunId:run.inspectionRunId,toolSha256:run.toolSha256,...(run.partPolicy?{partPolicy:run.partPolicy}:{}),...(run.toolDependencies?{toolDependencies:run.toolDependencies}:{})}));

test('historical multipart inspection authorizes exact saved policy/helper without current worker dependency',t=>{
 const f=fixture(t,true,true);f.write('installed/graphics_auto_rig.py','new-correction-worker');f.write('installed/graphics_auto_rig_parts.py','new-helper');
 assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),true);
 for(const mode of ['policy','dependencies','staged-helper','report-check']){
  const v=fixture(t,true,true);
  if(mode==='policy')v.run.partPolicy={...v.run.partPolicy,headBoundParts:[]};
  if(mode==='dependencies')v.run.toolDependencies={'graphics_auto_rig_parts.py':hash('other-helper')};
  if(mode==='staged-helper')fs.appendFileSync(path.join(v.root,'graphics/auto-rig/run/graphics_auto_rig_parts.py'),'tampered');
  if(mode==='report-check')v.run.inspection.checks.find((c:any)=>c.id==='headBinding').passed=false;
  if(mode==='policy'||mode==='dependencies')v.run.requestHash=fingerprint(v.run);
  assert.equal(autoRigInspectionPreviewAllowed(v.root,v.workspace,v.glb),false,mode);
 }
});
test('only exact saved inspection GLB supplements registered version assets',t=>{const f=fixture(t);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),true);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,path.join(f.root,f.files[0].path)),false);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,path.join(f.root,'unrelated.glb')),false);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,path.join(f.root,'../outside.glb')),false);});
test('inspection preview rejects changed source, report, output, frozen request and unbound version',t=>{
 for(const mode of ['source','report','output','request','version','cancelled']){const f=fixture(t);
  if(mode==='source')fs.appendFileSync(path.join(f.root,f.source.path),'changed');
  if(mode==='report')fs.appendFileSync(path.join(f.root,f.run.reportFile.path),'changed');
  if(mode==='output')fs.appendFileSync(f.glb,'changed');
  if(mode==='request')fs.appendFileSync(path.join(f.root,'graphics/auto-rig/run/request.json'),'changed');
  if(mode==='version')f.workspace.versions[0].objectId='other';
  if(mode==='cancelled')f.run.state='cancelled';
  assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),false,mode);
 }
});
test('inspection preview never allows path substitution or missing preservation checks',t=>{
 for(const mode of ['escape','output-substitution','check']){const f=fixture(t);
  if(mode==='escape')f.run.files[2].path='../outside.glb';
  if(mode==='output-substitution')f.run.files[2]=f.write('unrelated.glb','unrelated'.repeat(30));
  if(mode==='check')f.run.inspection.checks[0].passed=false;
  const target=path.resolve(f.root,f.run.files[2].path);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,target),false,mode);
 }
});
test('both legacy and tool-bound inspection records authorize only the original frozen worker',t=>{
 for(const current of [false,true]){
  const f=fixture(t,current);assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),true);
  fs.appendFileSync(path.join(f.root,'graphics/auto-rig/run/worker.py'),'tampered');assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),false);
 }
 const f=fixture(t,true);f.run.toolSha256='0'.repeat(64);
 f.run.requestHash=hash(JSON.stringify({objectId:f.run.objectId,sourceVersionId:f.run.sourceVersionId,source:f.run.source,operation:f.run.operation,settings:f.run.settings,repairs:f.run.repairs,inspectionRunId:f.run.inspectionRunId,toolSha256:f.run.toolSha256}));
 assert.equal(autoRigInspectionPreviewAllowed(f.root,f.workspace,f.glb),false);
});
