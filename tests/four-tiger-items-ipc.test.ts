import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {FourTigerItemsService, executeFourTigerCall} from '../engine/four-tiger-items/service';
const runner={probe:async()=>({available:true,authenticated:true,message:'test only'}),run:async()=>({status:'needs_input' as const,message:'test only'}),shutdown(){}};
test('dedicated API creates, edits, validates and exports proposals without generating or adopting',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'items-api-')),service=new FourTigerItemsService(root,runner);
 let p=await service.create({name:'API 초안'});assert.equal(p.items.length,20);
 p=await service.patchItem({projectId:p.projectId,expectedRevision:p.revision,candidateKey:p.items[0].candidateKey,patch:{name:'편집한 이름'}});
 assert.equal((await service.read({projectId:p.projectId})).items[0].name,'편집한 이름');
 assert.equal((await service.validate({projectId:p.projectId,mode:'release'})).canExport,false);
 const receipt=await service.exportPackage({projectId:p.projectId,expectedRevision:p.revision,kind:'draft'});assert.equal(receipt.kind,'draft');
 assert.equal((await service.list())[0].adopted,0);assert.equal(service.hasActiveWork(),false);await service.shutdown();
});
test('IPC rejects foreign senders, unknown methods/fields and oversized payloads before calling service',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'items-ipc-')),service=new FourTigerItemsService(root,runner);
 await assert.rejects(executeFourTigerCall(service,'create',{name:'bad'},false),{code:'UNTRUSTED_SENDER'});
 await assert.rejects(executeFourTigerCall(service,'constructor',{},true),{code:'INVALID_INPUT'});
 await assert.rejects(executeFourTigerCall(service,'create',{name:'bad',path:'C:\\outside'},true),{code:'INVALID_INPUT'});
 await assert.rejects(executeFourTigerCall(service,'create',{name:'x'.repeat(300000)},true),{code:'INVALID_INPUT'});
 assert.deepEqual(await service.list(),[]);
 const p=await executeFourTigerCall(service,'create',{name:'good'},true) as {items:unknown[]};assert.equal(p.items.length,20);await service.shutdown();
});
