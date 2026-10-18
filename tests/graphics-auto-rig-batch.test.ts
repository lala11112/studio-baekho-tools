import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {validateAutoRigRepairs,type AutoRigInspection} from '../shared/graphics-auto-rig';
const inspection:AutoRigInspection={islands:[{mesh:'body',islandId:'a',vertices:2,vertexIndices:[0,1],bones:[]},{mesh:'body',islandId:'b',vertices:2,vertexIndices:[2,3],bones:[]},{mesh:'body',islandId:'overlap',vertices:2,vertexIndices:[1,2],bones:[]}],boneNames:['thumb','thigh'],humanBones:[],checks:[],warnings:[]};
const repair=(islandId:string)=>({mesh:'body',islandId,kind:'remove-influence' as const,bones:['thumb']});
test('shared exact batch rejects duplicate and overlapping selections but preserves ordered bone sets',()=>{
 assert.deepEqual(validateAutoRigRepairs(inspection,[repair('a'),repair('b')]),[repair('a'),repair('b')]);
 assert.throws(()=>validateAutoRigRepairs(inspection,[repair('a'),repair('a')]));
 assert.throws(()=>validateAutoRigRepairs(inspection,[repair('a'),repair('overlap')]),/겹치는/);
 assert.throws(()=>validateAutoRigRepairs(inspection,[{...repair('a'),bones:['thumb','thumb']}]));
});
const blender=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
test('tiny native batch preflight and isolated weight application, no ARP or export',{skip:!fs.existsSync(blender),timeout:60000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-rig-batch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const output=path.join(root,'result.json');const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('tests/graphics-auto-rig-batch-fixture.py'),'--',path.resolve('integrations/blender/graphics_auto_rig.py'),output],{encoding:'utf8',windowsHide:true,timeout:55000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const report=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(report.status,'PASS');assert.equal(report.checks.length,12);assert.equal(report.aiExecutions,0);assert.equal(report.licensedExports,0);
});
