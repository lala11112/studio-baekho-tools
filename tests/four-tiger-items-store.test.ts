import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInitialProject, patchItem } from '../engine/four-tiger-items/domain';
import { FourTigerItemStore } from '../engine/four-tiger-items/store';
const now='2026-10-12T00:00:00.000Z';
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'사인검 with space-'));const store=new FourTigerItemStore(root);const p=await store.create(createInitialProject({projectId:randomUUID(),name:'한글 묶음',now}));return {root,store,p};}
test('atomic saves preserve Korean edits, previous snapshot, other projects and read-only summaries',async()=>{
  const {root,store,p}=await setup();const other=await store.create(createInitialProject({projectId:randomUUID(),name:'다른 묶음',now}));
  const next=await store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name:'편집한 새싹 부적'},now));
  assert.deepEqual(await store.read(p.projectId),next);assert.equal(next.revision,p.revision+1);assert.deepEqual(await store.read(other.projectId),other);
  const file=path.join(root,p.projectId,'draft.json');const before=(await fs.stat(file)).mtimeMs;
  assert.deepEqual(await store.list(),await store.list());assert.equal((await fs.stat(file)).mtimeMs,before);
  const restored=await store.restorePrevious(p.projectId);assert.equal(restored.items[0].name,'새싹 부적');assert.ok(restored.revision>next.revision);
});
test('concurrent stale revisions reject one writer rather than losing an edit',async()=>{
  const {store,p}=await setup();const results=await Promise.allSettled(['A','B'].map(name=>store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name},now))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'REVISION_CONFLICT');
});
test('write and rename failures preserve the last valid draft and never report success',async(t)=>{
  const {store,p}=await setup();
  for(const operation of ['writeFile','rename'] as const){
    const stub=t.mock.method(fs,operation,async()=>{throw Object.assign(new Error('disk failure'),{code:'ENOSPC'});});
    await assert.rejects(store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name:'not saved'},now)),{code:'IO_ERROR'});
    stub.mock.restore();assert.deepEqual(await store.read(p.projectId),p);
  }
});
test('corrupt and future schemas are visible and never silently replaced',async()=>{
  const {root,store,p}=await setup();await store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name:'latest'},now));
  const file=path.join(root,p.projectId,'draft.json');await fs.writeFile(file,'{bad');
  await assert.rejects(store.read(p.projectId),{code:'CORRUPT_PROJECT'});
  assert.match((await store.list())[0].readError??'',/복구/);assert.equal(await fs.readFile(file,'utf8'),'{bad');
  const restored=await store.restorePrevious(p.projectId);assert.equal(restored.items[0].name,'새싹 부적');
  await fs.writeFile(file,JSON.stringify({...restored,schemaVersion:2}));
  await assert.rejects(store.read(p.projectId),{code:'UNSUPPORTED_SCHEMA'});assert.equal(JSON.parse(await fs.readFile(file,'utf8')).schemaVersion,2);
});
test('invalid project IDs cannot escape storage or create files',async()=>{
  const {root,store}=await setup();const before=await fs.readdir(root);
  for(const key of ['../escape','C:\\escape','CON','not-a-uuid'])await assert.rejects(store.read(key),{code:'PATH_REJECTED'});
  assert.deepEqual(await fs.readdir(root),before);
});
