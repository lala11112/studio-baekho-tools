import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('own A05/X04 FBX retains marked root and bounded FP32 residual without TRS correction', {timeout:120000}, t=>{
 const blender=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
 const source=process.env.A05_FBX_AUDIT_SOURCE;
 if(!fs.existsSync(blender)||!source||!fs.existsSync(source))return t.skip('Set A05_FBX_AUDIT_SOURCE to the preserved tiny A05 BLEND fixture');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-a05-fbx-roundtrip-'));
 const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('tests/graphics-a05-fbx-roundtrip-fixture.py')],{windowsHide:true,encoding:'utf8',timeout:110000,maxBuffer:5*1024*1024,env:{...process.env,A05_FBX_AUDIT_ROOT:root}});
 fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/qa-20261018-a05-fbx-roundtrip.log',result.stdout+result.stderr);
 assert.equal(result.status,0,result.stdout+result.stderr);
 const evidence=JSON.parse(fs.readFileSync(path.join(root,'evidence.json'),'utf8'));assert.equal(evidence.status,'PASS');assert(evidence.checks.length>=20);
 fs.writeFileSync('artifacts/runtime/qa-20261018-a05-fbx-roundtrip.json',JSON.stringify(evidence,null,2));
});
