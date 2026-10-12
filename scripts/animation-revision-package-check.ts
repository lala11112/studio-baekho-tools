// Copied real originals, real packaged UI. Capture the button command and use
// a stub ONLY at the expensive authoring boundary; never create production output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import {Store} from '../engine/store';
import {WorkbenchEngine} from '../engine/workbench';
import {CodexWorkbenchExecutor} from '../engine/workbench-executor';
import type {WorkerTask, ProductionWorker} from '../engine/codex-worker';

const project='c73ee321-703d-4ad5-a595-364c1b8d6c88',bench='fa6cdada-1e5b-4298-8880-6ac5af24aef9';
const originalId='ae0e2f35-a665-484a-af79-bc62edb21040',failedId='9008467d-5841-4074-a11f-e17c0619a72e';
const source=path.join(process.env.APPDATA!,'partsmith','projects',project);
const p=JSON.parse(fs.readFileSync(path.join(source,'project.json'),'utf8'));
const w=JSON.parse(fs.readFileSync(path.join(source,'workbench',bench,'workbench.json'),'utf8'));
assert(!w.activeJobId);assert(!w.jobs.some((j:any)=>j.status==='running'));
const original=w.jobs.find((j:any)=>j.id===originalId),failed=w.jobs.find((j:any)=>j.id===failedId);
assert.equal(original.status,'review');assert.equal(failed.status,'failed');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ps-animation-revision-'));
fs.cpSync(source,path.join(data,'projects',project),{recursive:true});
let store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
store.save(p);store.put('workbench',bench,w);store.db.close();
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const preserved=[...original.candidates[0].artifacts,...w.jobs.find((j:any)=>j.id===w.selections['reference:Rabbit_Idle'].jobId).candidates[0].artifacts];
let app:any,page:any,captured:any;const errors:string[]=[];
async function launch(){
  app=await electron.launch({executablePath:path.resolve('release/0.6.36/win-unpacked/Partsmith.exe'),env:{...process.env,PARTSMITH_DATA:data}});
  page=await app.firstWindow();page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();
  await page.getByTestId('workbench-step-motion').click();await page.getByTestId('workbench-tab-animation').click();
  await page.getByTestId('workbench-animation-original').waitFor();
  await page.locator('.wb-results .playback select').waitFor();
  assert((await page.locator('.wb-results .playback select').textContent()).includes('Rabbit_Idle'));
  assert.equal(await page.locator('.wb-results .viewport-error').count(),0);
}
try{
  await launch();
  await page.getByTestId('workbench-motion-prompt').fill('');
  assert(await page.getByTestId('workbench-execute-animation').isDisabled());
  await page.getByTestId('workbench-reuse-revision-prompt').click();
  assert.equal(await page.getByTestId('workbench-motion-prompt').inputValue(),failed.request.prompt);
  assert(await page.getByTestId('workbench-execute-animation').isEnabled());
  // Isolated test instrumentation intercepts just execute. No real worker can run.
  await app.evaluate(({ipcMain}:any)=>{
    const originalHandler=ipcMain._invokeHandlers.get('partsmith:command');
    ipcMain.removeHandler('partsmith:command');
    ipcMain.handle('partsmith:command',(event:any,c:any)=>{
      if(c.type==='workbench.action'&&c.action.kind==='execute'){
        (globalThis as any).__capturedRevision=c;return {ok:true,value:null};
      }
      return originalHandler(event,c);
    });
  });
  await page.getByTestId('workbench-execute-animation').click();
  captured=await app.evaluate(()=> (globalThis as any).__capturedRevision);
  assert.equal(captured.action.request.baseJobId,originalId);
  assert.equal(captured.action.request.prompt,failed.request.prompt);
  assert.equal(captured.action.request.step,'animation');
  assert(!captured.action.request.motionVideo);
  await page.screenshot({path:'artifacts/runtime/0.6.36-animation-revision.png',fullPage:true});
  await app.close();await launch();
  const after=(await page.evaluate(()=>window.desktop.call({type:'state'}))).workbenches.find((v:any)=>v.id===bench);
  assert.deepEqual(after.jobs,w.jobs);assert.deepEqual(after.selections,w.selections);assert(!after.activeJobId);
  await app.close();app=undefined;

  const calls:WorkerTask[]=[];
  const worker:ProductionWorker={
    probe:async()=>({codex:{available:true,authenticated:true,message:'Test stub'},capabilities:{studio:false,video:false,motion:true},message:'Test stub'}),
    run:async task=>{calls.push(task);return {result:{status:'needs_input',summary:'Explicit authoring-boundary stub; no inference or production',candidates:[],checks:[]}};},
  };
  store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const executor=new CodexWorkbenchExecutor(worker,{projectRoot:()=>path.join(data,'projects',project),blenderPath:()=>'',unityPath:()=>undefined,unityEditorPath:()=>'',resourcesPath:path.resolve('integrations')});
  const engine=new WorkbenchEngine(store,executor);
  // Both the existing failed job's retry and the actual UI's new revision packet.
  engine.action(project,{kind:'retry',jobId:failedId});await engine.wait(bench);
  assert.equal(calls.length,1);
  engine.action(project,captured.action);await engine.wait(bench);
  assert.equal(calls.length,2);
  for(const task of calls){
    assert.match(task.prompt,/ANIMATION REVISION: Open the existing animated/);
    assert(task.prompt.includes(originalId));assert(task.prompt.includes('prior-animation-render-index'));
    const files=fs.readdirSync(path.join(task.run.workspace,'inputs'));
    const manifests=files.filter(f=>f.endsWith('frames.json')).map(f=>JSON.parse(fs.readFileSync(path.join(task.run.workspace,'inputs',f),'utf8')));
    const ref=manifests.find(m=>m.source==='video-ai');assert(ref);assert.equal(ref.mode,'side');
    const video=path.join(task.run.workspace,ref.videos.side.path);assert(fs.existsSync(video));
    const expectedVideo=preserved.find((a:any)=>a.kind==='video'&&a.path.includes('video-reference'));
    assert.equal(sha(video),expectedVideo.sha256);
    for(const frame of ref.frames)assert(fs.existsSync(path.join(task.run.workspace,frame.side)));
    assert(manifests.some(m=>m.count===60&&!m.frames));
  }
  for(const a of preserved){assert.equal(sha(path.join(source,a.path)),a.sha256);assert.equal(sha(path.join(data,'projects',project,a.path)),a.sha256);}
  assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/runtime/0.6.36-animation-revision.json',JSON.stringify({data,originalId,failedId,packagedButton:true,originalVisible:true,restart:true,realFileHandoff:true,stubCalls:calls.length,actualAstraCalls:0,paidSubmissions:0,originalHashesPreserved:true,errors},null,2));
  engine.shutdown();store.db.close();
  console.log('PASS packaged original playback/revision button/restart and real-file existing retry/new revision handoff; no Astra or paid submission');
}finally{await app?.close();}
