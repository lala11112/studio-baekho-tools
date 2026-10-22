import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
// Explicit opt-in: reuses a user's saved licensed rig, invokes export once, never AI.
const source=process.env.PARTSMITH_SAVED_ARP_RIG;
test('native multipart identity/hair/export contract on a synthetic fixture using an existing rig, no AI',{skip:!source,timeout:120000},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-parts-'));
 const binary=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
 const result=spawnSync(binary,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('tests/graphics-auto-rig-parts-fixture.py'),'--',root,path.resolve(source!),path.resolve('integrations/blender')],{encoding:'utf8',timeout:110000,windowsHide:true});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const report=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));assert.equal(report.status,'PASS');assert.equal(report.aiExecutions,0);assert.equal(report.sourcePreserved,true);assert.equal(report.licensedExports,1);assert.ok(report.checks.length>=13);
});
