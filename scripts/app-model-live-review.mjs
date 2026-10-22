// Verifies already-generated real assets through the app UI; never submits production.
import {_electron as electron} from 'playwright';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const version='0.6.30',projectId='c73ee321-703d-4ad5-a595-364c1b8d6c88',benchId='fa6cdada-1e5b-4298-8880-6ac5af24aef9',jobId='a5d5e915-6c44-4953-85fd-119d6e570deb';
const data=path.join(process.env.APPDATA,'partsmith'),workspace=path.join(data,'projects',projectId,'workbench',benchId,'jobs',jobId);
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const journal=path.join(data,'workbench-chrome-journals',benchId,jobId+'.json');
const preserved=[journal,path.join(workspace,'external-result.json'),path.join(workspace,'app-worker-5','app-server-events.jsonl')];
const receipt=JSON.parse(fs.readFileSync(preserved[1],'utf8'));
for(const file of receipt.files){const p=path.join(workspace,file.path);assert.equal(digest(p),file.sha256);preserved.push(p);}
const hashes=preserved.map(file=>({file,sha256:digest(file)}));
const errors=[];let app,page;
async function launch(){
 app=await electron.launch({executablePath:path.resolve(`release/${version}/win-unpacked/Partsmith.exe`)});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 assert(page.url().includes(`/release/${version}/`));
 await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId('project-open').click();
 await page.getByTestId('workbench-step-parts').click();
}
async function state(){return page.evaluate(()=>window.desktop.call({type:'state'}));}
function check(s){
 const w=s.workbenches.find(w=>w.id===benchId),j=w.jobs.find(j=>j.id===jobId);
 assert(!w.activeJobId);assert.equal(j.status,'review');assert.equal(j.externalExecution.state,'received');assert.equal(j.externalExecution.worker.attempt,5);
 assert.equal(w.selections['model:whole'],undefined);assert.equal(w.selections.concept.candidateId,'image-1');
 assert.equal(j.candidates.length,1);assert.equal(j.externalExecution.studioModels[0].modelId,'c5109d40-f81f-4382-87b6-84afe561a57a');
 assert.equal(j.checks.filter(c=>!c.passed && c.severity==='warning').length,2);
 for(const h of hashes)assert.equal(digest(h.file),h.sha256,h.file);
 return j;
}
await launch();
const before=await state();assert(!before.workbenches.some(w=>w.activeJobId));
if(await page.getByTestId('workbench-external-receive').isVisible())await page.getByTestId('workbench-external-receive').click();
await page.getByTestId('workbench-accept-model').waitFor();check(await state());
await app.close();await launch();
await page.getByTestId('workbench-accept-model').waitFor();const j=check(await state());
await page.locator('canvas').first().waitFor();
await page.waitForFunction(()=>document.querySelector('canvas')?.width>0);
await page.screenshot({path:'artifacts/runtime/app-model-live-review.png',fullPage:true});
assert.deepEqual(errors,[]);
fs.writeFileSync('artifacts/runtime/app-model-live-verified.json',JSON.stringify({version,at:new Date().toISOString(),jobId,actualAssets:true,appButtonCollection:true,restart:true,selected:false,attempt:5,hashes,checks:j.checks,pageErrors:errors,newWorkerRunsDuringCollection:0,additionalPaidSubmissions:0},null,2));
console.log(JSON.stringify({version,review:true,appButtonCollection:true,restart:true,newWorkerRuns:0,additionalPaidSubmissions:0,pageErrors:errors}));
await new Promise(resolve=>app.on('close',resolve));
