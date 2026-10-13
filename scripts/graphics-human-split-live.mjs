// User adopted this exact whole model and authorized one app-owned M07. Never replay.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const evidence='artifacts/runtime/graphics-human-live.json',r=JSON.parse(fs.readFileSync(evidence,'utf8'));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2));
const port=fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0];
const b=await chromium.connectOverCDP('http://127.0.0.1:'+port),p=b.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(p);p.setDefaultTimeout(20000);
const state=()=>p.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async(fn)=>{for(let i=0;i<100;i++){const w=await workspace();if(fn(w))return w;await new Promise(resolve=>setTimeout(resolve,200));}throw Error('App state timeout; inspect before retry');};
try{
  let w=await workspace();assert(w);assert.equal(w.tripoBudget.limit,300);assert.equal(w.tasks.filter(t=>t.paidApproval?.provider==='Tripo API').reduce((n,t)=>n+t.paidApproval.credits,0),100);
  assert.equal(w.tasks.find(t=>t.id===r.taskId).status,'review');
  if(!r.split){assert(!w.tasks.some(t=>t.taskId==='M07'),'Existing split must be inspected instead');r.split={sourceVersionId:r.outputVersionIds[0],authorizedAt:new Date().toISOString(),gptUsedBefore:38};save();}
  if(!r.split.taskId){
    assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));
    await p.getByTestId('graphics-version-'+r.split.sourceVersionId).click();
    if(w.objects[0].accepted['model:main']!==r.split.sourceVersionId){await p.getByTestId('graphics-accept-version').click();await wait(w=>w.objects[0].accepted['model:main']===r.split.sourceVersionId);}
    if(!w.objects[0].references.some(ref=>ref.versionId===r.sourceVersionId&&ref.role==='appearance')){
      await p.getByTestId('graphics-reference-version').selectOption(r.sourceVersionId);await p.getByLabel('참고 역할',{exact:true}).selectOption('appearance');await p.getByRole('button',{name:'참고 연결',exact:true}).click();await wait(w=>w.objects[0].references.some(ref=>ref.versionId===r.sourceVersionId));
    }
    await p.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();
    await p.getByRole('button',{name:'모델 파트 분리',exact:true}).click();
    await p.getByLabel('이 단계 추가 지시 · 선택지에 없는 내용',{exact:true}).fill('채택한 전체 인간형 모델을 원본 정면 이미지와 실제 메시 렌더를 함께 보며 머리·몸통·머리카락 세 파트로 분리하세요. 몸통에는 팔·손·손가락·다리·발·의상을 포함합니다. 머리에는 얼굴·귀·목 연결 영역을 포함하고, 머리카락에는 헤어만 포함합니다. 기존 모든 폴리곤을 정확히 한 번씩 배정하고 새 모델을 생성하거나 원본 좌표·UV·구조를 몰래 변경하지 마세요. 세 파트는 원래 조립 좌표를 그대로 공유합니다. 두피나 목 접합부에 면이 없거나 헤어/피부가 융합되어 있으면 숨기지 말고, 분리 결과와 누락·융합 구간을 가까이 렌더하여 보고하세요. 구멍을 자동으로 다 복원했다고 주장하지 마세요. 파트별 새 UV·텍스처와 리깅은 이번 요청에 포함하지 않습니다. 각각 편집 가능한 blend, FBX, GLB와 전체 및 파트별 검수 렌더를 보존하세요.');
    await p.getByTestId('graphics-prepare').click();
    w=await wait(w=>w.tasks.some(t=>t.taskId==='M07'&&t.status==='awaiting_approval'));
    const t=w.tasks.find(t=>t.taskId==='M07'&&t.status==='awaiting_approval');assert.equal(t.cost.provider,'Codex');assert.equal(t.cost.credits,null);assert(t.inputVersionIds.includes(r.sourceVersionId));assert(t.inputVersionIds.includes(r.split.sourceVersionId));assert.equal(t.settings.partId,undefined);
    Object.assign(r.split,{taskId:t.id,requestHash:t.requestHash,inputVersionIds:t.inputVersionIds,preparedAt:new Date().toISOString()});save();
  }
  const task=(await workspace()).tasks.find(t=>t.id===r.split.taskId);assert.equal(task.requestHash,r.split.requestHash);
  if(!r.split.approvalAttemptAt){assert.equal(task.status,'awaiting_approval');r.split.approvalAttemptAt=new Date().toISOString();save();await p.getByTestId('graphics-approve-'+task.id).click();await wait(w=>w.tasks.find(t=>t.id===task.id).status!=='awaiting_approval');}
  const final=(await workspace()).tasks.find(t=>t.id===r.split.taskId);Object.assign(r.split,{status:final.status,message:final.message});save();console.log(JSON.stringify(r.split));
}catch(error){r.split??={};r.split.lastError=String(error);save();throw error;}finally{await b.close();}
