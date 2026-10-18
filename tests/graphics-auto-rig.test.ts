import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { autoRigProgressLabel, inspectSavedGraphicsAutoRig, runGraphicsAutoRig } from '../engine/graphics-auto-rig';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function fixture(t:{after:(f:()=>void)=>void}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'output')); fs.writeFileSync(path.join(root,'worker.py'),'worker'); fs.writeFileSync(path.join(root,'source.blend'),'source');
 const request={operation:'inspect',sourceBlend:path.join(root,'source.blend'),sourceSha256:hash('source')};
 fs.writeFileSync(path.join(root,'request.json'),JSON.stringify(request)); const requestSha256=hash(JSON.stringify(request));
 fs.writeFileSync(path.join(root,'dispatch.json'),JSON.stringify({requestSha256,toolSha256:hash('worker')}));
 const files=['rigged.blend','character.fbx','character.glb'].map(name=>{const full=path.join(root,'output',name),data='x'.repeat(101);fs.writeFileSync(full,data);return {path:full,sha256:hash(data),bytes:101};});
 const report={status:'exported-review-pending',requestSha256,sourceSha256:request.sourceSha256,operation:'inspect',osInputUsed:false,paidSubmissions:0,files};
 const reportPath=path.join(root,'output','run-report.json'); fs.writeFileSync(reportPath,JSON.stringify(report));
 return {root,request,report,reportPath};
}
test('saved recovery verifies all three exact output files',t=>{const f=fixture(t);assert.ok(inspectSavedGraphicsAutoRig(f.root).fbxPath.endsWith('character.fbx'));fs.writeFileSync(f.report.files[0].path,'tampered');assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/변경/);});
test('saved report must bind exact request',t=>{const f=fixture(t);f.report.requestSha256='0'.repeat(64);fs.writeFileSync(f.reportPath,JSON.stringify(f.report));assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/일치하지/);});
test('cancelled jobs cannot recover',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'cancelled.json'),'{}');assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/취소/);});
test('explicit process failure cannot recover an otherwise complete report',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'process-outcome.json'),JSON.stringify({requestSha256:f.report.requestSha256,succeeded:false}));assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/정상적으로 완료되지/);});
test('dispatch prevents repeat process execution with incomplete outputs',async t=>{const f=fixture(t);fs.unlinkSync(f.reportPath);await assert.rejects(runGraphicsAutoRig({sourceBlend:f.request.sourceBlend,sourceSha256:f.request.sourceSha256,outputDir:f.root,operation:'inspect',blenderPath:'never-launch',workerPath:'never-read'}),/ENOENT/);});
test('orientation required before fresh rig starts',async t=>{const f=fixture(t);await assert.rejects(runGraphicsAutoRig({sourceBlend:f.request.sourceBlend,sourceSha256:f.request.sourceSha256,outputDir:f.root,operation:'rig',blenderPath:'never-launch',workerPath:'never-read'}),/앞 방향/);});
test('native failure surfaces its actual cause in Korean instead of a missing-result message',t=>{const f=fixture(t);fs.writeFileSync(f.reportPath,JSON.stringify({...f.report,status:'failed',error:'Rig rest geometry changed'}));assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/로컬 리깅 실패: 중립 자세/);});
test('known progress steps are readable Korean labels',()=>{assert.match(autoRigProgressLabel('ai-body-markers'),/몸의 관절/);assert.match(autoRigProgressLabel('export-preview'),/검사 동작/);});

function bindRequest(f:ReturnType<typeof fixture>,extra:Record<string,unknown>){
 const request={...f.request,...extra};fs.writeFileSync(path.join(f.root,'request.json'),JSON.stringify(request));
 const requestSha256=hash(JSON.stringify(request));fs.writeFileSync(path.join(f.root,'dispatch.json'),JSON.stringify({requestSha256,toolSha256:hash('worker')}));
 Object.assign(f.report,{requestSha256});fs.writeFileSync(f.reportPath,JSON.stringify(f.report));return request;
}
test('same implicit-resource runner arguments recover saved request after installed helper changes',async t=>{
 const f=fixture(t),resources={'graphics_auto_rig_parts.py':hash('saved-helper')};fs.writeFileSync(path.join(f.root,'graphics_auto_rig_parts.py'),'saved-helper');bindRequest(f,{workerResources:resources});
 const installed=path.join(f.root,'installed');fs.mkdirSync(installed);fs.writeFileSync(path.join(installed,'worker.py'),'new-worker');fs.writeFileSync(path.join(installed,'graphics_auto_rig_parts.py'),'new-helper');
 const args={sourceBlend:f.request.sourceBlend,sourceSha256:f.request.sourceSha256,outputDir:f.root,operation:'inspect' as const,blenderPath:'never-launch',workerPath:path.join(installed,'worker.py')};
 assert.equal((await runGraphicsAutoRig(args)).reportPath,f.reportPath);assert.equal((await runGraphicsAutoRig({...args,recoveryOnly:true})).reportPath,f.reportPath);
 await assert.rejects(runGraphicsAutoRig({...args,workerResources:{'graphics_auto_rig_parts.py':hash('new-helper')}}),/현재 선택/);
 fs.writeFileSync(path.join(f.root,'graphics_auto_rig_parts.py'),'tampered');await assert.rejects(runGraphicsAutoRig(args),/리소스/);
});
test('saved helper manifest rejects traversal resource names',t=>{
 const f=fixture(t);bindRequest(f,{workerResources:{'../outside.py':hash('outside')}});assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/리소스 명세/);
});
test('multipart saved recovery requires exact policy and all native part checks',t=>{
 const f=fixture(t),partPolicy={schemaVersion:1,requiredParts:['body','hair'],headBoundParts:['hair']};
 Object.assign(f.report,{partPolicy,partChecks:[{partId:'body',meshIds:['b'],present:true,headBound:false},{partId:'hair',meshIds:['h'],present:true,headBound:true}],inspection:{checks:['partIdentity','partExport','headBinding'].map(id=>({id,passed:true}))}});bindRequest(f,{partPolicy});
 assert(inspectSavedGraphicsAutoRig(f.root));(f.report as any).partChecks[1].headBound=false;fs.writeFileSync(f.reportPath,JSON.stringify(f.report));assert.throws(()=>inspectSavedGraphicsAutoRig(f.root),/머리 연결/);
});
for(const partPolicy of [
 {schemaVersion:1,requiredParts:[],headBoundParts:[]},
 {schemaVersion:1,requiredParts:['hair','hair'],headBoundParts:['hair']},
 {schemaVersion:1,requiredParts:['hair','body'],headBoundParts:['hair']},
 {schemaVersion:1,requiredParts:['body'],headBoundParts:['hair']},
 {schemaVersion:1,requiredParts:['body'],headBoundParts:[],extra:true},
 {schemaVersion:1,requiredParts:['part-hair'],headBoundParts:[]},
])test('invalid multipart policy cannot reach dispatch: '+JSON.stringify(partPolicy),async t=>{
 const f=fixture(t);await assert.rejects(runGraphicsAutoRig({sourceBlend:f.request.sourceBlend,sourceSha256:f.request.sourceSha256,outputDir:f.root,operation:'inspect',blenderPath:'never-launch',workerPath:'never-read',partPolicy:partPolicy as any}),/파트 정책/);
});

