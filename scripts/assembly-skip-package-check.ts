// Isolated copy of the real accepted surface. No inference or service submission.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {Store} from '../engine/store';
import {WorkbenchEngine} from '../engine/workbench';
import type {WorkbenchExecutionContext} from '../shared/workbench';

const live=path.join(process.env.APPDATA!,'partsmith');
const project='c73ee321-703d-4ad5-a595-364c1b8d6c88',bench='fa6cdada-1e5b-4298-8880-6ac5af24aef9';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ps-assembly-skip-'));
const source=path.join(live,'projects',project);
const p=JSON.parse(fs.readFileSync(path.join(source,'project.json'),'utf8'));
const w=JSON.parse(fs.readFileSync(path.join(source,'workbench',bench,'workbench.json'),'utf8'));
assert(!w.activeJobId);assert(w.selections.surface);
fs.cpSync(source,path.join(data,'projects',project),{recursive:true});
let store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
store.save(p);store.put('workbench',bench,w);store.db.close();
let app:any,page:any;
async function launch(){
  app=await electron.launch({executablePath:path.resolve('release/0.6.34/win-unpacked/Partsmith.exe'),env:{...process.env,PARTSMITH_DATA:data}});
  page=await app.firstWindow();
  await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();
}
async function state(){return (await page.evaluate(()=>window.desktop.call({type:'state'}))).workbenches.find((v:any)=>v.id===bench);}
const errors:string[]=[];
try{
  await launch();page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.getByTestId('workbench-step-assembly').click();
  await page.getByTestId('workbench-skip-assembly').click();
  await page.getByTestId('workbench-direct-rig-source').waitFor();
  assert(await page.getByTestId('workbench-execute-rig').isEnabled());
  const after=await state();assert.equal(after.rigSource,'surface');assert(!after.activeJobId);
  assert.deepEqual(after.jobs,w.jobs);assert.deepEqual(after.selections,w.selections);
  await app.close();await launch();
  await page.getByTestId('workbench-step-rig').click();
  await page.getByTestId('workbench-direct-rig-source').waitFor();
  assert(await page.getByTestId('workbench-execute-rig').isEnabled());
  assert.equal((await state()).rigSource,'surface');
  await page.screenshot({path:'artifacts/runtime/0.6.34-assembly-skip.png',fullPage:true});
  await app.close();app=undefined;
  // Host dispatch on the copied real originals. Stub stops before any Astra/Blender work.
  store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let captured:WorkbenchExecutionContext|undefined;
  const engine=new WorkbenchEngine(store,{async execute(ctx){captured=ctx;return {status:'needs_input',summary:'Explicit dispatch-only stub; no production',candidates:[],checks:[]};}});
  engine.action(project,{kind:'execute',request:{step:'rig',prompt:'네 발 토끼 리깅',rigProfile:'quadruped',rigControls:{ears:true,tail:true}}});
  await engine.wait(bench);
  assert(captured);assert.equal(captured.job.request.rigSource,'surface');
  assert(!captured.job.dependencies.assembly);
  const surface=w.jobs.find((j:any)=>j.id===w.selections.surface.jobId).candidates.find((c:any)=>c.id===w.selections.surface.candidateId);
  const native=surface.artifacts.find((a:any)=>a.kind==='model'&&a.path.endsWith('.fbx'));
  const texture=surface.artifacts.find((a:any)=>a.role==='texture');
  assert(captured.inputs.some(a=>a.sha256===native.sha256));assert(captured.inputs.some(a=>a.sha256===texture.sha256));
  assert(!captured.inputs.some(a=>a.kind==='export'));assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/runtime/0.6.34-assembly-skip.json',JSON.stringify({data,realCopiedSurface:true,packagedSkipButton:true,restart:true,noWorkerOnSkip:true,dispatchOnlyStub:true,nativeSha256:native.sha256,textureSha256:texture.sha256,dependencies:captured.job.dependencies,errors},null,2));
  engine.shutdown();store.db.close();
  console.log('PASS packaged skip/restart and real-file host rig handoff; no paid/GPT/Blender work');
}finally{await app?.close();}
