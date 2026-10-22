import test from 'node:test';
import assert from 'node:assert/strict';
import {queuedUnityOpenTarget} from '../shared/graphics-unity-open';
import type {GraphicsWorkspace} from '../shared/graphics';
const fixture=()=>({projectId:'p',objects:[{id:'o'}],versions:[{id:'rig',objectId:'o'}],tasks:[{id:'t',objectId:'o',taskId:'X05',status:'running',deliveryId:'d',inputVersionIds:['rig'],targetProfile:{projectPath:'C:/Unity/Frozen',unityVersion:'6000.3.21f1',fingerprint:'frozen'}}],deliveries:[{id:'d',objectId:'o',status:'queued',versionIds:['rig'],profileFingerprint:'frozen',approvedTaskId:'t',errors:[]}]} as unknown as GraphicsWorkspace);
test('queued editor open resolves exact frozen request and ignores mutable target defaults',()=>{
 const w=fixture();w.target={projectPath:'C:/Unity/Other',fingerprint:'other'} as any;
 assert.equal(queuedUnityOpenTarget(w,'p','o','t','d')?.target.projectPath,'C:/Unity/Frozen');
 assert.deepEqual(queuedUnityOpenTarget(w,'p','o','t','d')?.task.inputVersionIds,['rig']);
});
for(const kind of ['project','object','task','delivery','file-export','failed-task','unknown-task','review-task','imported','failed-delivery','input','target','approval-owner','source-owner','duplicate-task','errors'] as const)test('queued editor open rejects '+kind,()=>{
 const w=fixture();let project='p',object='o',task='t',delivery='d';
 if(kind==='project')project='foreign';if(kind==='object')object='foreign';if(kind==='task')task='old';if(kind==='delivery')delivery='old';if(kind==='file-export')w.tasks[0].taskId='X04';if(kind==='failed-task')w.tasks[0].status='failed';if(kind==='unknown-task')w.tasks[0].status='submission_unknown';if(kind==='review-task')w.tasks[0].status='review';if(kind==='imported')w.deliveries[0].status='imported';if(kind==='failed-delivery')w.deliveries[0].status='failed';if(kind==='input')w.deliveries[0].versionIds=['old'];if(kind==='target')w.deliveries[0].profileFingerprint='other';if(kind==='approval-owner')w.deliveries[0].approvedTaskId='old';if(kind==='source-owner')w.versions[0].objectId='foreign';if(kind==='duplicate-task')w.tasks.push(structuredClone(w.tasks[0]));if(kind==='errors')w.deliveries[0].errors=['Uncertain import'];
 assert.equal(queuedUnityOpenTarget(w,project,object,task,delivery),undefined);
});
