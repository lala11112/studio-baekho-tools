import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{spawnSync}from'node:child_process';
test('native external FBX companions preserve exact packed image bytes, UV and bounded repair; unsafe manifests block',{timeout:90000},t=>{
 const blender=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';if(!fs.existsSync(blender))return t.skip('Blender is not installed');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-planar-companion-test-'));
 const result=spawnSync(blender,['--factory-startup','-b','--python-exit-code','1','--python',path.resolve('tests/graphics-planar-companions-native.py')],{encoding:'utf8',timeout:80000,maxBuffer:4*1024*1024,windowsHide:true,env:{...process.env,PLANAR_COMPANION_ROOT:root}});
 assert.equal(result.status,0,result.stdout+result.stderr);const evidence=JSON.parse(fs.readFileSync(path.join(root,'evidence.json'),'utf8'));assert.equal(evidence.passed,true);assert.equal(evidence.checks.length,10);
 fs.mkdirSync('artifacts/runtime/qa-20261018-ui',{recursive:true});fs.writeFileSync('artifacts/runtime/qa-20261018-ui/planar-companion-native-fixture.json',JSON.stringify({root,...evidence},null,2));
});
