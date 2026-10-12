import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInitialProject, patchItem } from '../engine/four-tiger-items/domain';
import { FourTigerItemStore } from '../engine/four-tiger-items/store';
import { FourTigerIconQueue, inspectPng } from '../engine/four-tiger-items/icons';
import type { FourTigerIconRunner, IconRequest, IconRunnerResult } from '../engine/four-tiger-items/icon-runner';
import { writeTestPng } from './fixtures/four-tiger-items';
const delay=()=>new Promise(r=>setTimeout(r,10));
async function idle(queue:FourTigerIconQueue){for(let n=0;n<500&&queue.hasActiveWork();n++)await delay();assert.equal(queue.hasActiveWork(),false);}
async function setup(run:(r:IconRequest)=>Promise<IconRunnerResult>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'item-icons-'));const store=new FourTigerItemStore(root);const p=await store.create(createInitialProject({projectId:randomUUID(),name:'icons',now:new Date().toISOString()}));const runner:FourTigerIconRunner={probe:async()=>({available:true,authenticated:true,message:'test'}),run,shutdown(){}};return {root,store,p,queue:new FourTigerIconQueue(store,runner)};}
test('serial jobs preserve 7 finished files and collect current output after cancel pending',async()=>{
  let calls=0,active=0,max=0,release!:()=>void;
  const s=await setup(async r=>{calls++;active++;max=Math.max(max,active);if(calls===8)await new Promise<void>(resolve=>{release=resolve});await writeTestPng(path.join(r.jobDirectory,'outputs/source.png'),'valid',calls);active--;return {status:'generated',relativePath:'outputs/source.png',tool:'imagegen',observedModel:null};});
  await s.queue.enqueue(s.p.projectId,s.p.revision,s.p.items.map(i=>i.candidateKey));
  for(let n=0;n<500&&!release;n++)await delay();assert.ok(release);
  await s.queue.cancelPending(s.p.projectId);release();await idle(s.queue);
  const p=await s.store.read(s.p.projectId);assert.equal(calls,8);assert.equal(max,1);assert.equal(p.items.filter(i=>i.icons.length===1).length,8);assert.equal(p.jobs.filter(j=>j.status==='cancelled').length,12);assert.ok(p.items.every(i=>i.review.state==='draft'));
  await s.queue.reconcile(p.projectId);assert.equal(calls,8);
});
test('late output preserves edited content and rerolls never replace older bytes',async()=>{
  let release!:()=>void,calls=0;const s=await setup(async r=>{calls++;if(calls===1)await new Promise<void>(resolve=>{release=resolve});await writeTestPng(path.join(r.jobDirectory,'outputs/source.png'),'valid',calls);return {status:'generated',relativePath:'outputs/source.png',tool:'imagegen',observedModel:null};});
  await s.queue.enqueue(s.p.projectId,s.p.revision,[s.p.items[0].candidateKey]);for(let n=0;n<100&&!release;n++)await delay();
  let p=await s.store.read(s.p.projectId);p=await s.store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name:'편집 유지'},new Date().toISOString()));release();await idle(s.queue);
  p=await s.store.read(p.projectId);assert.equal(p.items[0].name,'편집 유지');assert.equal(p.items[0].icons.length,1);assert.equal(p.items[0].selectedIconVersion,null);
  const oldPath=await s.store.resolveFile(p.projectId,p.items[0].icons[0].sourcePath);const oldBytes=await fs.readFile(oldPath);
  await s.queue.enqueue(p.projectId,p.revision,[p.items[0].candidateKey]);await idle(s.queue);p=await s.store.read(p.projectId);
  assert.equal(p.items[0].icons.length,2);assert.deepEqual(await fs.readFile(oldPath),oldBytes);
  const icon=p.items[0].icons[1];assert.match(await s.queue.readIcon(p.projectId,p.items[0].candidateKey,icon.versionId),/^data:image\/png;base64,/);
  await fs.appendFile(await s.store.resolveFile(p.projectId,icon.thumbnailPath),'tamper');await assert.rejects(s.queue.readIcon(p.projectId,p.items[0].candidateKey,icon.versionId),{code:'ICON_HASH_MISMATCH'});
});
test('ambiguous worker output is recovered from its recorded folder without another invocation',async()=>{
  let calls=0;const s=await setup(async r=>{calls++;await writeTestPng(path.join(r.jobDirectory,'outputs/source.png'),'valid');throw new Error('response lost');});
  await s.queue.enqueue(s.p.projectId,s.p.revision,[s.p.items[0].candidateKey]);await idle(s.queue);
  let p=await s.store.read(s.p.projectId);assert.equal(p.jobs[0].status,'unknown');
  await assert.rejects(s.queue.enqueue(p.projectId,p.revision,[p.items[0].candidateKey]),{code:'JOB_UNCERTAIN'});
  p=await s.queue.reconcile(p.projectId);assert.equal(calls,1);assert.equal(p.items[0].icons.length,1);assert.equal(p.jobs[0].status,'validated');
  p=await s.queue.reconcile(p.projectId);assert.equal(p.items[0].icons.length,1);assert.equal(calls,1);
});
test('invalid PNG, opaque/empty images, oversize, path escape and duplicate identity never count as validated',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'png-check-'));
  for(const mode of ['opaque','empty'] as const){const file=path.join(root,mode+'.png');await writeTestPng(file,mode);await assert.rejects(inspectPng(file));}
  const file=path.join(root,'bad.png');await fs.writeFile(file,'not png');await assert.rejects(inspectPng(file));
  await fs.writeFile(file,Buffer.alloc(16*1024*1024+1));await assert.rejects(inspectPng(file),{code:'INVALID_PNG'});
  for(const relativePath of ['../outside.png','C:\\outside.png']){
    const s=await setup(async()=>({status:'generated',relativePath,tool:'imagegen',observedModel:null}));await s.queue.enqueue(s.p.projectId,s.p.revision,[s.p.items[0].candidateKey]);await idle(s.queue);const p=await s.store.read(s.p.projectId);assert.equal(p.jobs[0].status,'failed');assert.equal(p.items[0].icons.length,0);
  }
  const s=await setup(async r=>{await writeTestPng(path.join(r.jobDirectory,'outputs/source.png'),'valid');return {status:'generated',relativePath:'outputs/source.png',tool:'imagegen',observedModel:null};});await s.queue.enqueue(s.p.projectId,s.p.revision,s.p.items.slice(0,2).map(i=>i.candidateKey));await idle(s.queue);
  const p=await s.store.read(s.p.projectId);assert.equal(p.items.filter(i=>i.icons.length).length,1);assert.match(p.jobs[1].error??'',/중복/);
});
test('reconcile of empty unknown request never submits generation',async()=>{
  let calls=0;const s=await setup(async()=>{calls++;throw new Error('lost');});await s.queue.enqueue(s.p.projectId,s.p.revision,[s.p.items[0].candidateKey]);await idle(s.queue);await s.queue.reconcile(s.p.projectId);assert.equal(calls,1);assert.equal((await s.store.read(s.p.projectId)).jobs[0].status,'unknown');
});
test('a completed PNG survives manifest write failure and recovery adds exactly one version',async(t)=>{
  let calls=0;const s=await setup(async r=>{calls++;await writeTestPng(path.join(r.jobDirectory,'outputs/source.png'),'valid');return {status:'generated',relativePath:'outputs/source.png',tool:'imagegen',observedModel:null};});
  const original=s.store.update.bind(s.store);let fail=true;
  t.mock.method(s.store,'update',async(...[id,rev,change]:Parameters<FourTigerItemStore['update']>)=>original(id,rev,current=>{const next=change(current);if(fail&&next.items.some(i=>i.icons.length)){fail=false;throw new Error('disk full on manifest');}return next;}));
  await s.queue.enqueue(s.p.projectId,s.p.revision,[s.p.items[0].candidateKey]);await idle(s.queue);
  let p=await s.store.read(s.p.projectId);assert.equal(p.jobs[0].status,'unknown');assert.equal(p.items[0].icons.length,0);
  p=await s.queue.reconcile(p.projectId);assert.equal(p.items[0].icons.length,1);assert.equal(calls,1);
  await s.queue.reconcile(p.projectId);assert.equal((await s.store.read(p.projectId)).items[0].icons.length,1);
});
test('oversized PNG header and junction output cannot bypass host validation',async()=>{
  const s=await setup(async()=>({status:'needs_input',message:'unused'}));
  const file=path.join(s.root,'wide.png');await writeTestPng(file,'valid');const bytes=await fs.readFile(file);bytes.writeUInt32BE(4097,16);await fs.writeFile(file,bytes);await assert.rejects(inspectPng(file),{code:'INVALID_PNG'});
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'outside-icons-'));await writeTestPng(path.join(outside,'source.png'),'valid');
  await fs.symlink(outside,path.join(s.root,s.p.projectId,'linked'),'junction');
  await assert.rejects(s.store.resolveFile(s.p.projectId,'linked/source.png'),{code:'PATH_REJECTED'});
  await assert.rejects(s.store.ensureDirectory(s.p.projectId,'linked/new'),{code:'PATH_REJECTED'});
});
