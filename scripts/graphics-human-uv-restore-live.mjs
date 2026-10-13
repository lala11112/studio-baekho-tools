// Drive the app's local-only recovery; never approve, submit, or adopt a result.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const evidence='artifacts/runtime/graphics-human-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8')),mode=process.argv[2];assert(['snapshot-close','verify-restart','restore','inspect','review'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2)),hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]),page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(15000);
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const rawId='f8da0545-1c51-401b-bdc6-10290c3311b5',taskId='b10ce250-8d5e-497c-943e-5213658c351f';
const open=async()=>{const button=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await button.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await button.click();await page.getByTestId('graphics-object-'+r.objectId).click();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'3 재질',exact:true}).click();};
try{
 const spaces=(await state()).graphicsWorkspaces;
 if(!r.headUvRestoration){assert(!spaces.some(w=>w.tasks.some(t=>t.status==='running')));r.headUvRestoration={startedAt:new Date().toISOString(),beforeWorkspaces:spaces,backendHash:hash(path.join(r.profile,'projects',r.projectId,'project.json')),rawId,taskId};save();}
 const record=r.headUvRestoration,w=await workspace();
 for(const old of record.beforeWorkspaces){for(const v of old.versions)for(const f of v.files)assert.equal(hash(path.join(r.profile,'projects',old.projectId,f.path)),f.sha256);if(old.projectId!==r.projectId)assert.deepEqual(spaces.find(s=>s.projectId===old.projectId),old);}
 const before=record.beforeWorkspaces.find(w=>w.projectId===r.projectId);assert.deepEqual(w.versions.slice(0,before.versions.length),before.versions);assert.deepEqual(w.objects.map(o=>o.accepted),before.objects.map(o=>o.accepted));assert.deepEqual(w.tripoBudget,before.tripoBudget);
 assert.equal(hash(path.join(r.profile,'projects',r.projectId,'project.json')),record.backendHash,'No remote job changes during local restore');
 for(const task of before.tasks)if(task.id!==taskId)assert.deepEqual(w.tasks.find(t=>t.id===task.id),task);
 if(mode==='snapshot-close'){assert(!spaces.some(w=>w.tasks.some(t=>t.status==='running')));record.restartBefore=spaces;save();await page.close();}
 else if(mode==='verify-restart'){assert.deepEqual(spaces,record.restartBefore);record.restartPreservedAt=new Date().toISOString();save();await open();await page.getByTestId('graphics-version-'+rawId).click();assert(await page.getByTestId('graphics-restore-part-space').isVisible());assert(await page.getByTestId('graphics-accept-version').isDisabled());await page.screenshot({path:'artifacts/runtime/graphics-human-uv-restore-ready.png'});}
 else if(mode==='restore'){
  assert(!record.clickedAt,'Inspect same local restoration before retry');assert(!w.versions.some(v=>v.partSpace?.providerVersionId===rawId));assert.equal(w.tasks.find(t=>t.id===taskId).status,'review');
  if(!await page.getByTestId('graphics-version-'+rawId).isVisible())await open();await page.getByTestId('graphics-version-'+rawId).click();record.clickedAt=new Date().toISOString();save();await page.getByTestId('graphics-restore-part-space').click();
 }else if(mode==='review'){
  const task=w.tasks.find(t=>t.id===taskId);assert.equal(task.status,'review',task.message);const version=w.versions.find(v=>v.partSpace?.providerVersionId===rawId);assert(version);assert.equal(version.partSpace.sourceVersionId,'ce10dcc9-125d-4760-8f44-88162e29899c');assert.equal(w.versions.length,before.versions.length+1);
  if(!await page.getByTestId('graphics-version-'+version.id).isVisible())await open();await page.getByTestId('graphics-version-'+version.id).click();const viewport=page.getByTestId('graphics-preview');await viewport.locator('canvas').waitFor();await viewport.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/runtime/graphics-human-uv-restored-app.png'});
  Object.assign(record,{versionId:version.id,version,report:JSON.parse(fs.readFileSync(path.join(r.profile,'projects',r.projectId,version.partSpace.reportPath),'utf8')),reviewedAt:new Date().toISOString(),paidRequestsAdded:0,productionGptCalls:0,acceptanceUnchanged:true,originalsPreserved:true});save();
 }
 const current=mode==='snapshot-close'?w:await workspace(),task=current.tasks.find(t=>t.id===taskId);Object.assign(record,{lastCheckedAt:new Date().toISOString(),status:task.status,message:task.message});save();console.log(JSON.stringify({mode,status:task.status,message:task.message,versionId:record.versionId,paidRequestsAdded:0,productionGptCalls:0}));
}catch(error){r.headUvRestoration??={};r.headUvRestoration.lastError=String(error);save();throw error;}finally{await browser.close();}
