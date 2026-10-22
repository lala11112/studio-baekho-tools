import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('private UV0 export preserves all layers and shader UV semantics in bounded local routes', {timeout:120000}, t=>{
 const blender=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';if(!fs.existsSync(blender))return t.skip('Blender unavailable');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-uv-export-'));
 const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('tests/graphics-uv-export-fixture.py')],{windowsHide:true,encoding:'utf8',timeout:110000,maxBuffer:6*1024*1024,env:{...process.env,GRAPHICS_UV_EXPORT_ROOT:root}});
 fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/qa-20261018-uv-export-native.log',result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 const evidence=JSON.parse(fs.readFileSync(path.join(root,'evidence.json'),'utf8'));assert.equal(evidence.status,'PASS');assert(evidence.checks.length>=12);fs.writeFileSync('artifacts/runtime/qa-20261018-uv-export-native.json',JSON.stringify(evidence,null,2));
});
