// Real accepted rabbit, isolated profile. App button -> local Blender -> review, no AI/service call.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {_electron as electron} from 'playwright';import {Store} from '../engine/store';
const live=path.join(process.env.APPDATA!,'partsmith'),project='c73ee321-703d-4ad5-a595-364c1b8d6c88',bench='fa6cdada-1e5b-4298-8880-6ac5af24aef9';
const data=process.env.PARTSMITH_CHECK_DATA??fs.mkdtempSync(path.join(os.tmpdir(),'ps-motion-source-')),source=path.join(live,'projects',project);
const p=JSON.parse(fs.readFileSync(path.join(source,'project.json'),'utf8')),w=JSON.parse(fs.readFileSync(path.join(source,'workbench',bench,'workbench.json'),'utf8'));
assert(!w.activeJobId);assert(w.selections.rig);
if(!process.env.PARTSMITH_CHECK_DATA){
  fs.cpSync(source,path.join(data,'projects',project),{recursive:true});const store=new Store(data);
  await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));store.save(p);store.put('workbench',bench,w);store.db.close();
}
let app:any,page:any;const errors:string[]=[];
const sha=(f:string)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rig=w.jobs.find((j:any)=>j.id===w.selections.rig.jobId).candidates.find((c:any)=>c.id===w.selections.rig.candidateId);
const blend=rig.artifacts.find((a:any)=>a.kind==='blend'),sourceHash=sha(path.join(source,blend.path));
async function launch(){app=await electron.launch({executablePath:path.resolve('release/0.6.35/win-unpacked/Partsmith.exe'),env:{...process.env,PARTSMITH_DATA:data}});page=await app.firstWindow();page.on('pageerror',(e:Error)=>errors.push(e.message));await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();await page.getByTestId('workbench-step-motion').click();}
async function state(){return (await page.evaluate(()=>window.desktop.call({type:'state'}))).workbenches.find((v:any)=>v.id===bench);}
try{
  await launch();await page.getByTestId('motion-source-kind').selectOption('motion-source');
  assert(await page.getByTestId('workbench-motion-create').isVisible());
  assert(await page.getByTestId('workbench-execute-reference').isDisabled());
  if(!(await state()).jobs.some((j:any)=>j.step==='motion-source'&&j.status==='review'))await page.getByTestId('motion-source-prepare').click();
  let after:any;
  for(let n=0;n<90;n++){await new Promise(r=>setTimeout(r,2000));after=await state();if(after.jobs.some((j:any)=>j.step==='motion-source')&&!after.activeJobId)break;}
  const job=after.jobs.find((j:any)=>j.step==='motion-source');assert.equal(job.status,'review',job.summary);
  assert(!job.usage);assert(!job.externalExecution);
  if(!after.selections['motion-source'])await page.getByTestId('motion-source-accept').click();
  await page.getByTestId('motion-source-accept').waitFor();
  await page.getByRole('button',{name:'대기 설정',exact:true}).click();
  await page.getByTestId('workbench-approve').check();
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[data-testid="workbench-execute-reference"]')?.disabled);
  const images=job.candidates[0].artifacts.filter((a:any)=>a.kind==='image');
  const output=images.map((a:any)=>path.join(data,'projects',project,a.path));
  const report=JSON.parse(fs.readFileSync(path.join(data,'projects',project,job.candidates[0].artifacts.find((a:any)=>a.path.endsWith('render.json')).path),'utf8'));
  assert(report.fullBodyInFrame);assert.deepEqual(report.resolution,[2048,2048]);
  assert.equal(sha(path.join(source,blend.path)),sourceHash);assert.equal(sha(path.join(data,'projects',project,blend.path)),sourceHash);
  await page.screenshot({path:'artifacts/runtime/0.6.35-motion-source.png',fullPage:true});
  await app.close();await launch();assert((await state()).selections['motion-source']);assert(!(await state()).activeJobId);
  assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/runtime/0.6.35-motion-source.json',JSON.stringify({data,jobId:job.id,sourceHash,output,report,appButton:true,restart:true,workerCalls:0,paidSubmissions:0,errors},null,2));
  console.log(JSON.stringify({passed:true,output}));
}finally{await app?.close();}
