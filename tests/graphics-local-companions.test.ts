import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('local A05/X04 native FBX companions are private, explicit, exact and fail closed', {timeout:120_000}, t => {
  const blender=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
  if(!fs.existsSync(blender))return t.skip('Blender is not installed');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-local-companions-'));
  const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('tests/graphics-local-companions-fixture.py')],{windowsHide:true,encoding:'utf8',timeout:110_000,maxBuffer:5*1024*1024,env:{...process.env,LOCAL_COMPANIONS_ROOT:root}});
  fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/qa-20261018-local-companions-native.log',result.stdout+result.stderr);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'evidence.json'),'utf8'));
  assert.equal(evidence.passed,true);assert(evidence.checks.length>=18);
  fs.writeFileSync('artifacts/runtime/qa-20261018-local-companions-native.json',JSON.stringify({...evidence,root},null,2));
});
