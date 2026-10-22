import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {GraphicsEngine} from '../engine/graphics';
import type {GraphicsWorkspace} from '../shared/graphics';
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rig-adapter-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'source.blend'),'source');
 let w:GraphicsWorkspace={schemaVersion:1,id:'p',projectId:'p',revision:0,objects:[{id:'o',name:'human',kind:'character',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':'v'},creation:{subject:'human',parts:[]} as any}],versions:[{id:'v',objectId:'o',role:'model',slot:'main',label:'source',files:[{path:'source.blend',bytes:6,sha256:createHash('sha256').update('source').digest('hex'),kind:'blend'}],createdAt:'',sourceVersionIds:[],provenance:{type:'import'},warnings:[]}],tasks:[],deliveries:[]};
 const store:any={settings:{blenderPath:'unused'},all:()=>[structuredClone(w)],get:()=>structuredClone(w),put:(_:any,__:any,v:any)=>{w=structuredClone(v)},write:()=>{},project:()=>({jobs:[]}),directory:()=>root,file:(_:any,rel:string)=>path.join(root,rel)};
 let calls=0;const options:any={resources:root,externalRig:async(a:any)=>{calls++;return {handoff:{schemaVersion:1,handoffId:a.handoffId,sourceVersionId:'v',sourceSha256:a.source.sha256,operation:a.operation,state:'awaiting-external',updatedAt:'',files:[]},files:[],report:{},externalRig:{}}}};
 const engine=new GraphicsEngine(store,{isProjectActive:()=>false} as any,options);return {engine,get:()=>w,calls:()=>calls,store,options};
}
test('prepare saves manual waiting state without task, adoption or service call',async t=>{const f=fixture(t);const w=await f.engine.action('p',{kind:'prepare-external-rig',objectId:'o',versionId:'v'});assert.equal(w.externalRigHandoffs?.[0].state,'awaiting-external');assert.equal(w.tasks.length,0);assert.deepEqual(w.objects[0].accepted,{'model:main':'v'});assert.equal(f.calls(),1);assert.equal(f.engine.isActive('p'),false);await assert.rejects(f.engine.action('p',{kind:'prepare-external-rig',objectId:'o',versionId:'v'}));assert.equal(f.calls(),1);});
test('cancel and restart never dispatch waiting external work',async t=>{const f=fixture(t);let w=await f.engine.action('p',{kind:'prepare-external-rig',objectId:'o',versionId:'v'});new GraphicsEngine(f.store,{isProjectActive:()=>false} as any,f.options);assert.equal(f.calls(),1);w=await f.engine.action('p',{kind:'cancel-external-rig',objectId:'o',handoffId:w.externalRigHandoffs![0].id});assert.equal(w.externalRigHandoffs![0].state,'cancelled');await assert.rejects(f.engine.action('p',{kind:'recover-external-rig',objectId:'o',handoffId:w.externalRigHandoffs![0].id}));assert.equal(f.calls(),1);});
test('unaccepted or nonhuman sources cannot prepare',async t=>{const f=fixture(t);f.get().objects[0].accepted={};await assert.rejects(f.engine.action('p',{kind:'prepare-external-rig',objectId:'o',versionId:'v'}));assert.equal(f.calls(),0);});
