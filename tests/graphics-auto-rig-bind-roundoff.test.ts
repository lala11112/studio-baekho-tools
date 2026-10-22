import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
test('ARP FBX roundoff requires bounded matrices and evaluated vertices and preserves pose',t=>{
 const binary=process.env.BLENDER_PATH??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';if(!fs.existsSync(binary))return t.skip('Blender not installed');
 const result=spawnSync(binary,['--factory-startup','--background','--python-exit-code','1','--python','tests/graphics-auto-rig-bind-roundoff.py'],{encoding:'utf8',timeout:60000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/AUTO_RIG_BIND_ROUNDOFF_PASS/);
});
