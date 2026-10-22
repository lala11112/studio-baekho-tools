// Switch only an idle app to the verified package. Do not retry, adopt or submit.
import {_electron as electron,chromium} from 'playwright';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const data=path.join(process.env.APPDATA,'partsmith'),project='c73ee321-703d-4ad5-a595-364c1b8d6c88',bench='fa6cdada-1e5b-4298-8880-6ac5af24aef9';
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);
const old=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));
const state=await old.evaluate(()=>window.desktop.call({type:'state'}));
assert(!state.workbenches.some(w=>w.activeJobId||w.jobs.some(j=>j.status==='running')));
const before=state.workbenches.find(w=>w.id===bench);
const base=before.jobs.find(j=>j.id==='ae0e2f35-a665-484a-af79-bc62edb21040');assert.equal(base.status,'review');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const reference=before.jobs.find(j=>j.id===before.selections['reference:Rabbit_Idle'].jobId);
const originals=[...base.candidates[0].artifacts,...reference.candidates[0].artifacts];
for(const a of originals)assert.equal(sha(path.join(data,'projects',project,a.path)),a.sha256);
await old.close();await browser.close();
let app,page;const errors=[];
async function launch(){
  app=await electron.launch({executablePath:path.resolve('release/0.6.36/win-unpacked/Partsmith.exe')});page=await app.firstWindow();
  assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.6.36');
  page.on('pageerror',e=>errors.push(e.message));
  await page.locator(`[data-project-id="${project}"]`).getByTestId('project-open').click();
  await page.getByTestId('workbench-step-motion').click();await page.getByTestId('workbench-tab-animation').click();
  await page.getByTestId('workbench-animation-original').waitFor();await page.locator('.wb-results .playback select').waitFor();
  assert((await page.locator('.wb-results .playback select').textContent()).includes('Rabbit_Idle'));
  const after=(await page.evaluate(()=>window.desktop.call({type:'state'}))).workbenches.find(w=>w.id===bench);
  assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.selections,before.selections);assert(!after.activeJobId);
}
await launch();await app.close();await launch();
await page.getByTestId('workbench-reuse-revision-prompt').click();
assert(await page.getByTestId('workbench-execute-animation').isEnabled());
await page.getByTestId('workbench-animation-original').scrollIntoViewIfNeeded();
await page.screenshot({path:'artifacts/runtime/0.6.36-live-animation-revision.png',fullPage:true});
for(const a of originals)assert.equal(sha(path.join(data,'projects',project,a.path)),a.sha256);
assert.deepEqual(errors,[]);
fs.writeFileSync('artifacts/runtime/0.6.36-live-animation-revision.json',JSON.stringify({version:'0.6.36',originalVisible:true,restart:true,jobsSelectionsAndHashesUnchanged:true,workerCalls:0,paidSubmissions:0,errors},null,2));
console.log('PASS live 0.6.36 original visible/playable, restart preserved history/reference/hashes. Existing failed revision ready; not retried.');
await new Promise(resolve=>app.on('close',resolve));
