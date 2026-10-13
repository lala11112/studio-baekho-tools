// User-authorized part adoption and app cost preparation only. Never submits API work.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const evidence='artifacts/runtime/graphics-human-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8')),mode=process.argv[2]??'prepare';assert(['prepare','snapshot-close','verify-restart'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2)),hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]),page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(20000);
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async predicate=>{for(let i=0;i<100;i++){const w=await workspace();if(predicate(w))return w;await new Promise(resolve=>setTimeout(resolve,150));}throw Error('Inspect existing task before any retry');};
const ids={head:'ce10dcc9-125d-4760-8f44-88162e29899c',body:'fdf8e4f2-8dce-4f70-aa29-0d92b71b4364',hair:'aa293092-5003-420f-838e-92cad836403a'};
const open=async()=>{const button=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await button.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await button.click();await page.getByTestId('graphics-object-'+r.objectId).click();};
try{
 let w=await workspace();assert(w);assert(!w.tasks.some(t=>t.status==='running'));
 const pending=w.tasks.filter(t=>['awaiting_approval','submission_unknown'].includes(t.status));
 if(mode==='prepare'&&!r.materialPreparation?.taskId&&pending.length){
  assert(r.materialPreparation?.beforeWorkspaces);assert.equal(pending.length,1);const task=pending[0];assert.equal(task.taskId,'T01');assert.equal(task.status,'awaiting_approval');assert.equal(task.settings.partId,'head');assert(task.inputVersionIds.includes(ids.head));assert(!task.inputVersionIds.includes('ef127317-c570-4723-9712-925c9c2373e6'));assert.equal(task.cost.provider,'Tripo API');assert.equal(task.cost.credits,20);
  Object.assign(r.materialPreparation,{taskId:task.id,requestHash:task.requestHash,cost:task.cost,inputVersionIds:task.inputVersionIds,accepted:ids,recoveredPreparedTaskAt:new Date().toISOString()});save();
 }
 if(mode==='prepare'&&!r.materialPreparation?.taskId){
  r.materialPreparation??={beforeWorkspaces:(await state()).graphicsWorkspaces,authorizedBy:'User adopted new head and existing body/hair; prepare per-part UV/texture only.',startedAt:new Date().toISOString()};save();
  if(!await page.getByTestId('graphics-version-'+ids.head).isVisible())await open();
  await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();
  for(const [part,id]of Object.entries(ids)){
   w=await workspace();const version=w.versions.find(v=>v.id===id);assert.equal(version.slot,'part-'+part);assert.equal(version.role,'model');
   if(w.objects.find(o=>o.id===r.objectId).accepted['model:part-'+part]!==id){await page.getByTestId('graphics-version-'+id).click();await page.getByTestId('graphics-accept-version').click();await wait(w=>w.objects.find(o=>o.id===r.objectId).accepted['model:part-'+part]===id);}
  }
  await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'3 재질',exact:true}).click();
  const part=page.getByTestId('graphics-creation-options').locator('.gs-part').filter({has:page.getByRole('checkbox',{name:'머리',exact:true})});await part.getByRole('button',{name:/현재 파트|이 파트 설정/}).click();
  for(const name of ['UV 준비','Tripo Smart UV']){const button=page.getByRole('button',{name,exact:true});if(await button.getAttribute('aria-pressed')!=='true')await button.click();}
  // Choice edits stay in the renderer draft until preparation saves the request.
  assert((await page.getByTestId('graphics-creation-options').innerText()).includes('현재 파트: 머리.'));
  for(const name of ['UV 준비','Tripo Smart UV'])assert.equal(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed'),'true');
  assert(!(await workspace()).tasks.some(t=>['awaiting_approval','submission_unknown','running'].includes(t.status)));
  await page.getByTestId('graphics-prepare').click();w=await wait(w=>w.tasks.some(t=>t.taskId==='T01'&&t.status==='awaiting_approval'));
  const task=w.tasks.find(t=>t.taskId==='T01'&&t.status==='awaiting_approval');assert.equal(task.settings.partId,'head');assert(task.inputVersionIds.includes(ids.head));assert(!task.inputVersionIds.includes('ef127317-c570-4723-9712-925c9c2373e6'));assert.equal(task.cost.provider,'Tripo API');assert.equal(task.cost.credits,20);
  Object.assign(r.materialPreparation,{taskId:task.id,requestHash:task.requestHash,cost:task.cost,inputVersionIds:task.inputVersionIds,accepted:ids,preparedAt:new Date().toISOString()});save();
 }
 const current=(await state()).graphicsWorkspaces,now=current.find(w=>w.projectId===r.projectId),before=r.materialPreparation.beforeWorkspaces.find(w=>w.projectId===r.projectId),task=now.tasks.find(t=>t.id===r.materialPreparation.taskId);assert.equal(task.status,'awaiting_approval');assert.equal(task.requestHash,r.materialPreparation.requestHash);assert.deepEqual(task.backendJobIds,[]);assert(!task.paidApproval);
 for(const prior of r.materialPreparation.beforeWorkspaces){for(const version of prior.versions)for(const file of version.files)assert.equal(hash(path.join(r.profile,'projects',prior.projectId,file.path)),file.sha256);if(prior.projectId!==r.projectId)assert.deepEqual(current.find(w=>w.projectId===prior.projectId),prior);}
 assert.deepEqual(now.versions,before.versions);assert.deepEqual(now.tripoBudget,before.tripoBudget);for(const old of before.tasks)assert.deepEqual(now.tasks.find(t=>t.id===old.id),old);
 for(const [key,id]of Object.entries(before.objects.find(o=>o.id===r.objectId).accepted))assert.equal(now.objects.find(o=>o.id===r.objectId).accepted[key],id);
 for(const [part,id]of Object.entries(ids))assert.equal(now.objects.find(o=>o.id===r.objectId).accepted['model:part-'+part],id);
 if(mode==='snapshot-close'){r.materialPreparation.restartBefore=current;save();await page.close();}
 else if(mode==='verify-restart'){assert.deepEqual(current,r.materialPreparation.restartBefore);r.materialPreparation.restartPreservedAt=new Date().toISOString();save();await open();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'3 재질',exact:true}).click();}
 if(mode!=='snapshot-close'){await page.getByTestId('graphics-approve-'+task.id).scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/runtime/graphics-human-head-uv-cost.png'});}
 Object.assign(r.materialPreparation,{lastCheckedAt:new Date().toISOString(),originalsPreserved:true,paidSubmissions:0,productionGptCalls:0});save();console.log(JSON.stringify({taskId:task.id,status:task.status,cost:task.cost,inputs:task.inputVersionIds,accepted:ids,originalsPreserved:true,paidSubmissions:0}));
}catch(error){r.materialPreparation??={};r.materialPreparation.lastError=String(error);save();throw error;}finally{await browser.close();}
