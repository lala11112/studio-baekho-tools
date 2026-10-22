import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGraphicsExternalRigRunner, type ExternalRigArgs } from '../engine/graphics-external-rig';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rig-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['source.fbx', 'worker.py', 'blender.exe']) fs.writeFileSync(path.join(root, name), name);
  const args: ExternalRigArgs = { projectRoot: root, handoffId: 'fixture', sourceVersionId: 'source-v1', source: {path:'source.fbx', bytes:10, sha256:hash('source.fbx'),kind:'fbx'}, operation:'prepare', workerPath:path.join(root,'worker.py'), blenderPath:path.join(root,'blender.exe'), signal:new AbortController().signal };
  let calls = 0;
  const runner = (mode = 'valid') => createGraphicsExternalRigRunner({runBlender:async (_exe, argv) => {
    calls++;
    const reqFile = argv[argv.indexOf('--request')+1], reportFile = argv[argv.indexOf('--report')+1];
    const req = JSON.parse(fs.readFileSync(reqFile,'utf8'));
    fs.writeFileSync(path.join(req.outputDir,'prepared.fbx'),'result');
    fs.writeFileSync(path.join(req.outputDir,'source.blend'),'result');
    const item = {role:'preparation-fbx',path:path.join(req.outputDir,'prepared.fbx'),sha256:hash('result')};
    fs.writeFileSync(reportFile,JSON.stringify({schemaVersion:1,operation:'prepare',sourceSha256:req.sourceSha256,requestSha256:mode==='stale'?'0'.repeat(64):hash(fs.readFileSync(reqFile)),status:'complete',checks:(mode==='missing-check'?['staticSource']:['staticSource','sourceHashBound','sourceScenePacked','noInputWrites']).map(id=>({id,passed:true})),files:mode==='duplicate'?[item,item]:mode==='escape'?[{...item,path:path.join(root,'source.fbx')}]:mode==='missing-role'?[item]:[item,{...item,role:'source-scene',path:path.join(req.outputDir,'source.blend')}]}));
  }});
  return {root,args,runner,calls:()=>calls};
}
test('saved handoff recovers exact outputs without dispatching again',async t=>{
  const f=fixture(t),run=f.runner();
  const first=await run(f.args); assert.equal(first.handoff.state,'awaiting-external');
  const again=await run({...f.args,recoveryOnly:true}); assert.deepEqual(again.files,first.files); assert.equal(f.calls(),1);
  fs.writeFileSync(path.join(f.root,first.files[0].path),'edited');
  await assert.rejects(run({...f.args,recoveryOnly:true}),/changed/); assert.equal(f.calls(),1);
});
for(const mode of ['stale','duplicate','escape','missing-check','missing-role']) test(`rejects ${mode} worker report`,async t=>{
  const f=fixture(t); await assert.rejects(f.runner(mode)(f.args)); assert.equal(f.calls(),1);
});
test('durable dispatch prevents rerun after missing report',async t=>{
  const f=fixture(t),run=f.runner(); await run(f.args);
  fs.unlinkSync(path.join(f.root,'graphics/external-rig/fixture/prepare/output/report.json'));
  await assert.rejects(run(f.args),/Already dispatched/); assert.equal(f.calls(),1);
});
test('cancelled handoff and missing explicit returned FBX stay local',async t=>{
  const f=fixture(t), controller=new AbortController();controller.abort();
  await assert.rejects(f.runner()({...f.args,signal:controller.signal}),/cancelled/);
  await assert.rejects(f.runner()(f.args),/Cancelled/); assert.equal(f.calls(),0);
  await assert.rejects(f.runner()(f.args),/Cancelled/); assert.equal(f.calls(),0);
  await assert.rejects(f.runner()({...f.args,handoffId:'other',operation:'import-return'}),/Explicit/);
});
test('invalid source bytes and traversal handoff never dispatch',async t=>{
  const f=fixture(t);
  await assert.rejects(f.runner()({...f.args,handoffId:'../escape'}),/Invalid/);
  await assert.rejects(f.runner()({...f.args,source:{...f.args.source,sha256:'0'.repeat(64)}}),/changed/);
  assert.equal(f.calls(),0);
});
test('saved-only recovery verifies frozen tools after application upgrade',async t=>{
 const f=fixture(t),run=f.runner();const first=await run(f.args);
 fs.writeFileSync(f.args.workerPath,'new worker');fs.writeFileSync(f.args.blenderPath,'new blender');
 const recovered=await run({...f.args,recoveryOnly:true});assert.deepEqual(recovered.files,first.files);assert.equal(f.calls(),1);
 fs.writeFileSync(path.join(f.root,'graphics/external-rig/fixture/prepare/graphics_external_rig.py'),'tampered');
 await assert.rejects(run({...f.args,recoveryOnly:true}),/changed/);assert.equal(f.calls(),1);
});
for(const mode of ['blocked','stale-blocked','complete-nonzero'])test(`native nonzero ${mode} reports stay fail closed`,async t=>{
 const f=fixture(t);let calls=0;
 const run=createGraphicsExternalRigRunner({runBlender:async(_exe,argv)=>{
  calls++;const requestFile=argv[argv.indexOf('--request')+1],reportFile=argv[argv.indexOf('--report')+1],req=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  fs.writeFileSync(reportFile,JSON.stringify({schemaVersion:1,operation:req.operation,sourceSha256:req.sourceSha256,requestSha256:mode==='stale-blocked'?'0'.repeat(64):hash(fs.readFileSync(requestFile)),status:mode==='complete-nonzero'?'complete':'blocked',error:'Missing texture pixels: cloth.png',files:[],checks:[]}));
  throw Error('Local rig worker exited 1');
 }});
 if(mode==='blocked'){
  const result=await run(f.args);assert.equal(result.handoff.state,'blocked');assert.equal(result.handoff.error,'Missing texture pixels: cloth.png');assert.equal(result.files.length,1);
  const recovered=await run({...f.args,recoveryOnly:true});assert.equal(recovered.handoff.error,result.handoff.error);assert.equal(calls,1);
 }else{await assert.rejects(run(f.args),mode==='stale-blocked'?/binding/:/Nonzero/);await assert.rejects(run({...f.args,recoveryOnly:true}));assert.equal(calls,1);}
});
test('explicit coordinate matrix is frozen in actual native request and saved recovery',async t=>{
 const f=fixture(t),matrix=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],run=f.runner();
 await run({...f.args,sourceToReturnedMatrix:matrix});
 const req=JSON.parse(fs.readFileSync(path.join(f.root,'graphics/external-rig/fixture/prepare/request.json'),'utf8'));assert.deepEqual(req.sourceToReturnedMatrix,matrix);
 await run({...f.args,sourceToReturnedMatrix:matrix,recoveryOnly:true});
 await assert.rejects(run({...f.args,recoveryOnly:true}),/Stale/);assert.equal(f.calls(),1);
});
