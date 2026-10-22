// Read/preview the exact approved result; never produces or adopts.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const profile=path.join(process.env.APPDATA,'partsmith'),projectId='5844e13a-7892-422b-ac3f-410fe4f59231';
const taskId='33f0b5c3-7fbe-4d6c-87c1-386b87770b97',resultId='52ab0f85-cabf-4c9a-af4d-785e63b7d350';
const sourceId='eefacd21-954b-49b4-970e-f1e79e682a89',imageId='a66e8746-46fd-440a-b5f5-05bd1e255e87';
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const baseline=JSON.parse(fs.readFileSync('artifacts/runtime/graphics-independent-head-texture-prepare.json','utf8'));
const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('index.html'));assert(page);
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));
try {
 const before=await page.evaluate(()=>window.desktop.call({type:'state'}));
 const space=before.graphicsWorkspaces.find(w=>w.projectId===projectId),task=space.tasks.find(t=>t.id===taskId);
 assert.equal(task.status,'review');assert.deepEqual(task.inputVersionIds,[sourceId,imageId]);assert.equal(task.paidApproval.credits,20);
 const project=before.projects.find(p=>p.id===projectId),jobs=project.jobs.filter(j=>task.backendJobIds.includes(j.id));
 assert.equal(jobs.length,1);assert.equal(jobs[0].status,'success');assert.equal(jobs[0].request.textureQuality,'detailed');
 assert.equal(jobs[0].request.sourceId,'graphics-'+sourceId);assert.deepEqual(jobs[0].request.sourceIds,['graphics-'+imageId]);
 const object=space.objects.find(o=>o.id===task.objectId);assert.equal(object.accepted['model:part-head'],sourceId);
 assert(!Object.values(object.accepted).includes(resultId));
 for(const old of baseline.beforeWorkspaces){const now=before.graphicsWorkspaces.find(w=>w.projectId===old.projectId);
   if(old.projectId!==projectId){assert.deepEqual(now,old);continue;}
   for(const v of old.versions)assert.deepEqual(now.versions.find(x=>x.id===v.id),v);
   for(const t of old.tasks)assert.deepEqual(now.tasks.find(x=>x.id===t.id),t);
   assert.deepEqual(now.deliveries,old.deliveries);assert.deepEqual(now.tripoBudget,old.tripoBudget);
   assert.deepEqual(now.tasks.filter(t=>!old.tasks.some(x=>x.id===t.id)).map(t=>t.id),[taskId]);
   assert.deepEqual(now.versions.filter(v=>!old.versions.some(x=>x.id===v.id)).map(v=>v.id).sort(),[...task.outputVersionIds].sort());
   for(const o of old.objects)assert.deepEqual(now.objects.find(x=>x.id===o.id).accepted,o.id===object.id?{...o.accepted,'model:part-head':sourceId}:o.accepted);
 }
 for(const f of baseline.protectedFiles)assert.equal(hash(f.path),f.sha256);
 const newFiles=[];for(const id of task.outputVersionIds)for(const f of space.versions.find(v=>v.id===id).files){
   const absolute=path.join(profile,'projects',projectId,f.path);assert.equal(hash(absolute),f.sha256);newFiles.push({path:absolute,sha256:f.sha256});}
 const projectFiles=before.projects.map(p=>{const file=path.join(profile,'projects',p.id,'project.json');return{path:file,sha256:hash(file)};});
 await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'3 재질',exact:true}).click();
 await page.getByTestId('graphics-current-task-'+taskId).getByRole('button',{name:'완료 · 결과 보기',exact:true}).click();
 assert.equal(await page.getByTestId('graphics-version-'+resultId).getAttribute('aria-pressed'),'true');
 await page.locator('.viewport').getByText(/메시·부품 검사 · 1개 · 10,314 삼각형/).waitFor();
 const preview=page.getByTestId('graphics-preview');await preview.scrollIntoViewIfNeeded();
 for(const [name,suffix]of[['+Z 방향','z'],['+X 방향','x'],['−Z 방향','back']]){
   await preview.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(250);
   await preview.screenshot({path:'artifacts/runtime/graphics-independent-head-texture-'+suffix+'.png'});
 }
 await preview.getByRole('button',{name:'+X 방향',exact:true}).click();
 const after=await page.evaluate(()=>window.desktop.call({type:'state'}));assert.deepEqual(after.graphicsWorkspaces,before.graphicsWorkspaces);assert.deepEqual(errors,[]);
 const report={checkedAt:new Date().toISOString(),projectId,taskId,resultId,inputVersionIds:task.inputVersionIds,backendJobIds:task.backendJobIds,
   remoteId:jobs[0].remoteId,credits:jobs[0].credits,paidApproval:task.paidApproval,request:jobs[0].request,task,newFiles,projectFiles,
   protectedFileCount:baseline.protectedFiles.length,allOriginalsPreserved:true,otherAcceptanceUnchanged:true,resultUnaccepted:true,errors,
   workspaces:before.graphicsWorkspaces,recordedBudgetUsed:280,recordedBudgetRemaining:20};
 fs.writeFileSync('artifacts/runtime/graphics-independent-head-texture-result-live.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:task.status,resultId,remoteId:jobs[0].remoteId,credits:jobs[0].credits,newFiles:newFiles.length,protectedFiles:baseline.protectedFiles.length,errors}));
}finally{await browser.close();}
