// Actual packaged reference controls on copied user data. No generation or browser work.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';import {Store} from '../engine/store';import {WorkbenchEngine} from '../engine/workbench';
const live=path.join(process.env.APPDATA!,'partsmith'),project='81ac0f31-8c0a-411c-8f95-b53a518fe766',bench='7b77f0ac-591c-4459-89a8-ebd1dbe3529c',stopped='159ebd6e-f84c-4749-aba6-8bdff7eb680a';
const source=path.join(live,'projects',project),data=fs.mkdtempSync(path.join(os.tmpdir(),'ps-concept-reference-'));
const p=JSON.parse(fs.readFileSync(path.join(source,'project.json'),'utf8')),w=JSON.parse(fs.readFileSync(path.join(source,'workbench',bench,'workbench.json'),'utf8'));
assert(!w.activeJobId);const selected=w.selections.concept;
const artifact=w.jobs.find((j:any)=>j.id===selected.jobId).candidates.find((c:any)=>c.id===selected.candidateId).artifacts.find((a:any)=>a.kind==='image');
const sha=(f:string)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');assert.equal(sha(path.join(source,artifact.path)),artifact.sha256);
fs.cpSync(source,path.join(data,'projects',project),{recursive:true});
const journal=path.join(live,'workbench-chrome-journals',bench);if(fs.existsSync(journal))fs.cpSync(journal,path.join(data,'workbench-chrome-journals',bench),{recursive:true});
let store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));store.save(p);store.put('workbench',bench,w);store.db.close();
let app:any,page:any;const errors:string[]=[];
async function launch(){app=await electron.launch({executablePath:path.resolve('release/0.6.37/win-unpacked/Partsmith.exe'),env:{...process.env,PARTSMITH_DATA:data}});page=await app.firstWindow();page.on('pageerror',(e:Error)=>errors.push(e.message));await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();await page.getByTestId('workbench-concept-reference').waitFor();}
try{
  await launch();assert.equal(await page.getByTestId('workbench-concept-mode').inputValue(),'reference');
  const img=page.getByTestId('workbench-concept-reference').locator('img');assert((await img.getAttribute('src'))!.includes(artifact.path));
  await page.waitForFunction(()=>{const i=document.querySelector<HTMLImageElement>('[data-testid="workbench-concept-reference"] img');return i?.complete&&i.naturalWidth>0;});
  await page.getByTestId('workbench-close-empty-concept').click();
  await page.getByTestId('workbench-close-empty-concept').waitFor({state:'detached'});
  const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
  let after=(await state()).workbenches.find((x:any)=>x.id===bench);
  assert.equal(after.jobs.find((j:any)=>j.id===stopped).status,'cancelled');assert(after.jobs.find((j:any)=>j.id===stopped).externalExecution.closedBeforeSubmissionAt);
  assert.deepEqual(after.selections,w.selections);assert.equal(after.jobs.length,w.jobs.length);
  await app.evaluate(({ipcMain}:any)=>{const handler=ipcMain._invokeHandlers.get('partsmith:command');ipcMain.removeHandler('partsmith:command');ipcMain.handle('partsmith:command',(e:any,c:any)=>{if(c.type==='workbench.action'&&c.action.kind==='execute'){(globalThis as any).__referenceCommand=c;return {ok:true,value:null};}return handler(e,c);});});
  await page.getByTestId('workbench-concept-prompt').fill('이 친구가 사용할 만한 양손 대검을 만들어줘');
  await page.getByTestId('workbench-concept-count').fill('2');
  if(await page.getByTestId('workbench-approve').count())await page.getByTestId('workbench-approve').check();
  await page.getByTestId('workbench-execute-concept').click();
  const c=await app.evaluate(()=>(globalThis as any).__referenceCommand);
  assert.equal(c.action.request.conceptMode,'reference');assert.equal(c.action.request.baseJobId,selected.jobId);assert.equal(c.action.request.baseCandidateId,selected.candidateId);assert.equal(c.action.request.generationCount,2);
  await page.getByTestId('workbench-concept-reference').scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/runtime/0.6.37-concept-reference.png',fullPage:true});
  await app.close();await launch();after=(await state()).workbenches.find((x:any)=>x.id===bench);assert(!after.activeJobId);assert.equal(after.jobs.length,w.jobs.length);assert.deepEqual(after.selections,w.selections);await app.close();app=undefined;
  store=new Store(data);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const engine=new WorkbenchEngine(store,{execute:async()=>{throw Error('No worker expected');}});
  const job=engine.action(project,{...c.action,request:{...c.action.request,executionMode:'codex-session'}}).jobs[0];
  const packet=JSON.parse(fs.readFileSync(path.join(data,'projects',project,'workbench',bench,'jobs',job.id,'external-request.json'),'utf8'));
  assert.deepEqual(packet.inputs,[artifact]);assert.equal(packet.request.generationCount,2);assert.equal(packet.request.conceptMode,'reference');
  assert.equal(sha(path.join(source,artifact.path)),artifact.sha256);assert.equal(sha(path.join(data,'projects',project,artifact.path)),artifact.sha256);assert.deepEqual(errors,[]);
  engine.shutdown();store.db.close();fs.writeFileSync('artifacts/runtime/0.6.37-concept-reference.json',JSON.stringify({data,packagedButton:true,hostUnsubmittedCheck:true,realOriginalPacket:true,reference:artifact.sha256,restart:true,workerCalls:0,paidSubmissions:0,errors},null,2));
  console.log('PASS packaged reference selection/closure/restart and exact original in frozen packet. No browser generation.');
}finally{await app?.close();}
