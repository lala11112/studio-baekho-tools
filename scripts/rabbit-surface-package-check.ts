/** Isolated host/UI check using the real selected rabbit. Never submits to Tripo. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import {Store} from '../engine/store';
const live=path.join(process.env.APPDATA!,'partsmith');
const projectId='26122336-8a7c-48b5-b15f-fa193ca157fd';
const workbenchId='1839dc9e-c05b-459b-b985-6ceca49fac76';
const data=path.resolve('artifacts/runtime/rabbit-surface-package-'+Date.now());
const projectPath=path.join(live,'projects',projectId);
const project=JSON.parse(fs.readFileSync(path.join(projectPath,'project.json'),'utf8'));
const workbench=JSON.parse(fs.readFileSync(path.join(projectPath,'workbench',workbenchId,'workbench.json'),'utf8'));
assert.equal(workbench.selections['model:whole'].candidateId,'model-1');
assert.equal(workbench.selections['model:whole'].jobId,'70271c6d-bba8-4d11-8e90-ce801d0ae47f');
assert(!workbench.jobs.some((j:any)=>j.status==='running'));
const store=new Store(data);
await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
store.put('project',projectId,project);
store.put('workbench',workbenchId,workbench);
store.db.close();
fs.cpSync(projectPath,path.join(data,'projects',projectId),{recursive:true});
const errors:string[]=[];
const launch=async()=>{
  const app=await electron.launch({executablePath:path.resolve('release/0.6.6/win-unpacked/Partsmith.exe'),
    env:{...process.env,PARTSMITH_DATA:data}});
  const page=await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId('project-open').click();
  await page.getByTestId('workbench-step-surface').click();
  return {app,page};
};
let {app,page}=await launch();
try {
  assert(await page.getByTestId('workbench-external-surface').isChecked());
  await page.getByTestId('workbench-observed-uv-cost').fill('20');
  await page.getByTestId('workbench-observed-texture-cost').fill('20');
  await page.getByTestId('workbench-texture-resolution').selectOption('4K');
  await page.getByTestId('workbench-remove-lighting').uncheck();
  await page.getByTestId('workbench-credit-limit').fill('40');
  await page.getByTestId('workbench-approve').check(); // Isolated local request only, no service execution.
  await page.getByTestId('workbench-execute-surface').click();
  await page.getByTestId('workbench-external-receive').waitFor();
  const state:any=await page.evaluate(()=> (window as any).desktop.call({type:'state'}));
  const w=state.workbenches.find((w:any)=>w.id===workbenchId),j=w.jobs[0];
  assert.equal(j.step,'surface');assert.equal(j.status,'needs_input');assert.equal(j.externalExecution.state,'prepared');
  assert.equal(w.activeJobId,undefined);assert.equal(w.selections.surface,undefined);
  const packet=JSON.parse(fs.readFileSync(path.join(data,'projects',projectId,'workbench',workbenchId,'jobs',j.id,'external-request.json'),'utf8'));
  assert.equal(packet.sourceStudioModel.modelId,'19f0354a-a6db-41a7-a0d1-0110c79a6a2b');
  assert.equal(packet.request.externalSurface.textureResolution,'4K');
  assert.equal(packet.approval.studioCreditLimit,40);
  await page.getByTestId('workbench-external-receive').scrollIntoViewIfNeeded();
  await page.screenshot({path:'artifacts/runtime/rabbit-surface-package.png',timeout:10000});
  await app.close();
  ({app,page}=await launch());
  const restored:any=await page.evaluate(()=> (window as any).desktop.call({type:'state'}));
  const rw=restored.workbenches.find((w:any)=>w.id===workbenchId);
  assert.equal(rw.jobs[0].id,j.id);assert.equal(rw.jobs[0].externalExecution.state,'prepared');
  assert.equal(rw.selections['model:whole'].candidateId,'model-1');assert.equal(rw.activeJobId,undefined);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({isolatedData:data,jobId:j.id,selectedModel:packet.sourceStudioModel.modelId,
    package:'0.6.6',restartPreserved:true,serviceSubmitted:false,errors}));
} finally {await app.close();}
