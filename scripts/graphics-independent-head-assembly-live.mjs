// Explicit app buttons only. Reuses the existing head/body/hair; never calls a provider.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const evidence='artifacts/runtime/graphics-independent-head-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8')),mode=process.argv[2];
assert(['adopt','prepare','execute','inspect','review'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2));
const b=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const p=b.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(p);p.setDefaultTimeout(15000);
const state=()=>p.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async predicate=>{for(let i=0;i<100;i++){const w=await workspace();if(predicate(w))return w;await new Promise(resolve=>setTimeout(resolve,150));}throw Error('Inspect saved state; do not blindly repeat');};
const select=async name=>{const button=p.getByRole('button',{name,exact:true});if(await button.getAttribute('aria-pressed')!=='true')await button.click();};
const stage=async name=>p.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name,exact:true}).click();
try{
 let w=await workspace();assert(w);const head=r.preparedHead.id;
 if(mode==='adopt'){
  assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));
  const o=w.objects.find(o=>o.id===r.objectId);assert(['ce10dcc9-125d-4760-8f44-88162e29899c',head].includes(o.accepted['model:part-head']));
  if(o.accepted['model:part-head']!==head){await stage('2 모델');await p.getByTestId('graphics-version-'+head).click();await p.getByTestId('graphics-accept-preview').click();}
  w=await wait(ws=>ws.objects.find(o=>o.id===r.objectId).accepted['model:part-head']===head);r.headShapeAdoptedAt=new Date().toISOString();save();await stage('4 조립·수정');console.log((await p.getByTestId('graphics-creation-options').innerText()).slice(0,6000));
 }
 if(mode==='prepare'){
  assert(!r.assemblyTaskId,'Already prepared; inspect the same task');assert.equal(w.objects.find(o=>o.id===r.objectId).accepted['model:part-head'],head);
  assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));r.assemblyBefore=(await state()).graphicsWorkspaces;save();
  await stage('4 조립·수정');await select('채택 파트 조립');await select('비율·위치 맞추기 · Astra');
  await p.getByLabel('이 단계 추가 지시 · 선택지에 없는 내용').fill('사용자가 채택한 새 머리 단독 모델을 기존 몸통·머리카락에 임시 조립합니다. 기존 몸통과 머리카락의 원본 메시 및 세계 위치·회전·크기는 그대로 고정하세요. 새 머리의 오브젝트 위치·회전과 균등 크기만 조절해 원본 캐릭터 비율과 머리카락 안의 얼굴 위치를 맞추세요. 정점·면·UV·재질·파트 식별자는 변경하지 않습니다. 목과 몸통의 연결, 앞머리·옆머리와 얼굴·귀·두피의 관통을 정면·측면·후면으로 검토하세요. 서로 맞추기 어려운 형상 차이는 숨기거나 머리를 변형하지 말고 남은 문제를 보고하세요. 접합 보정·재생성·리깅·애니메이션·텍스처는 하지 않습니다. 조립 전체와 각 파트의 최종 배치는 앱이 별도 후보로 보존하며 사용자 검토 전 자동 채택하지 않습니다.');
  await p.getByRole('button',{name:'옵션 저장',exact:true}).click();await wait(ws=>ws.objects.find(o=>o.id===r.objectId).creation.stageSettings.assembly.values.assemblyMode==='assemble');
  await p.getByTestId('graphics-prepare').click();w=await wait(ws=>ws.tasks.some(t=>t.taskId==='M08'&&t.status==='awaiting_approval'));
  const t=w.tasks.find(t=>t.taskId==='M08'&&t.status==='awaiting_approval');assert.equal(t.settings.assemblyPlacement??'fit','fit');assert.equal(t.settings.partId,undefined);assert.equal(t.cost.provider,'Codex');assert.equal(t.cost.credits,null);
  assert.deepEqual(t.inputVersionIds,[head,'fdf8e4f2-8dce-4f70-aa29-0d92b71b4364','aa293092-5003-420f-838e-92cad836403a','4cc99cd0-1611-4afb-92d6-df77a937e4b7']);
  r.assemblyTaskId=t.id;r.assemblyRequest={hash:t.requestHash,inputs:t.inputVersionIds,settings:t.settings,instruction:t.instruction,cost:t.cost};save();
 }
 if(mode==='execute'){
  const t=w.tasks.find(t=>t.id===r.assemblyTaskId);assert.equal(t?.status,'awaiting_approval');assert.equal(t.requestHash,r.assemblyRequest.hash);assert.equal(t.cost.provider,'Codex');assert.equal(t.cost.credits,null);assert(!t.backendJobIds.length);
  await p.getByTestId('graphics-approve-'+t.id).click();w=await wait(ws=>ws.tasks.find(t=>t.id===r.assemblyTaskId).status!=='awaiting_approval');r.assemblyExecutedAt=new Date().toISOString();save();
 }
 if(mode==='review'){
  const t=w.tasks.find(t=>t.id===r.assemblyTaskId);assert.equal(t.status,'review');const results=t.outputVersionIds.map(id=>w.versions.find(v=>v.id===id));assert(results.some(v=>v.slot==='main'));assert.equal(results.length,4);
  for(const f of r.upgradeFiles)assert.equal(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'),f.sha256);
  const before=r.assemblyBefore.find(w=>w.projectId===r.projectId);for(const v of before.versions)assert.deepEqual(w.versions.find(x=>x.id===v.id),v);
  assert.deepEqual(w.objects.find(o=>o.id===r.objectId).accepted,before.objects.find(o=>o.id===r.objectId).accepted);
  await stage('4 조립·수정');await p.getByTestId('graphics-version-'+results.find(v=>v.slot==='main').id).click();
  r.assemblyResults=results;r.assemblyReviewedAt=new Date().toISOString();save();
 }
 const t=w.tasks.find(t=>t.id===r.assemblyTaskId);console.log(JSON.stringify({accepted:w.objects.find(o=>o.id===r.objectId).accepted,task:t?{id:t.id,status:t.status,message:t.message,cost:t.cost,outputs:t.outputVersionIds}:null}));
}finally{await b.close();}
