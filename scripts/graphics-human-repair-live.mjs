// One app-owned repair of the saved head candidate. Never adopt, replay, or submit paid work.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import {chromium}from'playwright';
const evidence='artifacts/runtime/graphics-human-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8')),mode=process.argv[2];assert(['prepare','submit','inspect','review','snapshot-close','verify-restart','close-for-recovery','recover'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2)),hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const port=fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0],browser=await chromium.connectOverCDP('http://127.0.0.1:'+port),page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(20000);
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async(fn)=>{for(let i=0;i<100;i++){const w=await workspace();if(fn(w))return w;await new Promise(resolve=>setTimeout(resolve,200));}throw Error('Inspect saved app state before retrying');};
try{
 let w=await workspace();assert(w);assert.equal(w.tripoBudget.limit,300);
 if(mode==='prepare'&&!r.repair?.taskId){
  assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));assert(!w.tasks.some(t=>t.taskId==='M09'),'Existing M09 must be inspected');
  const source=w.versions.find(v=>v.id==='78deffe8-4c33-4339-87e0-8693e4091aa0');assert.equal(source.slot,'part-head');
  const all=(await state()).graphicsWorkspaces,protectedFiles=all.flatMap(w=>w.versions.flatMap(v=>v.files.map(f=>({path:path.join(r.profile,'projects',w.projectId,f.path),sha256:f.sha256}))));for(const f of protectedFiles)assert.equal(hash(f.path),f.sha256);
  r.repair={sourceVersionId:source.id,protectedFiles,beforeWorkspaces:all,authorizedBy:'User resumed saved missing-surface repair workflow on 2026-10-14; no adoption or paid submission.',preparedAt:new Date().toISOString()};save();
  const open=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await open.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await open.click();
  await page.getByTestId('graphics-object-'+r.objectId).click();await page.getByTestId('graphics-version-'+source.id).click();
  await page.getByRole('button',{name:'이 파트 빠진 면 보완',exact:true}).click();
  await page.getByLabel('이 단계 추가 지시 · 선택지에 없는 내용',{exact:true}).fill('분리된 머리 파츠의 빠진 두피·뒤통수 면을 자연스럽게 보완하세요. 기존 얼굴·코·입·귀·목의 모든 정점·면·UV와 원래 위치를 그대로 보존하고, 선택한 머리 메시의 원래 열린 경계에만 새 면을 추가하세요. 같이 전달된 전체 모델·머리카락·몸통과 원본 정면 이미지는 읽기 전용 외형 참고입니다. 두피는 기존 헤어 안쪽에 자연스럽게 맞추되 헤어를 침범하거나 기존 얼굴을 가리지 마세요. 목과 몸통의 맞닿는 기존 경계는 유지하며 의도된 목 아래 연결 구멍을 임의로 막지 마세요. 원래 헤어/몸통/눈/코/입을 다시 만들거나 텍스처·리깅을 실행하지 마세요. 전후 정면·측면·후면과 헤어를 가정한 두피 위치를 가까이 확인하고, 남은 틈·각짐·관통 가능성은 솔직하게 기록하세요. 원본은 덮어쓰지 않고 새 머리 후보를 만들며, 최종 채택은 사용자가 합니다.');
  await page.getByTestId('graphics-prepare').click();w=await wait(w=>w.tasks.some(t=>t.taskId==='M09'&&t.status==='awaiting_approval'));
  const t=w.tasks.find(t=>t.taskId==='M09'&&t.status==='awaiting_approval');assert.equal(t.settings.sourceVersionId,source.id);assert.equal(t.settings.partId,'head');assert.equal(t.cost.provider,'Codex');assert.equal(t.cost.credits,null);assert.deepEqual(w.objects[0].accepted,r.repair.beforeWorkspaces.find(w=>w.projectId===r.projectId).objects[0].accepted);
  assert(t.inputVersionIds.includes('fdf8e4f2-8dce-4f70-aa29-0d92b71b4364'));assert(t.inputVersionIds.includes('aa293092-5003-420f-838e-92cad836403a'));
  Object.assign(r.repair,{taskId:t.id,requestHash:t.requestHash,inputVersionIds:t.inputVersionIds,settings:t.settings});save();
 }
 if(r.repair?.taskId){const t=(await workspace()).tasks.find(t=>t.id===r.repair.taskId);assert.equal(t.requestHash,r.repair.requestHash);
  if(mode==='submit'&&!r.repair.clickedAt){assert.equal(t.status,'awaiting_approval');r.repair.clickedAt=new Date().toISOString();save();await page.getByTestId('graphics-approve-'+t.id).click();await wait(w=>w.tasks.find(task=>task.id===r.repair.taskId)?.status!=='awaiting_approval');}
  if(mode==='recover'){
   assert.equal(t.status,'failed');assert(!r.repair.recoveryClickedAt,'Inspect existing recovery before another click');assert.deepEqual((await state()).graphicsWorkspaces,r.repair.recoveryBefore);
   for(const f of r.repair.recoveryOriginals)assert.equal(hash(f.path),f.sha256);
   if(!await page.getByTestId('graphics-recover-'+t.id).isVisible()){
    const open=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await open.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await open.click();
    await page.getByTestId('graphics-object-'+r.objectId).click();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();
   }
   r.repair.recoveryClickedAt=new Date().toISOString();save();await page.getByTestId('graphics-recover-'+t.id).click();await wait(w=>w.tasks.find(task=>task.id===r.repair.taskId)?.status!=='failed');
  }
  const updated=(await workspace()).tasks.find(t=>t.id===r.repair.taskId);Object.assign(r.repair,{status:updated.status,message:updated.message,outputVersionIds:updated.outputVersionIds,lastCheckedAt:new Date().toISOString()});save();
  for(const f of r.repair.protectedFiles)assert.equal(hash(f.path),f.sha256);console.log(JSON.stringify({taskId:updated.id,status:updated.status,message:updated.message,inputs:updated.inputVersionIds,outputs:updated.outputVersionIds,paidCalls:0}));
  if(mode==='close-for-recovery'){
   assert.equal(updated.status,'failed');assert.equal(updated.outputVersionIds.length,0);const current=(await state()).graphicsWorkspaces;assert(!current.some(w=>w.tasks.some(t=>t.status==='running')));
   const folder=path.join(r.profile,'projects',r.projectId,'graphics/jobs',t.id,'astra');r.repair.recoveryBefore=current;r.repair.initialValidationFailure=updated.message;
   r.repair.recoveryOriginals=['dispatch.json','prepared.json','baseline.json','usage.json','work/source.blend','work/outputs/asset.blend','work/result.json','work/codex-events.jsonl'].map(p=>({path:path.join(folder,p),sha256:hash(path.join(folder,p))}));save();await page.close();
  }
  if(['review','snapshot-close','verify-restart'].includes(mode)){
   const current=(await state()).graphicsWorkspaces,now=current.find(w=>w.projectId===r.projectId),prior=r.repair.beforeWorkspaces.find(w=>w.projectId===r.projectId);
   assert.equal(updated.status,'review',updated.message);assert.equal(updated.outputVersionIds.length,1);assert.equal(now.tasks.length,prior.tasks.length+1);
   assert.deepEqual(updated.backendJobIds,[]);assert(!updated.paidApproval);assert.deepEqual(now.objects[0].accepted,prior.objects[0].accepted);assert.deepEqual(now.versions.slice(0,prior.versions.length),prior.versions);assert.deepEqual(now.tripoBudget,prior.tripoBudget);
   for(const previous of r.repair.beforeWorkspaces){if(previous.projectId!==r.projectId)assert.deepEqual(current.find(w=>w.projectId===previous.projectId),previous);}
   for(const task of prior.tasks)assert.deepEqual(now.tasks.find(t=>t.id===task.id),task);
   const version=now.versions.find(v=>v.id===updated.outputVersionIds[0]);assert.equal(version.role,'model');assert.equal(version.slot,'part-head');assert.equal(version.provenance.jobId,updated.id);
   for(const extension of ['.blend','.fbx','.glb'])assert(version.files.some(f=>f.path.endsWith(extension)),extension);
   for(const file of version.files)assert.equal(hash(path.join(r.profile,'projects',r.projectId,file.path)),file.sha256);
   for(const f of r.repair.recoveryOriginals??[])assert.equal(hash(f.path),f.sha256);
   const folder=path.join(r.profile,'projects',r.projectId,'graphics/jobs',updated.id,'astra'),dispatch=JSON.parse(fs.readFileSync(path.join(folder,'dispatch.json'),'utf8'));assert.equal(dispatch.operation,'M09');assert.equal(dispatch.requestedModel,'gpt-6-astra');assert.equal(dispatch.automaticRetries,0);
   if(mode==='review'){
    if(!await page.getByTestId('graphics-version-'+version.id).isVisible()){
     const open=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await open.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await open.click();
     await page.getByTestId('graphics-object-'+r.objectId).click();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();
    }
    await page.getByTestId('graphics-version-'+version.id).click();await page.getByTestId('graphics-preview').locator('canvas').waitFor();
    await page.getByTestId('graphics-preview').getByRole('button',{name:'단색 보기',exact:true}).click();
    const side=page.getByTestId('graphics-preview').getByRole('button',{name:'측면',exact:true});if(await side.isVisible())await side.click();
    const workflow=await page.getByRole('region',{name:'인간형 파트 제작 순서',exact:true}).evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));assert.equal(workflow.background,'rgb(32, 44, 41)');r.repair.workflowContrast=workflow;
    await page.getByTestId('graphics-preview').scrollIntoViewIfNeeded();
    await page.screenshot({path:'artifacts/runtime/graphics-human-repair-app.png'});
    Object.assign(r.repair,{reviewedAt:new Date().toISOString(),version,originalsPreserved:true,acceptanceUnchanged:true,paidRequestsAdded:0,productionGptDispatches:1,usage:JSON.parse(fs.readFileSync(path.join(folder,'usage.json'),'utf8'))});save();
   }else if(mode==='snapshot-close'){
    assert(!current.some(w=>w.tasks.some(t=>t.status==='running')));r.repair.restartBefore=current;save();await page.close();
   }else{
    assert.deepEqual(current,r.repair.restartBefore);r.repair.restartPreservedAt=new Date().toISOString();save();
   }
   console.log(JSON.stringify({version:version.id,slot:version.slot,originalsPreserved:true,acceptanceUnchanged:true,paidRequestsAdded:0,mode}));
  }
 }
}catch(error){r.repair??={};r.repair.lastError=String(error);save();throw error;}finally{await browser.close();}
