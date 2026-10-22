// App-button-only independent-head validation. Every stage is explicit; no service calls here.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const prior=JSON.parse(fs.readFileSync('artifacts/runtime/graphics-human-live.json','utf8'));
const evidence='artifacts/runtime/graphics-independent-head-live.json';
const r=fs.existsSync(evidence)?JSON.parse(fs.readFileSync(evidence,'utf8')):{profile:prior.profile,projectId:prior.projectId,objectId:prior.objectId};
const mode=process.argv[2]??'inspect';
assert(['prepare-images','execute-images','prepare-model','inspect'].includes(mode));
const save=()=>fs.writeFileSync(evidence,JSON.stringify(r,null,2));
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);page.setDefaultTimeout(15000);
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
const workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const wait=async predicate=>{for(let i=0;i<100;i++){const w=await workspace();if(predicate(w))return w;await new Promise(resolve=>setTimeout(resolve,150));}throw Error('Inspect existing state before retry; no blind execution');};
const select=async(name,scope=page)=>{const b=scope.getByRole('button',{name,exact:true});if(await b.getAttribute('aria-pressed')!=='true')await b.click();};
const stage=async name=>page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name,exact:true}).click();
try{
 let w=await workspace();assert(w);
 if(mode==='prepare-images'){
  assert(!r.imageTaskId,'Already prepared; inspect same task');
  assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));
  r.beforeWorkspaces=(await state()).graphicsWorkspaces;r.startedAt=new Date().toISOString();
  r.preservedFiles=r.beforeWorkspaces.flatMap(ws=>ws.versions.flatMap(v=>v.files.map(f=>({path:path.join(r.profile,'projects',ws.projectId,f.path),sha256:f.sha256}))));
  for(const file of r.preservedFiles)assert.equal(hash(file.path),file.sha256);save();
  const o=w.objects.find(o=>o.id===r.objectId);assert.equal(o.accepted['design:main'],'4cc99cd0-1611-4afb-92d6-df77a937e4b7');
  await stage('1 이미지');
  await select('파트별 독립 제작');await select('파트별 이미지');
  const options=page.getByTestId('graphics-creation-options');
  const head=options.locator('.gs-part').filter({has:page.getByRole('checkbox',{name:'머리',exact:true})});
  await head.getByRole('button',{name:/현재 파트|이 파트 설정/}).click();
  await head.locator('textarea').fill('기존 캐릭터의 머리 단독. 얼굴·양쪽 귀·전체 두피·뒤통수 볼륨·목 연결부를 포함하고 머리카락·몸통·어깨·옷·목걸이는 제외합니다. 머리카락을 나중에 별도로 씌울 수 있는 완전한 민머리 형태로 만듭니다.');
  if(!await options.getByRole('button',{name:'지정 부위',exact:true}).isVisible())await options.getByText('세부 외형 · 구도 옵션',{exact:true}).click();
  for(const name of ['정면','지정 부위','기본 자세','단색','모델링 참고용','전체가 보이도록'])await select(name,options);
  await page.getByLabel('이 단계 추가 지시 · 선택지에 없는 내용').fill('채택한 전체 캐릭터 원본은 얼굴 인상·눈 모양·붉은 눈동자·피부색·애니풍의 참고로만 사용하세요. 동일 캐릭터의 머리만 따로 제작하기 위한 정면 독립 원본 후보 2장을 만듭니다. 얼굴·양쪽 귀·닫힌 두피 전체·뒤통수의 자연스러운 볼륨·짧은 목 연결부를 포함합니다. 헤어·몸통·어깨·의상·목걸이·장비는 생성하지 마세요. 완전한 정면, 좌우 균형, 중립 표정, 단색 밝은 배경, 원근 왜곡 최소화, 머리 꼭대기·귀·목 끝이 잘리지 않는 충분한 여백. 원본의 얼굴 인상은 유지하며 후보 두 장은 각각 별도의 원본으로 만드세요. 시트나 잘라낸 원본으로 대체하지 마세요. 정면에서 가려진 뒤통수·두피는 해석한 디자인이며 이미 검증된 멀티뷰처럼 표현하지 마세요.');
  await page.getByRole('button',{name:'옵션 저장',exact:true}).click();
  await wait(ws=>ws.objects.find(o=>o.id===r.objectId).creation.stageSettings.design.values.designMode==='parts');
  await stage('2 모델');
  await page.getByTestId('model-face-count').fill('5000');
  await select('쿼드');
  await page.getByRole('button',{name:'옵션 저장',exact:true}).click();
  w=await wait(ws=>ws.objects.find(o=>o.id===r.objectId).creation.parts.find(p=>p.id==='head').faceLimit===5000);
  const after=w.objects.find(o=>o.id===r.objectId);assert.deepEqual(after.accepted,o.accepted);
  for(const id of ['body','hair'])assert.deepEqual(after.creation.parts.find(p=>p.id===id),o.creation.parts.find(p=>p.id===id));
  assert.deepEqual(after.creation.stageSettings.model,o.creation.stageSettings.model);
  await stage('1 이미지');await page.getByTestId('graphics-prepare').click();
  w=await wait(ws=>ws.tasks.some(t=>t.taskId==='I08'&&!r.beforeWorkspaces.find(w=>w.projectId===r.projectId).tasks.some(old=>old.id===t.id)));
  const task=w.tasks.find(t=>t.taskId==='I08'&&!r.beforeWorkspaces.find(w=>w.projectId===r.projectId).tasks.some(old=>old.id===t.id));
  assert.equal(task.status,'awaiting_approval');assert.equal(task.settings.partId,'head');assert.equal(task.settings.count,2);assert.deepEqual(task.inputVersionIds,[o.accepted['design:main']]);assert.equal(task.cost.provider,'Codex');assert.equal(task.cost.credits,null);
  r.imageTaskId=task.id;r.imageRequest={hash:task.requestHash,settings:task.settings,inputs:task.inputVersionIds,cost:task.cost};save();
 }
 if(mode==='execute-images'){
  assert(r.imageTaskId);const task=w.tasks.find(t=>t.id===r.imageTaskId);assert.equal(task.status,'awaiting_approval');assert.equal(task.taskId,'I08');assert.equal(task.cost.provider,'Codex');assert.equal(task.cost.credits,null);assert.equal(task.requestHash,r.imageRequest.hash);assert(!task.backendJobIds.length);
  await page.getByTestId('graphics-approve-'+task.id).click();
  w=await wait(ws=>ws.tasks.find(t=>t.id===task.id).status!=='awaiting_approval');r.imageExecutedAt=new Date().toISOString();save();
 }
 if(mode==='prepare-model'){
  assert(!r.modelTaskId,'Already prepared; inspect same task');assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));
  const o=w.objects.find(o=>o.id===r.objectId),imageId='a66e8746-46fd-440a-b5f5-05bd1e255e87';assert.equal(o.accepted['design:part-head'],imageId,'User must adopt exact selected head image in app first');
  r.imageAdoptedAt=new Date().toISOString();r.adoptedHeadImageId=imageId;save();
  await stage('2 모델');assert.equal(await page.getByTestId('model-face-count').inputValue(),'5000');assert.equal(await page.getByRole('button',{name:'쿼드',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByTestId('graphics-prepare').click();w=await wait(ws=>ws.tasks.some(t=>t.taskId==='M01'&&t.status==='awaiting_approval'));
  const task=w.tasks.find(t=>t.taskId==='M01'&&t.status==='awaiting_approval');assert.deepEqual(task.inputVersionIds,[imageId]);assert.equal(task.settings.partId,'head');assert.equal(task.settings.count,1);assert.equal(task.settings.faceLimit,5000);assert.equal(task.settings.quad,true);assert.equal(task.settings.model,'P2-20260801');assert.equal(task.cost.credits,100);assert(!task.paidApproval);assert.equal(task.backendJobIds.length,0);
  r.modelTaskId=task.id;r.modelRequest={hash:task.requestHash,cost:task.cost,inputs:task.inputVersionIds,settings:task.settings};save();await page.getByTestId('graphics-approve-'+task.id).scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/runtime/graphics-independent-head-model-cost.png'});
 }
 const task=w.tasks.find(t=>t.id===(mode==='prepare-model'?r.modelTaskId:r.imageTaskId));
 if(r.preservedFiles)for(const file of r.preservedFiles)assert.equal(hash(file.path),file.sha256);
 const imageTask=w.tasks.find(t=>t.id===r.imageTaskId);
 r.lastCheckedAt=new Date().toISOString();r.lastImageStatus=imageTask?.status;r.lastImageMessage=imageTask?.message;r.imageVersions=imageTask?.outputVersionIds?.map(id=>w.versions.find(v=>v.id===id));save();
 console.log(JSON.stringify({task:task?{id:task.id,status:task.status,message:task.message,cost:task.cost,outputs:task.outputVersionIds}:null,preservedFiles:r.preservedFiles?.length,body:mode==='inspect'?(await page.locator('body').innerText()).slice(0,2500):undefined},null,2));
}finally{await browser.close();}

