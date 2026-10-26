import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {UnityService,UnityOperationError} from '../electron/services/unity';
import {emptyBlueprint} from '../src/shared/blueprint';
import {hash} from '../electron/services/files';

async function fixture(run:(u:UnityService,journal:string)=>Promise<void>){
  const root=await mkdtemp(path.join(tmpdir(),'enemy-forge-recovery-'));
  try{await mkdir(path.join(root,'Library/BaekhoEnemyForge'),{recursive:true});
    const u=new UnityService();u.connection={projectRoot:root,projectName:'Test',unityVersion:'6000.3.10f1',instanceId:'test'};
    await run(u,path.join(root,'Library/BaekhoEnemyForge/app-build.json'));
  }finally{await rm(root,{recursive:true,force:true});}
}
test('lost build response is reconciled before any changed draft can start',()=>fixture(async(u,journal)=>{
  const b=emptyBlueprint(),originalHash=hash(JSON.stringify(b));
  await writeFile(journal,JSON.stringify({requestId:'original',inputHash:originalHash,pending:true}));b.name='ChangedEnemy';
  const calls:string[]=[];u.call=async(action,payload)=>{calls.push(action);assert.equal(payload?.inputHash,originalHash);return {requestId:'original',state:'completed',prefabPath:'Assets/Original.prefab'};};
  await assert.rejects(u.build(b),/이전 설계.*Assets\/Original.prefab/);assert.deepEqual(calls,['status']);
  assert.equal(JSON.parse(await readFile(journal,'utf8')).pending,false);
}));
test('same draft recovers its result and transport ambiguity preserves its request',()=>fixture(async(u,journal)=>{
  const b=emptyBlueprint(),inputHash=hash(JSON.stringify(b)),pending={requestId:'original',inputHash,pending:true};
  await writeFile(journal,JSON.stringify(pending));u.call=async()=>{throw new Error('transport closed');};
  await assert.rejects(u.build(b),/transport/);assert.deepEqual(JSON.parse(await readFile(journal,'utf8')),pending);
  u.call=async(action)=>{assert.equal(action,'status');return {requestId:'original',state:'completed',prefabPath:'Assets/Original.prefab'};};
  assert.equal((await u.build(b)).prefabPath,'Assets/Original.prefab');
}));
test('known pre-admission rejection permits retry while lost response stays pending',()=>fixture(async(u,journal)=>{
  u.call=async(action)=>{if(action==='ready')return {ready:true};throw new UnityOperationError(action==='status'?'No receipt exists for this request.':'Name already exists');};
  await assert.rejects(u.build(emptyBlueprint()),/Name already exists/);assert.equal(JSON.parse(await readFile(journal,'utf8')).pending,false);
  u.call=async(action)=>{if(action==='ready')return {ready:true};throw new Error('fetch failed');};
  await assert.rejects(u.build(emptyBlueprint()),/fetch failed/);assert.equal(JSON.parse(await readFile(journal,'utf8')).pending,true);
  u.call=async(action)=>{assert.equal(action,'status');throw new UnityOperationError('No receipt exists for this request. Do not automatically repeat a lost build request.');};
  await assert.rejects(u.build(emptyBlueprint()),/접수되지 않은/);assert.equal(JSON.parse(await readFile(journal,'utf8')).pending,false);
}));
test('returned error after publication still checks the durable receipt',()=>fixture(async(u,journal)=>{
  u.call=async(action)=>{if(action==='ready')return {ready:true};if(action==='build')throw new UnityOperationError('Receipt disk write failed');return {state:'completed',prefabPath:'Assets/AlreadyCreated.prefab'};};
  assert.equal((await u.build(emptyBlueprint())).prefabPath,'Assets/AlreadyCreated.prefab');
  const saved=JSON.parse(await readFile(journal,'utf8'));assert.equal(saved.pending,false);assert.equal(saved.result.prefabPath,'Assets/AlreadyCreated.prefab');
}));
