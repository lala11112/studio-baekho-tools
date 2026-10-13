// App-owned revision of the unaccepted repaired head. Never adopt or submit API work.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const evidence='artifacts/runtime/graphics-human-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8')),mode=process.argv[2];assert(['prepare','submit','inspect','review','snapshot-close','verify-restart'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2)),hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const port=fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0],browser=await chromium.connectOverCDP('http://127.0.0.1:'+port),page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(20000);
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async fn=>{for(let i=0;i<100;i++){const w=await workspace();if(fn(w))return w;await new Promise(resolve=>setTimeout(resolve,200));}throw Error('Inspect saved task before any further action');};
const openObject=async()=>{const open=page.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await open.isVisible())await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await open.click();await page.getByTestId('graphics-object-'+r.objectId).click();await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();};
try{
 let w=await workspace();assert(w);assert.equal(w.tripoBudget.limit,300);
 if(mode==='prepare'&&!r.headRevision?.taskId){
  assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));assert(!w.tasks.some(t=>t.taskId==='M05'),'Inspect existing M05 instead of preparing another');
  const source=w.versions.find(v=>v.id==='d0c33c27-eefa-4c6c-9190-28ae32bf0c26');assert.equal(source.slot,'part-head');
  const before=(await state()).graphicsWorkspaces,files=before.flatMap(w=>w.versions.flatMap(v=>v.files.map(f=>({path:path.join(r.profile,'projects',w.projectId,f.path),sha256:f.sha256}))));for(const f of files)assert.equal(hash(f.path),f.sha256);
  r.headRevision={sourceVersionId:source.id,beforeWorkspaces:before,protectedFiles:files,authorizedBy:'User requested both temple/neck transition smoothing and scalp/back-of-head shape correction, without adopting the previous result.',preparedAt:new Date().toISOString()};save();
  await openObject();await page.getByTestId('graphics-version-'+source.id).click();await page.getByRole('button',{name:'이 결과 더 보정',exact:true}).click();
  await page.getByLabel('이 단계 추가 지시 · 선택지에 없는 내용',{exact:true}).fill('선택한 미채택 머리 보정본에서 다음 두 가지를 모두 개선하세요. 1) 이마·관자놀이에서 추가한 두피로 이어지는 어두운 접합선과 각진 꺾임을 매끄럽게 하고 목 가장자리의 각짐을 완화하세요. 2) 두피·뒤통수의 높이·폭·곡률을 원래 캐릭터와 기존 머리카락 안쪽에 맞게 자연스럽게 다듬으세요. 과하게 둥근 공 모양이나 국소 융기·주름을 피하세요. 기존 얼굴 정체성(눈·코·입·귀와 얼굴 실루엣)과 목 아래 몸통 접합 위치는 최대한 유지하세요. 목 접합 구멍을 임의로 막지 마세요. 현재 528정점·579면의 연결·UV·재질·파트 ID와 오브젝트 변환은 유지하고, 정점 위치와 필요한 면 음영/법선만 조절하세요. 면 추가·삭제·재토폴로지·텍스처·리깅은 하지 마세요. 함께 전달된 몸통·헤어·전체 모델·원본 정면 이미지는 읽기 전용 참고이며 결과 장면에 섞지 마세요. 헤어와 겹쳐 본 상태 및 머리만의 전후 정면·측면·뒤·위 렌더를 비교하고, 접합선·목·헤어 침범 여부와 남은 결함을 기록하세요. 원본과 이전 보정본은 유지하고 새 머리 후보를 별도로 저장하세요.');
  await page.getByTestId('graphics-prepare').click();w=await wait(w=>w.tasks.some(t=>t.taskId==='M05'&&t.status==='awaiting_approval'));
  const task=w.tasks.find(t=>t.taskId==='M05'&&t.status==='awaiting_approval');assert.equal(task.settings.sourceVersionId,source.id);assert.equal(task.settings.editSourceMode,'candidate');assert.equal(task.settings.editSourceSlot,'part-head');assert.equal(task.settings.partId,'head');assert.equal(task.cost.provider,'Codex');assert.equal(task.cost.credits,null);
  assert(task.inputVersionIds.includes('fdf8e4f2-8dce-4f70-aa29-0d92b71b4364'));assert(task.inputVersionIds.includes('aa293092-5003-420f-838e-92cad836403a'));assert(!task.inputVersionIds.includes(r.repair.sourceVersionId));
  Object.assign(r.headRevision,{taskId:task.id,requestHash:task.requestHash,inputVersionIds:task.inputVersionIds,settings:task.settings});save();
 }
 const record=r.headRevision;if(record?.taskId){
  let task=(await workspace()).tasks.find(t=>t.id===record.taskId);assert.equal(task.requestHash,record.requestHash);
  if(mode==='submit'&&!record.clickedAt){assert.equal(task.status,'awaiting_approval');record.clickedAt=new Date().toISOString();save();await page.getByTestId('graphics-approve-'+task.id).click();await wait(w=>w.tasks.find(t=>t.id===record.taskId)?.status!=='awaiting_approval');}
  const current=(await state()).graphicsWorkspaces,now=current.find(w=>w.projectId===r.projectId),before=record.beforeWorkspaces.find(w=>w.projectId===r.projectId);task=now.tasks.find(t=>t.id===record.taskId);
  for(const f of record.protectedFiles)assert.equal(hash(f.path),f.sha256);assert.deepEqual(now.objects[0].accepted,before.objects[0].accepted);assert.deepEqual(now.versions.slice(0,before.versions.length),before.versions);assert.deepEqual(now.tripoBudget,before.tripoBudget);
  for(const old of before.tasks)assert.deepEqual(now.tasks.find(t=>t.id===old.id),old);for(const old of record.beforeWorkspaces)if(old.projectId!==r.projectId)assert.deepEqual(current.find(w=>w.projectId===old.projectId),old);
  Object.assign(record,{status:task.status,message:task.message,outputVersionIds:task.outputVersionIds,lastCheckedAt:new Date().toISOString()});save();
  if(['review','snapshot-close','verify-restart'].includes(mode)){
   assert.equal(task.status,'review',task.message);assert.equal(task.outputVersionIds.length,1);assert.deepEqual(task.backendJobIds,[]);assert(!task.paidApproval);const version=now.versions.find(v=>v.id===task.outputVersionIds[0]);assert.equal(version.slot,'part-head');assert.equal(version.role,'model');
   for(const ext of ['.blend','.fbx','.glb'])assert(version.files.some(f=>f.path.endsWith(ext)));for(const f of version.files)assert.equal(hash(path.join(r.profile,'projects',r.projectId,f.path)),f.sha256);
   const folder=path.join(r.profile,'projects',r.projectId,'graphics/jobs',task.id,'astra'),dispatch=JSON.parse(fs.readFileSync(path.join(folder,'dispatch.json'),'utf8'));assert.equal(dispatch.operation,'M05');assert.equal(dispatch.requestedModel,'gpt-6-astra');assert.equal(dispatch.automaticRetries,0);
   if(mode==='review'){
    if(!await page.getByTestId('graphics-version-'+version.id).isVisible())await openObject();await page.getByTestId('graphics-version-'+version.id).click();const viewport=page.getByTestId('graphics-preview');await viewport.locator('canvas').waitFor();await viewport.getByRole('button',{name:'단색 보기',exact:true}).click();await viewport.getByRole('button',{name:'측면',exact:true}).click();await viewport.scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/runtime/graphics-human-head-revision-app.png'});
    Object.assign(record,{reviewedAt:new Date().toISOString(),version,originalsPreserved:true,acceptanceUnchanged:true,productionGptDispatches:1,paidRequestsAdded:0});save();
   }else if(mode==='snapshot-close'){assert(!current.some(w=>w.tasks.some(t=>t.status==='running')));record.restartBefore=current;save();await page.close();}
   else{assert.deepEqual(current,record.restartBefore);record.restartPreservedAt=new Date().toISOString();save();}
  }
  console.log(JSON.stringify({taskId:task.id,status:task.status,message:task.message,inputs:task.inputVersionIds,outputs:task.outputVersionIds,originalsPreserved:true,acceptanceUnchanged:true}));
 }
}catch(error){r.headRevision??={};r.headRevision.lastError=String(error);save();throw error;}finally{await browser.close();}
