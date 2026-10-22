// App-only local side preparation; no adoption or paid generation on the user's behalf.
import {_electron as electron,chromium} from 'playwright';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const data=path.join(process.env.APPDATA,'partsmith'),project='c73ee321-703d-4ad5-a595-364c1b8d6c88',bench='fa6cdada-1e5b-4298-8880-6ac5af24aef9';
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);
const old=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));
const state=await old.evaluate(()=>window.desktop.call({type:'state'}));assert(!state.workbenches.some(w=>w.activeJobId||w.jobs.some(j=>j.status==='running')));
const before=state.workbenches.find(w=>w.id===bench);assert(before.selections.rig);assert(!before.jobs.some(j=>j.step==='motion-source'));
const rig=before.jobs.find(j=>j.id===before.selections.rig.jobId).candidates.find(c=>c.id===before.selections.rig.candidateId);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals=rig.artifacts.map(a=>({path:a.path,hash:sha(path.join(data,'projects',project,a.path))}));
await old.close();await browser.close();
const app=await electron.launch({executablePath:path.resolve('release/0.6.35/win-unpacked/Partsmith.exe')}),page=await app.firstWindow(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();await page.getByTestId('workbench-step-motion').click();
await page.getByTestId('motion-source-kind').selectOption('motion-source');await page.getByTestId('motion-source-prepare').click();
console.log('0.6.35 local Blender side rendering started through app; no AI or paid submit.');
let after,job;
for(let n=0;n<90;n++){
  await new Promise(r=>setTimeout(r,2000));
  after=(await page.evaluate(()=>window.desktop.call({type:'state'}))).workbenches.find(w=>w.id===bench);
  job=after.jobs.find(j=>j.step==='motion-source');if(job&&!after.activeJobId)break;
}
assert.equal(job.status,'review',job.summary);assert(!after.selections['motion-source']);assert.deepEqual(after.selections,before.selections);
for(const prior of before.jobs)assert.deepEqual(after.jobs.find(j=>j.id===prior.id),prior);
for(const a of originals)assert.equal(sha(path.join(data,'projects',project,a.path)),a.hash);
await page.getByTestId('motion-input-review').waitFor();
await page.getByTestId('workbench-motion-create').scrollIntoViewIfNeeded();
assert(await page.getByTestId('workbench-execute-reference').isDisabled());assert.deepEqual(errors,[]);
await page.screenshot({path:'artifacts/runtime/0.6.35-live-motion.png',fullPage:true});
fs.writeFileSync('artifacts/runtime/0.6.35-live-motion.json',JSON.stringify({version:'0.6.35',jobId:job.id,sourceRig:before.selections.rig,status:job.status,adopted:false,artifacts:job.candidates[0].artifacts,originalsUnchanged:true,paidSubmissions:0,workerCalls:0,errors},null,2));
console.log('PASS live app local side render; images await user adoption, generation remains unsubmitted.');
await new Promise(resolve=>app.on('close',resolve));
