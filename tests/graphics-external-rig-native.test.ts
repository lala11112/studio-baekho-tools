import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
test('external rig offline native roundtrip preserves source and rejects ambiguity', { timeout: 180000 }, t => {
  if (!fs.existsSync(blender)) return t.skip('Blender not installed');
  const result=spawnSync(blender,['--factory-startup','-b','--python-exit-code','1','--python',path.resolve('tests/graphics-external-rig-native-fixture.py')],{encoding:'utf8',timeout:170000,maxBuffer:8*1024*1024});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/EXTERNAL_RIG_NATIVE_PASS/);
});
