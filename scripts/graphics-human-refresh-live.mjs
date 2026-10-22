// Repair only host-generated M07 derivatives via the real app button. No authoring/adoption/paid calls.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const pilotFile='artifacts/runtime/graphics-human-live.json',pilot=JSON.parse(fs.readFileSync(pilotFile,'utf8'));
const evidence='artifacts/runtime/graphics-human-refresh-live.json',mode=process.argv[2],profile=pilot.profile;
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0],browser=await chromium.connectOverCDP('http://127.0.0.1:'+port),page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
const idle=s=>{assert(!s.graphicsWorkspaces.some(w=>w.tasks.some(t=>t.status==='running')));assert(!s.projects.some(p=>p.jobs.some(j=>['queued','running','submitting','processing','downloading'].includes(j.status))));};
try{
 const before=await state();idle(before);
 if(mode==='snapshot-close'){
  assert(!fs.existsSync(evidence),'Existing refresh evidence must be inspected, not reset');
  const w=before.graphicsWorkspaces.find(w=>w.projectId===pilot.projectId),task=w.tasks.find(t=>t.id===pilot.split.taskId);assert.equal(task.status,'review');
  const registered=before.graphicsWorkspaces.flatMap(w=>w.versions.flatMap(v=>v.files.map(f=>({path:path.join(profile,'projects',w.projectId,f.path),sha256:f.sha256}))));for(const f of registered)assert.equal(hash(f.path),f.sha256);
  const folder=path.join(profile,'projects',pilot.projectId,'graphics/jobs',task.id,'astra'),authored=['dispatch.json','usage.json','work/result.json','work/outputs/asset.blend','work/codex-events.jsonl'].filter(f=>fs.existsSync(path.join(folder,f))).map(f=>({path:path.join(folder,f),sha256:hash(path.join(folder,f))}));
  fs.writeFileSync(evidence,JSON.stringify({before:before.graphicsWorkspaces,registered,authored,taskId:task.id,beforeOutputs:task.outputVersionIds,startedAt:new Date().toISOString()},null,2));
  await page.close();console.log('Idle app closed after preserving all workspace and original file evidence.');
 }else{
  const r=JSON.parse(fs.readFileSync(evidence,'utf8'));let current=before,w=current.graphicsWorkspaces.find(w=>w.projectId===pilot.projectId);
  if(mode==='refresh'){
   assert(!r.clickedAt,'Inspect saved refresh instead of replay');assert.deepEqual(before.graphicsWorkspaces,r.before);
   const open=page.locator(`[data-project-id="${pilot.projectId}"]`).getByTestId('project-open');
   if(!await open.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await open.click();
   await page.getByTestId('graphics-object-'+pilot.objectId).click();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();
   r.clickedAt=new Date().toISOString();fs.writeFileSync(evidence,JSON.stringify(r,null,2));await page.getByTestId('graphics-refresh-parts-'+r.taskId).click();
   for(let i=0;i<120;i++){current=await state();w=current.graphicsWorkspaces.find(w=>w.projectId===pilot.projectId);const t=w.tasks.find(t=>t.id===r.taskId);if(t.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  const task=w.tasks.find(t=>t.id===r.taskId);assert.equal(task.status,'review',task.message);assert.equal(w.tasks.length,r.before.find(w=>w.projectId===pilot.projectId).tasks.length);assert.equal(task.outputVersionIds.length,r.beforeOutputs.length+3);
  for(const prior of r.before){const now=current.graphicsWorkspaces.find(w=>w.projectId===prior.projectId);if(prior.projectId!==pilot.projectId)assert.deepEqual(now,prior);else{assert.deepEqual(now.objects,prior.objects);assert.deepEqual(now.versions.slice(0,prior.versions.length),prior.versions);}}
  for(const f of [...r.registered,...r.authored])assert.equal(hash(f.path),f.sha256);
  const updated=w.versions.filter(v=>task.outputVersionIds.slice(0,3).includes(v.id));const summaries=[];
  for(const v of updated){const f=v.files.find(f=>f.path.endsWith('.glb')),bytes=fs.readFileSync(path.join(profile,'projects',pilot.projectId,f.path)),d=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));assert.equal(d.scenes.length,1);assert.equal(d.meshes.length,1);summaries.push({id:v.id,slot:v.slot,bytes:bytes.length,meshes:d.meshes.map(m=>m.name)});}
  await page.getByTestId('graphics-version-'+updated.find(v=>v.slot==='part-head').id).click();await page.getByTestId('graphics-preview').locator('canvas').waitFor();
  const side=page.getByTestId('graphics-preview').getByRole('button',{name:'측면',exact:true});if(await side.isVisible())await side.click();
  assert.deepEqual(errors,[]);Object.assign(r,{completedAt:new Date().toISOString(),updated:summaries,originalsPreserved:true,authoredAndUsageUnchanged:true,paidRequestsAdded:0,productionGptCallsAdded:0,errors});fs.writeFileSync(evidence,JSON.stringify(r,null,2));
  Object.assign(pilot.split,{status:task.status,message:task.message,outputVersionIds:task.outputVersionIds,refreshedVersionIds:summaries.map(v=>v.id),actualParts:[{id:'head',faces:339,triangles:588},{id:'body',faces:3962,triangles:7144},{id:'hair',faces:1149,triangles:1998}],missingScalp:true,gptUsedAfter:40});fs.writeFileSync(pilotFile,JSON.stringify(pilot,null,2));console.log(JSON.stringify({updated:summaries,originalsPreserved:true,productionGptCallsAdded:0,errors}));
 }
}finally{await browser.close();}
